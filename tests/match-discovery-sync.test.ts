import { describe, expect, it, vi } from 'vitest';
import { fetchRecentMatchIds } from '@/lib/pubg/syncRunnerBoundaries';
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
});
