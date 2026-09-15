import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoveryClient, claimDiscoveredMatches, settleDiscoveredMatch, recordDiscoveredMatches } from '../lib/pubg/matchDiscovery.server';
import { runDiscoveryWorker } from '../lib/pubg/discoveryWorker';
import { fetchAndIngestBasicMatchSummaryOutcome, type PubgFetchImpl } from '../lib/pubg/playerMatchesIngest';

export type DiscoveryWorkerArgs = {
  apply: boolean;
  seedCache: boolean;
  nickname?: string;
  limit: number;
};

export function parseDiscoveryWorkerArgs(args: string[]): DiscoveryWorkerArgs {
  const limitIndex=args.indexOf('--limit');
  const rawLimit=limitIndex>=0 ? args[limitIndex+1] : undefined;
  if(limitIndex>=0 && (!rawLimit || !/^\d+$/.test(rawLimit))) throw new Error('discovery-worker-invalid-limit');
  const limit=rawLimit === undefined ? 300 : Number(rawLimit);
  if(!Number.isInteger(limit) || limit<1 || limit>300) throw new Error('discovery-worker-invalid-limit');
  const nicknameIndex=args.indexOf('--nickname');
  return {
    apply:args.includes('--apply'),
    seedCache:args.includes('--seed-cache'),
    nickname:nicknameIndex>=0 ? args[nicknameIndex+1] : undefined,
    limit,
  };
}

export async function main(args=process.argv.slice(2)) {
  dotenv.config({path:'.env.local',quiet:true});
  const options=parseDiscoveryWorkerArgs(args);
  const db=discoveryClient();
  const {apply,nickname}=options;
  if(options.seedCache) {
    if(apply&&!nickname)throw new Error('seed-cache-apply-requires-nickname');
    let offset=0, discovered=0;
    for(;;) {
      let query=db.from('pubg_player_cache').select('id,nickname,platform,recent_match_ids').order('id').range(offset,offset+249);
      if(nickname) query=query.eq('lower_nickname',nickname.toLowerCase());
      const {data,error}=await query;
      if(error) throw new Error('seed-cache-read-failed');
      for(const row of data ?? []) {
        if(!/^account\.[A-Za-z0-9_-]+$/.test(row.id ?? '') || !['steam','kakao'].includes(row.platform)) continue;
        if(apply) await recordDiscoveredMatches({accountId:row.id,nickname:row.nickname,platform:row.platform,matchIds:row.recent_match_ids ?? []},db);
        discovered++;
      }
      if(!data || data.length<250) break;
      offset+=250;
    }
    return {mode:apply?'seed':'dry-run-seed',players:discovered};
  }
  if(!apply) {
    const now=new Date().toISOString();
    const [pendingResult,readyResult]=await Promise.all([
      db.from('pubg_player_match_discovery').select('match_id',{count:'exact',head:true}).in('state',['pending','retry','running']),
      db.from('pubg_player_match_discovery').select('next_attempt_at').in('state',['pending','retry']).lte('next_attempt_at',now).order('next_attempt_at',{ascending:true}).limit(1),
    ]);
    if(pendingResult.error || readyResult.error) throw new Error('discovery-read-failed');
    return {mode:'dry-run',pending:pendingResult.count,oldestReadyAt:readyResult.data?.[0]?.next_attempt_at ?? null};
  }
  const key=(process.env.PUBG_API_KEY ?? '').split(' ')[0];
  // /matches doesn't consume the player quota; Authorization is optional.
  // Reuse a response within one claimed batch, cloning its body for each account.
  let responses=new Map<string,Promise<Response>>();
  const fetchImpl:PubgFetchImpl=(input,init)=>{
    const url=String(input);
    let pending=responses.get(url);
    if(!pending) {pending=fetch(input,init);responses.set(url,pending);}
    return pending.then(response=>response.clone());
  };
  return runDiscoveryWorker({
    limit:options.limit,
    claim:async limit=>{responses=new Map();return claimDiscoveredMatches(db,limit);},
    settle:(job,outcome)=>settleDiscoveredMatch(db,job,outcome),
    alreadyStored:async job=>{
      const {data,error}=await db.from('pubg_player_matches').select('match_id')
        .eq('platform',job.platform).eq('account_id',job.account_id).eq('match_id',job.match_id).limit(1);
      if(error) throw new Error('discovery-existing-match-read-failed');
      return Boolean(data?.length);
    },
    ingest:job=>fetchAndIngestBasicMatchSummaryOutcome(db,job.match_id,job.nickname_at_discovery,job.platform,key,{expectedAccountId:job.account_id,timeoutMs:8000,fetchImpl}),
  });
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('Match discovery worker failed; unacknowledged jobs remain retryable.');process.exitCode=1;});
}
