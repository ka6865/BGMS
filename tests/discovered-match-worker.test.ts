import { describe, expect, it, vi } from 'vitest';
import { runDiscoveryWorker } from '@/lib/pubg/discoveryWorker';
import { parseDiscoveryWorkerArgs } from '@/scripts/ingest_discovered_matches';
import type { BasicMatchIngestOutcome } from '@/lib/pubg/playerMatchesIngest';
import type { DiscoveryJob } from '@/lib/pubg/matchDiscovery';
const job: DiscoveryJob = {platform:'steam',account_id:'account.a',nickname_at_discovery:'A',match_id:'m',lease_token:'lease',attempts:1,not_found_count:0};
const result = (status: BasicMatchIngestOutcome["status"], extra = {}) => ({status,record:null,httpStatus:null,rateLimitHeaders:null,...extra});
function setup(outcome: ReturnType<typeof result>) {
  const claim=vi.fn().mockResolvedValueOnce([job]).mockResolvedValue([]);
  const settle=vi.fn().mockResolvedValue(undefined);
  const ingest=vi.fn().mockResolvedValue(outcome);
  return {claim,settle,ingest,now:()=>Date.parse('2026-09-11T00:00:00Z')};
}
describe('durable match collection worker',()=>{
  it('marks saved only after an acknowledged basic write',async()=>{
    const d=setup(result('saved'));
    expect((await runDiscoveryWorker(d)).saved).toBe(1);
    expect(d.settle).toHaveBeenCalledWith(job,expect.objectContaining({state:'saved'}));
  });
  it('keeps failed writes retryable and waits for settlement',async()=>{
    const d=setup(result('upstream_error'));
    await runDiscoveryWorker(d);
    expect(d.settle).toHaveBeenCalledWith(job,expect.objectContaining({state:'retry',nextAttemptAt:'2026-09-11T00:01:00.000Z'}));
    d.claim.mockResolvedValueOnce([job]);d.settle.mockRejectedValueOnce(new Error('lease expired'));
    await expect(runDiscoveryWorker(d)).rejects.toThrow('lease expired');
  });
  it('rechecks a first 404, then keeps a confirmed unavailable marker',async()=>{
    const d=setup(result('not_found'));
    await runDiscoveryWorker(d);
    expect(d.settle).toHaveBeenCalledWith(job,expect.objectContaining({state:'retry',nextAttemptAt:'2026-09-11T06:00:00.000Z',errorCode:'not_found'}));
    d.claim.mockResolvedValueOnce([{...job,not_found_count:1}]);
    await runDiscoveryWorker(d);
    expect(d.settle).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({state:'unavailable'}));
  });
  it('honors 429 reset and stops claiming further jobs',async()=>{
    const d=setup(result('rate_limited',{rateLimitHeaders:{resetAt:'2026-09-11T00:03:00Z',retryAfterMs:120000}}));
    const summary=await runDiscoveryWorker(d);
    expect(summary.rateLimited).toBe(true);expect(d.claim).toHaveBeenCalledTimes(1);
    expect(d.settle).toHaveBeenCalledWith(job,expect.objectContaining({state:'retry',nextAttemptAt:'2026-09-11T00:03:00.000Z'}));
  });
  it('does not treat thrown network failures as successful writes',async()=>{
    const d=setup(result('saved'));d.ingest.mockRejectedValueOnce(new Error('network'));
    expect((await runDiscoveryWorker(d)).saved).toBe(0);
    expect(d.settle).toHaveBeenCalledWith(job,expect.objectContaining({state:'retry',errorCode:'network_error'}));
  });
  it('limits a canary run to the requested number of claimed jobs',async()=>{
    const d=setup(result('saved'));
    d.claim.mockReset().mockResolvedValueOnce([job,{...job,match_id:'m2'},{...job,match_id:'m3'}]).mockResolvedValue([]);
    const summary=await runDiscoveryWorker({...d,limit:3});
    expect(d.claim).toHaveBeenNthCalledWith(1,3);
    expect(summary.claimed).toBe(3);
  });
  it.each(['0','301','1.5','nope',undefined])('rejects an invalid CLI limit: %s',(value)=>{
    expect(()=>parseDiscoveryWorkerArgs(['--apply','--limit',...(value ? [value] : [])])).toThrow('discovery-worker-invalid-limit');
  });
  it('parses a valid canary limit',()=>{
    expect(parseDiscoveryWorkerArgs(['--apply','--limit','3'])).toMatchObject({apply:true,limit:3});
  });
  it('settles an already stored account match without calling PUBG',async()=>{
    const d=setup(result('saved'));
    const alreadyStored=vi.fn().mockResolvedValue(true);
    const summary=await runDiscoveryWorker({...d,alreadyStored});
    expect(alreadyStored).toHaveBeenCalledWith(job);
    expect(d.ingest).not.toHaveBeenCalled();
    expect(d.settle).toHaveBeenCalledWith(job,{state:'saved'});
    expect(summary.saved).toBe(1);
  });
});
