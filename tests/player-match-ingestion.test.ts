import { afterEach, describe, it, expect, vi } from "vitest";
import { buildPlayerMatchRecordFromParticipant, fetchAndIngestBasicMatchSummary, fetchAndIngestBasicMatchSummaryOutcome } from "../lib/pubg/playerMatchesIngest";

function matchDatabase(upsert = vi.fn().mockResolvedValue({ error: null }), privacy: unknown[] = []) {
  const settingsRead = vi.fn().mockResolvedValue({ data: { value: JSON.stringify(privacy) }, error: null });
  const query = { select: () => query, eq: () => query, maybeSingle: settingsRead };
  const from = vi.fn((table: string) => {
    if (table === "system_settings") return query;
    if (table === "pubg_player_matches") return { upsert };
    throw new Error(`unexpected table: ${table}`);
  });
  return { db: { from } as never, from, upsert, settingsRead };
}

afterEach(() => vi.unstubAllGlobals());

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
    expect(record).not.toHaveProperty("retention_scope");
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
      included: [{ type: 'participant', attributes: { stats: { name: 'Player', playerId: 'account.player', kills: 0, damageDealt: 25, winPlace: 26, DBNOs: 0, timeSurvived: 724.7 } } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const result = await fetchAndIngestBasicMatchSummary(matchDatabase(upsert).db, 'match-basic', 'Player', 'steam', 'test');
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
        attributes: { stats: { name: "KangHeeSung", playerId: "account.kangheesung", kills: 2, damageDealt: 150, winPlace: 12 } },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const supabase = matchDatabase(vi.fn().mockResolvedValue({ error: new Error("database unavailable") })).db;

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

describe("official participant basic histories", () => {
  const participant = (name: string, playerId = `account.${name.toLowerCase()}`, stats: Record<string, unknown> = {}) => ({
    type: "participant", attributes: { stats: { name, playerId, kills: 0, damageDealt: 0, winPlace: 12, ...stats } },
  });
  const payload = (included: unknown[]) => ({ data: { id: "cohort", attributes: {
    createdAt: "2026-10-01T00:00:00Z", gameMode: "squad-fpp", mapName: "Baltic_Main", matchType: "official", shardId: "steam",
  } }, included });
  const fetchPayload = (data: unknown) => vi.fn(async () => new Response(JSON.stringify(data)));
  const collect = (db: never, fetchImpl: ReturnType<typeof fetchPayload>) => fetchAndIngestBasicMatchSummaryOutcome(
    db, "cohort", "Target", "steam", "fixture-key", { expectedAccountId: "account.target", fetchImpl },
  );

  it("uses one official fetch and one privacy read for all human basic rows", async () => {
    const h = matchDatabase();
    const fetchImpl = fetchPayload(payload([participant("Target"), participant("Peer"), participant("Bot", "ai.bot")]));
    expect(await collect(h.db, fetchImpl)).toMatchObject({ status: "saved", record: { account_id: "account.target", retention_scope: "basic_only" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.settingsRead).toHaveBeenCalledTimes(1);
    expect(h.upsert).toHaveBeenCalledWith([
      expect.objectContaining({ account_id: "account.target", retention_scope: "basic_only" }),
      expect.objectContaining({ account_id: "account.peer", retention_scope: "basic_only", kills: 0, damage: 0 }),
    ], expect.anything());
    expect(h.from.mock.calls.map(([table]) => table)).toEqual(["system_settings", "pubg_player_matches"]);
  });

  it("honors stable account aliases, all-platform entries and legacy nicknames without peer cache lookups", async () => {
    const privacy = [
      { platform: "steam", nickname: "OldAlias", lower_nickname: "oldalias", account_id: "account.hidden" },
      { platform: "all", nickname: "OldGlobal", lower_nickname: "oldglobal", account_id: "account.global" },
      { platform: "steam", nickname: "Legacy", lower_nickname: "legacy" },
      { platform: "kakao", nickname: "Elsewhere", lower_nickname: "elsewhere", account_id: "account.elsewhere" },
    ];
    const h = matchDatabase(undefined, privacy);
    const fetchImpl = fetchPayload(payload([participant("Target"), participant("NewAlias", "account.hidden"),
      participant("NewGlobal", "account.global"), participant("Legacy"), participant("OldAlias", "account.public"), participant("Elsewhere")]));
    expect((await collect(h.db, fetchImpl)).status).toBe("saved");
    const rows = h.upsert.mock.calls[0][0];
    expect(rows.map((row: { account_id: string }) => row.account_id)).toEqual(["account.target", "account.public", "account.elsewhere"]);
    expect(h.settingsRead).toHaveBeenCalledTimes(1);
  });

  it.each([
    { data: null, error: { message: "privacy unavailable" } },
    { data: { value: "not-json" }, error: null },
  ])("fails closed when the privacy snapshot cannot be read", async response => {
    const h = matchDatabase();
    h.settingsRead.mockResolvedValue(response as never);
    expect(await collect(h.db, fetchPayload(payload([participant("Target"), participant("Peer")]))))
      .toMatchObject({ status: "upstream_error", error: "player-privacy-check-failed", record: null });
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("skips malformed peers and every ambiguous name/account without hiding the valid target", async () => {
    const h = matchDatabase();
    const included = [participant("Target"), participant("Good"), participant("Missing", "account.missing", { kills: undefined }),
      participant("Duplicate", "account.one"), participant("DUPLICATE", "account.two"),
      participant("AliasOne", "account.same"), participant("AliasTwo", "account.same"), participant("Invalid", "account-legacy")];
    expect((await collect(h.db, fetchPayload(payload(included)))).status).toBe("saved");
    expect(h.upsert.mock.calls[0][0].map((row: { player_id: string }) => row.player_id)).toEqual(["target", "good"]);
  });

  it("skips a malformed peer name when the caller resolves the target by nickname", async () => {
    const h = matchDatabase();
    const fetchImpl = fetchPayload(payload([participant("Target"), participant("Malformed", "account.malformed", { name: 42 })]));
    const outcome = await fetchAndIngestBasicMatchSummaryOutcome(h.db, "cohort", "Target", "steam", "fixture-key", { fetchImpl });
    expect(outcome.status).toBe("saved");
    expect(h.upsert.mock.calls[0][0]).toEqual([expect.objectContaining({ account_id: "account.target" })]);
  });

  it("classifies a null official response as an upstream identity failure", async () => {
    const h = matchDatabase();
    expect(await collect(h.db, fetchPayload(null)))
      .toMatchObject({ status: "upstream_error", httpStatus: 200, error: "match-identity-invalid" });
    expect(h.from).not.toHaveBeenCalled();
  });

  it.each([
    [participant("Peer")],
    [participant("Target", "account.target", { kills: undefined }), participant("Peer")],
    [participant("Target"), participant("Target", "account.other")],
    [participant("Target"), participant("Renamed", "account.target")],
  ])("never saves peers or reports saved when the target is absent, invalid or ambiguous", async (...included) => {
    const h = matchDatabase();
    const outcome = await collect(h.db, fetchPayload(payload(included)));
    expect(outcome.status).toBe("upstream_error");
    expect(outcome.record).toBeNull();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("does not report saved when a grouped participant write fails", async () => {
    const h = matchDatabase();
    h.upsert.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: "peer write failed" } });
    expect(await collect(h.db, fetchPayload(payload([participant("Target"), participant("Peer", "account.peer", { DBNOs: 0 })]))))
      .toMatchObject({ status: "upstream_error", record: null, error: "player-match-upsert-failed" });
    expect(h.upsert).toHaveBeenCalledTimes(2);
  });

  it("blocks an observed response from a different platform before any DB write", async () => {
    const h = matchDatabase();
    const data = payload([participant("Target")]);
    data.data.attributes.shardId = "kakao";
    expect(await collect(h.db, fetchPayload(data))).toMatchObject({ status: "upstream_error", error: "match-identity-invalid" });
    expect(h.from).not.toHaveBeenCalled();
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
    const db=matchDatabase(upsert).db;
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
    }, included: [{type: 'participant', attributes: {stats: {name: 'A', playerId: 'account.a', kills: 0, damageDealt: 0, winPlace: 42}}}]})));
    const upsert = vi.fn();
    const result = await fetchAndIngestBasicMatchSummaryOutcome(matchDatabase(upsert).db, 'requested-match', 'A', 'steam', '', {fetchImpl});
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
    const result = await fetchAndIngestBasicMatchSummaryOutcome(matchDatabase(upsert).db, 'm', 'A', 'steam', '', {expectedAccountId: 'account.a', fetchImpl});
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
    const outcome = await fetchAndIngestBasicMatchSummaryOutcome(matchDatabase(upsert).db, 'm', 'A', 'steam', '', {expectedAccountId: 'account.a', fetchImpl});
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
    expect(await fetchAndIngestBasicMatchSummaryOutcome(matchDatabase(upsert).db, 'm', 'A', 'steam', '', {expectedAccountId: 'account.a', fetchImpl}))
      .toMatchObject({status: 'upstream_error', error: 'match-basic-values-missing'});
    expect(upsert).not.toHaveBeenCalled();
  });
});
