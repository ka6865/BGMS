import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDiscoveryWorker } from '@/lib/pubg/discoveryWorker';
import { assertDiscoveryWorkerApiKey, main, parseDiscoveryWorkerArgs, isDiscoveredMatchStored } from '@/scripts/ingest_discovered_matches';
import * as discoveryServer from '@/lib/pubg/matchDiscovery.server';
import { collectDiscoveredMatches } from '@/lib/pubg/discoveryBatch.server';
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
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
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
  it.each([
    ['2026-08-28T00:00:00Z', 'not_found', 'unavailable', 'discovery_window_elapsed'],
    ['2026-08-28T00:00:00.001Z', 'not_found', 'retry', 'not_found'],
    ['invalid', 'not_found', 'retry', 'not_found'],
    ['2026-09-12T00:00:00Z', 'not_found', 'retry', 'not_found'],
    ['2026-08-01T00:00:00Z', 'saved', 'saved', undefined],
    ['2026-08-01T00:00:00Z', 'upstream_error', 'retry', 'upstream_error'],
    ['2026-09-10T00:00:00Z', 'unsupported_match', 'unavailable', 'match-placement-unavailable'],
  ] as const)('settles %s / %s without discarding obtainable matches', async (first_seen_at, status, state, errorCode) => {
    const d = setup(result(status, {httpStatus: status === 'not_found' ? 404 : 200}));
    const target = { ...job, first_seen_at };
    d.claim.mockReset().mockResolvedValueOnce([target]).mockResolvedValue([]);
    await runDiscoveryWorker(d);
    expect(d.ingest).toHaveBeenCalledWith(target);
    expect(d.settle).toHaveBeenCalledWith(target, expect.objectContaining({state, ...(errorCode ? {errorCode} : {})}));
  });
  it('does not label a missing participant in a successful response as expiration', async () => {
    const d = setup(result('not_found', {httpStatus: 200}));
    const target = {...job, first_seen_at: '2026-08-01T00:00:00Z'};
    d.claim.mockReset().mockResolvedValueOnce([target]).mockResolvedValue([]);
    await runDiscoveryWorker(d);
    expect(d.settle).toHaveBeenCalledWith(target, expect.objectContaining({state: 'retry', errorCode: 'not_found'}));
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
  it.each(['0','1001','1.5','nope',undefined])('rejects an invalid CLI limit: %s',(value)=>{
    expect(()=>parseDiscoveryWorkerArgs(['--apply','--limit',...(value ? [value] : [])])).toThrow('discovery-worker-invalid-limit');
  });
  it('parses a valid canary limit',()=>{
    expect(parseDiscoveryWorkerArgs(['--apply','--limit','3'])).toMatchObject({apply:true,limit:3});
  });
  it('rejects a missing API key before claiming or modifying collection jobs',async()=>{
    vi.stubEnv('PUBG_API_KEY', '');
    const client = vi.spyOn(discoveryServer,'discoveryClient');
    await expect(main(['--apply'])).rejects.toThrow('discovery-worker-api-key-missing');
    expect(client).not.toHaveBeenCalled();
    expect(() => assertDiscoveryWorkerApiKey(parseDiscoveryWorkerArgs([]), '')).not.toThrow();
    expect(() => assertDiscoveryWorkerApiKey(parseDiscoveryWorkerArgs(['--apply','--seed-cache','--nickname','Tester']), '')).not.toThrow();
  });
  it.each(['500','1000'])('accepts a larger bounded CLI run: %s',(limit)=>{
    expect(parseDiscoveryWorkerArgs(['--apply','--limit',limit]).limit).toBe(Number(limit));
  });
  it('rejects a missing scoped collector key before claiming database jobs', async () => {
    vi.stubEnv('PUBG_API_KEY', '');
    const rpc = vi.fn();
    await expect(collectDiscoveredMatches({rpc} as never, {platform: 'steam', accountId: 'account.a'}))
      .rejects.toThrow('discovery-worker-api-key-missing');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('processes 1000 jobs in batches of at most three',async()=>{
    const d=setup(result('saved'));
    let claimed=0;
    d.claim.mockReset().mockImplementation(async(limit:number)=>Array.from({length:limit},()=>({...job,match_id:`m-${claimed++}`})));
    const summary=await runDiscoveryWorker({...d,limit:1000});
    expect(summary).toMatchObject({claimed:1000,saved:1000});
    expect(d.claim).toHaveBeenCalledTimes(334);
    expect(d.claim).toHaveBeenLastCalledWith(1);
    expect(d.claim.mock.calls.every(([limit])=>limit<=3)).toBe(true);
  });
  it('keeps the time budget when the requested run is larger',async()=>{
    const d=setup(result('saved'));
    let elapsed=0;
    d.claim.mockReset().mockImplementation(async()=>{elapsed+=1000;return [job,{...job,match_id:'m2'},{...job,match_id:'m3'}];});
    const summary=await runDiscoveryWorker({...d,limit:1000,now:()=>elapsed,maxDurationMs:1500});
    expect(summary.claimed).toBe(6);
    expect(d.claim).toHaveBeenCalledTimes(2);
  });
  it('settles an already stored account match without calling PUBG',async()=>{
    const d=setup(result('saved'));
    const alreadyStored=vi.fn().mockResolvedValue(true);
    const summary=await runDiscoveryWorker({...d,alreadyStored});
    expect(alreadyStored).toHaveBeenCalledWith(job);
    expect(d.ingest).not.toHaveBeenCalled();
    expect(d.settle).toHaveBeenCalledWith(job,{state:'saved'});
    expect(summary.saved).toBe(1);
    expect(summary.alreadyStored).toBe(1);
  });
  it('one account timeout does not cancel another account collecting the same match', async () => {
    const jobs = [job, { ...job, account_id: 'account.b', nickname_at_discovery: 'B' }];
    const rpc = vi.fn().mockImplementation(async (name) => ({
      data: name === 'claim_pubg_match_discovery' ? jobs.splice(0) : true, error: null,
    }));
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const query = { select: () => query, eq: () => query, or: async () => ({ data: [], error: null }), limit: async () => ({ data: [], error: null }), upsert };
    vi.spyOn(discoveryServer, 'discoveryClient').mockReturnValue({ from: () => query, rpc } as never);
    vi.stubEnv('PUBG_API_KEY', 'fixture');
    const timedOut = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(timedOut.signal).mockReturnValue(new AbortController().signal);
    const payload = { data: { id: 'm', attributes: { createdAt: '2026-10-03T00:00:00Z', gameMode: 'squad-fpp', mapName: 'Tiger_Main', matchType: 'official' } }, included: [{ type: 'participant', attributes: { stats: { name: 'B', playerId: 'account.b', kills: 1, damageDealt: 50, winPlace: 2 } } }] };
    const fetchMock = vi.fn((_input, init) => {
      if (fetchMock.mock.calls.length > 1) return Promise.resolve(new Response(JSON.stringify(payload)));
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
        setTimeout(() => timedOut.abort(new DOMException('timeout', 'TimeoutError')), 0);
      } })));
    });
    vi.stubGlobal('fetch', fetchMock);
    const summary = await main(['--apply', '--limit', '2']);
    expect(summary).toMatchObject({ saved: 1, retry: 1 });
    expect(upsert).toHaveBeenCalledWith([expect.objectContaining({ account_id: 'account.b' })], expect.anything());
  });
  it('requires a full account scope instead of implying that nickname restricts claims', () => {
    expect(parseDiscoveryWorkerArgs(['--apply', '--platform', 'steam', '--account-id', 'account.a', '--limit', '3']))
      .toMatchObject({apply: true, scope: {platform: 'steam', accountId: 'account.a'}});
    expect(() => parseDiscoveryWorkerArgs(['--apply', '--nickname', 'A'])).toThrow('discovery-worker-nickname-is-seed-only');
    expect(() => parseDiscoveryWorkerArgs(['--apply', '--platform', 'steam'])).toThrow('discovery-worker-invalid-scope');
    expect(() => parseDiscoveryWorkerArgs(['--apply', '--account-id', 'account.a'])).toThrow('discovery-worker-invalid-scope');
  });
  it('does not bind or acknowledge a legacy nickname row before official account validation', async () => {
    const query = {select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), limit: vi.fn()};
    const update = vi.fn();
    const db = {from: vi.fn(() => ({...query, update}))};
    const row = {player_id: 'a', account_id: null, match_id: 'm', played_at: '2026-10-01T00:00:00Z',
      game_mode: 'duo', map_name: 'Tiger_Main', kills: 0, damage: 0, win_place: 12};
    query.limit.mockResolvedValue({data: [row], error: null});
    expect(await isDiscoveredMatchStored(db as never, job)).toBe(false);
    expect(update).not.toHaveBeenCalled();
    const d = setup(result('not_found'));
    await runDiscoveryWorker({...d, alreadyStored: () => isDiscoveredMatchStored(db as never, job)});
    expect(d.ingest).toHaveBeenCalledWith(job);
    expect(d.settle).toHaveBeenCalledWith(job, expect.objectContaining({state: 'retry'}));
    query.limit.mockResolvedValue({data: [{...row, account_id: 'account.a'}], error: null});
    expect(await isDiscoveredMatchStored(db as never, job)).toBe(true);
  });
});
