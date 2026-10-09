import { describe, expect, it, vi } from 'vitest';
import { fetchRecentMatchIds, readExistingMatchIds } from '@/lib/pubg/syncRunnerBoundaries';
import { runSyncUserMatches } from '../scripts/sync_user_matches';
const candidate={nickname:'Tester',platform:'steam',priority:1 as const,normalizedNickname:'tester',displayNickname:'Tester',lastActiveAt:'2026-09-11T00:00:00Z',lastSuccessAt:null,consecutiveFailures:0};
describe('linked sync full discovery',()=>{
  it('preserves the account and all IDs from the matching player response',async()=>{
    const ids=Array.from({length:130},(_,i)=>`m-${i}`);
    const result=await fetchRecentMatchIds(candidate,'key',async()=>new Response(JSON.stringify({data:[{id:'account.tester',attributes:{name:'Tester'},relationships:{matches:{data:ids.map(id=>({id}))}}}]})),1000);
    expect(result).toMatchObject({status:200,accountId:'account.tester',nickname:'Tester',matchIds:ids});
  });
  it('does not accept a successful response for a different player',async()=>{
    const result=await fetchRecentMatchIds(candidate,'key',async()=>new Response(JSON.stringify({data:[{id:'account.other',attributes:{name:'Other'}}]})),1000);
    expect(result.status).toBe(404);expect(result.matchIds).toEqual([]);
  });
  it('registers all discovered IDs before the ten-match immediate collection window',async()=>{
    const ids=Array.from({length:99},(_,i)=>`m-${i}`);
    const rpc=vi.fn().mockResolvedValue({error:null,data:null});
    const ingest=vi.fn().mockResolvedValue({status:'saved',record:null,httpStatus:200,rateLimitHeaders:null});
    await runSyncUserMatches({dependencies:{supabase:{rpc} as never,apiKey:'key',fetchCandidates:async()=>[candidate],
      claimSyncLease:async()=>true,claimRefreshLock:async()=>true,completeSync:async()=>true,readQuota:async()=>null,
      fetchRecentMatchIds:async()=>({status:200,accountId:'account.tester',nickname:'Tester',matchIds:ids,rateLimitHeaders:null}),
      readExistingMatchIds:async()=>[],ingestMatch:ingest,trackRateLimit:async()=>{},sleep:async()=>{},writeOutput:()=>{},}});
    expect(rpc).toHaveBeenCalledWith('record_pubg_match_discovery',expect.objectContaining({p_match_ids:ids}));
    expect(ingest).toHaveBeenCalledTimes(10);
  });
  it('filters excluded matches for the official account before applying the limit on repeated syncs', async () => {
    const excluded = Array.from({length: 10}, (_, i) => ({platform: 'steam', account_id: 'account.tester', match_id: `excluded-${i}`, state: 'unavailable'}));
    const rows = [...excluded, {platform: 'steam', account_id: 'account.other', match_id: 'normal', state: 'unavailable'}];
    const db = {rpc: vi.fn().mockResolvedValue({error: null}), from: (table: string) => {
      const filters: Array<(row: Record<string, string>) => boolean> = [];
      const query = {
        select: () => query,
        eq: (key: string, value: string) => {filters.push(row => row[key] === value); return query;},
        in: (key: string, values: string[]) => {filters.push(row => values.includes(row[key])); return query;},
        then: (resolve: (value: unknown) => unknown) => resolve({data: table === 'pubg_player_match_discovery' ? rows.filter(row => filters.every(filter => filter(row))) : [], error: null}),
      };
      return query;
    }};
    const ids = [...excluded.map(row => row.match_id), 'normal'];
    const ingest = vi.fn().mockResolvedValue({status: 'saved', record: null, httpStatus: 200, rateLimitHeaders: null});
    for (let run = 0; run < 2; run++) {
      const result = await runSyncUserMatches({dependencies: {supabase: db as never, apiKey: 'key', fetchCandidates: async () => [candidate],
        claimSyncLease: async () => true, claimRefreshLock: async () => true, completeSync: async () => true, readQuota: async () => null,
        fetchRecentMatchIds: async () => ({status: 200, accountId: 'account.tester', nickname: 'Tester', matchIds: ids, rateLimitHeaders: null}),
        readExistingMatchIds, ingestMatch: ingest, trackRateLimit: async () => {}, sleep: async () => {}, writeOutput: () => {}}});
      expect(result).toMatchObject({newMatches: 1, upstreamErrors: 0});
    }
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(ingest.mock.calls.map(call => call[1])).toEqual(['normal', 'normal']);
  });
});
