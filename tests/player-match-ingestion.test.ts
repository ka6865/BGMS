import { describe, it, expect, vi } from "vitest";
import { buildPlayerMatchRecordFromParticipant, fetchAndIngestBasicMatchSummary } from "../lib/pubg/playerMatchesIngest";
 
 describe("Player Match Ingestion Helper", () => {
  it("converts participant stats to PlayerMatchRecord format", () => {
     const record = buildPlayerMatchRecordFromParticipant({
       matchId: "match-123",
       nickname: "KangHeeSung",
       platform: "steam",
       createdAt: "2026-08-01T10:00:00Z",
       matchType: "competitive",
       gameMode: "squad-fpp",
       mapName: "Erangel",
       kills: 5,
       damage: 450,
       winPlace: 1,
       knocks: 0,
       survivalTime: 1674.9
     });
     expect(record.player_id).toBe("kangheesung");
     expect(record.match_id).toBe("match-123");
     expect(record.kills).toBe(5);
     expect(record.win_place).toBe(1);
     expect(record.knocks).toBe(0);
     expect(record.survival_time).toBe(1674);
    expect(record.match_type).toBe("competitive");
  });

  it("keeps an explicit unknown mode when the source does not provide matchType", () => {
    const record = buildPlayerMatchRecordFromParticipant({
      matchId: "match-without-mode",
      nickname: "KangHeeSung",
      platform: "steam",
      createdAt: "2026-08-01T10:00:00Z",
      gameMode: "squad-fpp",
      mapName: "Erangel",
      kills: 0,
      damage: 0,
      winPlace: 42,
    });

    expect(record.match_type).toBe("unknown");
  });

  it('stores official knocks and survival from the basic API without telemetry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { id: 'match-basic', attributes: { createdAt: '2026-09-08T00:00:00Z', gameMode: 'duo', mapName: 'Tiger_Main', matchType: 'competitive' } },
      included: [{ type: 'participant', attributes: { stats: { name: 'Player', kills: 0, damageDealt: 25, winPlace: 26, DBNOs: 0, timeSurvived: 724.7 } } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const result = await fetchAndIngestBasicMatchSummary({ from: () => ({ upsert }) } as never, 'match-basic', 'Player', 'steam', 'test');
    expect(result).toMatchObject({ knocks: 0, survival_time: 724 });
    expect(upsert).toHaveBeenCalledWith([expect.objectContaining({ knocks: 0, survival_time: 724 })], expect.anything());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("does not report a PUBG match as ingested when the database upsert fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        id: "match-db-failure",
        attributes: {
          createdAt: "2026-08-01T10:00:00Z",
          gameMode: "squad-fpp",
          mapName: "Erangel",
          matchType: "competitive",
        },
      },
      included: [{
        type: "participant",
        attributes: { stats: { name: "KangHeeSung", kills: 2, damageDealt: 150, winPlace: 12 } },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const supabase = {
      from: vi.fn(() => ({
        upsert: vi.fn().mockResolvedValue({ error: new Error("database unavailable") }),
      })),
    } as never;

    const record = await fetchAndIngestBasicMatchSummary(
      supabase,
      "match-db-failure",
      "KangHeeSung",
      "steam",
      "api-key",
    );

    expect(record).toBeNull();
  });
});

describe('account-based discovery ingestion', () => {
  it('closes an unsuccessful response body before returning its retry status', async () => {
    const { fetchAndIngestBasicMatchSummaryOutcome } = await import('../lib/pubg/playerMatchesIngest');
    const cancel = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 503 }));
    const outcome = await fetchAndIngestBasicMatchSummaryOutcome({} as never, 'failed-match', 'Player', 'steam', '', { fetchImpl });
    expect(outcome).toMatchObject({ status: 'upstream_error', httpStatus: 503 });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('cancels the upstream fetch when the requesting page is cancelled', async () => {
    const { fetchAndIngestBasicMatchSummaryOutcome } = await import('../lib/pubg/playerMatchesIngest');
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      upstreamSignal = init.signal;
      upstreamSignal?.addEventListener('abort', () => reject(upstreamSignal?.reason), { once: true });
    }));
    const outcome = fetchAndIngestBasicMatchSummaryOutcome({} as never, 'cancelled-match', 'Player', 'steam', '', {
      fetchImpl, signal: controller.signal,
    });
    controller.abort();
    expect((await outcome).status).toBe('network_error');
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it('uses the stable account after nickname change and rejects name-only matches', async () => {
    const { fetchAndIngestBasicMatchSummaryOutcome } = await import('../lib/pubg/playerMatchesIngest');
    const upsert = vi.fn().mockResolvedValue({error:null});
    const payload = {data:{id:'match-id',attributes:{createdAt:'2026-09-11T00:00:00Z',gameMode:'squad-fpp',mapName:'Baltic_Main'}},included:[
      {type:'participant',attributes:{stats:{name:'OldName',playerId:'account.other',kills:99}}},
      {type:'participant',attributes:{stats:{name:'NewName',playerId:'account.target',kills:1,damageDealt:0,winPlace:3}}},
    ]};
    const fetchImpl=vi.fn().mockImplementation(async()=>new Response(JSON.stringify(payload)));
    const db={from:()=>({upsert})} as never;
    const result=await fetchAndIngestBasicMatchSummaryOutcome(db,'match-id','OldName','steam','',{expectedAccountId:'account.target',fetchImpl});
    expect(result.record).toMatchObject({player_id:'newname',kills:1});
    upsert.mockClear();
    const mismatch=await fetchAndIngestBasicMatchSummaryOutcome(db,'match-id','OldName','steam','',{expectedAccountId:'account.missing',fetchImpl});
    expect(mismatch.status).toBe('upstream_error');expect(upsert).not.toHaveBeenCalled();
    payload.data.id='other-match';
    expect((await fetchAndIngestBasicMatchSummaryOutcome(db,'match-id','OldName','steam','',{expectedAccountId:'account.target',fetchImpl})).status).toBe('upstream_error');
    expect(upsert).not.toHaveBeenCalled();
  });
  it.each([undefined, 'other-match'])('rejects an absent or mismatched embedded match ID (%s)', async responseId => {
    const { fetchAndIngestBasicMatchSummaryOutcome } = await import('../lib/pubg/playerMatchesIngest');
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({data: {
      ...(responseId ? {id: responseId} : {}),
      attributes: {createdAt: '2026-10-01T00:00:00Z', gameMode: 'duo', mapName: 'Tiger_Main'},
    }, included: [{type: 'participant', attributes: {stats: {name: 'A', kills: 0, damageDealt: 0, winPlace: 42}}}]})));
    const upsert = vi.fn();
    const result = await fetchAndIngestBasicMatchSummaryOutcome({from: () => ({upsert})} as never, 'requested-match', 'A', 'steam', '', {fetchImpl});
    expect(result).toMatchObject({status: 'upstream_error', error: 'match-identity-invalid'});
    expect(upsert).not.toHaveBeenCalled();
  });
  it.each(['createdAt', 'gameMode', 'mapName', 'kills', 'damageDealt', 'winPlace'])('does not persist fabricated defaults for missing %s', async key => {
    const { fetchAndIngestBasicMatchSummaryOutcome } = await import('../lib/pubg/playerMatchesIngest');
    const attributes: Record<string, unknown> = {createdAt: '2026-10-01T00:00:00Z', gameMode: 'duo', mapName: 'Tiger_Main'};
    const stats: Record<string, unknown> = {name: 'A', playerId: 'account.a', kills: 0, damageDealt: 0, winPlace: 42};
    delete attributes[key]; delete stats[key];
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({data: {id: 'm', attributes}, included: [{type: 'participant', attributes: {stats}}]})));
    const upsert = vi.fn();
    const result = await fetchAndIngestBasicMatchSummaryOutcome({from: () => ({upsert})} as never, 'm', 'A', 'steam', '', {expectedAccountId: 'account.a', fetchImpl});
    expect(result.status).toBe('upstream_error');
    expect(result.record).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });
  it.each([
    ['tutorialatoz', 'solo', 0, 'unsupported_match'],
    ['arcade', 'tdm', 0, 'unsupported_match'],
    ['official', 'squad', 0, 'upstream_error'],
    ['arcade', 'tdm', 2, 'saved'],
    ['official', 'squad', 1, 'saved'],
  ] as const)('classifies observed placement for %s / %s / %s', async (matchType, gameMode, winPlace, status) => {
    const { fetchAndIngestBasicMatchSummaryOutcome } = await import('../lib/pubg/playerMatchesIngest');
    const upsert = vi.fn().mockResolvedValue({error: null});
    const payload = {data: {id: 'm', attributes: {createdAt: '2026-10-01T00:00:00Z', gameMode, matchType, mapName: 'Range_Main'}},
      included: [{type: 'participant', attributes: {stats: {name: 'A', playerId: 'account.a', kills: 0, damageDealt: 0, winPlace}}}]};
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload)));
    const outcome = await fetchAndIngestBasicMatchSummaryOutcome({from: () => ({upsert})} as never, 'm', 'A', 'steam', '', {expectedAccountId: 'account.a', fetchImpl});
    expect(outcome.status).toBe(status);
    expect(upsert).toHaveBeenCalledTimes(status === 'saved' ? 1 : 0);
  });
  it.each(['createdAt', 'gameMode', 'mapName', 'kills', 'damageDealt', 'winPlace'])('keeps an incomplete zero-placement TDM retryable when %s is missing', async key => {
    const {fetchAndIngestBasicMatchSummaryOutcome} = await import('../lib/pubg/playerMatchesIngest');
    const attributes: Record<string, unknown> = {createdAt: '2026-10-01T00:00:00Z', gameMode: 'tdm', mapName: 'Kiki_Main', matchType: 'arcade'};
    const stats: Record<string, unknown> = {name: 'A', playerId: 'account.a', kills: 0, damageDealt: 0, winPlace: 0};
    delete attributes[key]; delete stats[key];
    const upsert = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({data: {id: 'm', attributes}, included: [{type: 'participant', attributes: {stats}}]})));
    expect(await fetchAndIngestBasicMatchSummaryOutcome({from: () => ({upsert})} as never, 'm', 'A', 'steam', '', {expectedAccountId: 'account.a', fetchImpl}))
      .toMatchObject({status: 'upstream_error', error: 'match-basic-values-missing'});
    expect(upsert).not.toHaveBeenCalled();
  });
});
