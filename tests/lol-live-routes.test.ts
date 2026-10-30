import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestJson: vi.fn(),
  catalog: vi.fn(),
  champions: vi.fn(),
  stats: vi.fn(),
  requireAdmin: vi.fn(),
  notFound: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => { mocks.notFound(); throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); },
  redirect: (path: string) => { throw new Error(`redirect:${path}`); },
}));
vi.mock("@/lib/lol/dataDragon.server", () => ({ getLolDataDragonVersion: async () => "16.21.1" }));
vi.mock("@/lib/lol/ops.server", () => ({ recordLolOpsMetric: vi.fn() }));
vi.mock("@/lib/lol/champions.server", () => ({ getLolChampions: mocks.champions }));
vi.mock("@/lib/lol/championStats.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/lol/championStats.server")>();
  return { ...actual, getLolChampionStats: mocks.stats };
});
vi.mock("@/lib/lol/riotSearch.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/lol/riotSearch.server")>();
  return { ...actual, requestJson: mocks.requestJson, getLolBuildCatalog: mocks.catalog };
});
vi.mock("@/lib/lol/access.server", () => ({ requireLolDevAdmin: mocks.requireAdmin }));

import { RiotSearchError } from "../lib/lol/riotSearch.server";
import { POST as publicPost } from "../app/api/lol/live/route";
import { POST as adminPost } from "../app/api/admin/lol/live/route";

const ORIGIN = "http://localhost:3000";
let ipCounter = 10;
let nameCounter = 0;
// 프로세스 캐시가 테스트 사이에 새지 않도록 테스트마다 PUUID 묶음을 바꾼다.
let puuidRun = 0;

const puuid = (n: number) => `test-puuid-${puuidRun}-${n}-abcdefghijklmnop`;
const bgmsRiotId = () => `테스트${++nameCounter}#KR1`;

function request(body: unknown, { path = "/api/lol/live", ip = `198.51.100.${++ipCounter}` } = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { host: "localhost:3000", origin: ORIGIN, "x-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const participant = (n: number, extra: Record<string, unknown> = {}) => ({
  championId: 100 + n, teamId: n < 5 ? 100 : 200, spell1Id: 4, spell2Id: 14,
  perks: { perkIds: [8005, 9111, 9104, 8014, 8345, 8347, 5008, 5002], perkStyle: 8000, perkSubStyle: 8100 },
  puuid: puuid(n), riotId: `플레이어${n}#KR${n}`, bot: false, ...extra,
});
const game = (over: Record<string, unknown> = {}, participants = Array.from({ length: 10 }, (_, n) => participant(n))) => ({
  gameId: 7001, gameType: "MATCHED_GAME", gameQueueConfigId: 420, gameLength: 312, mapId: 11,
  bannedChampions: [{ championId: 9, teamId: 100, pickTurn: 1 }], participants, ...over,
});

const soloEntry = { queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank: "II", leaguePoints: 45, wins: 30, losses: 25 };

// requestJson을 경로별로 흉내 낸다. 호출 기록으로 호출 수와 대상 puuid를 검증한다.
function riot(options: {
  account?: () => unknown;
  spectator?: () => unknown;
  entries?: (puuidValue: string) => unknown;
}) {
  const calls: string[] = [];
  mocks.requestJson.mockImplementation(async (_host: string, path: string) => {
    calls.push(path);
    if (path.startsWith("/riot/account/v1/accounts/by-riot-id/")) {
      if (options.account) return options.account();
      const [, , , , , name, tag] = path.split("/");
      return { puuid: `test-acct-${puuidRun}-abcdefghijklmnop`, gameName: decodeURIComponent(name), tagLine: decodeURIComponent(tag) };
    }
    if (path.startsWith("/lol/spectator/v5/")) {
      if (options.spectator) return options.spectator();
      return game();
    }
    if (path.startsWith("/lol/league/v4/entries/by-puuid/")) {
      const target = decodeURIComponent(path.split("/").pop()!);
      return options.entries ? options.entries(target) : [soloEntry];
    }
    throw new Error(`unexpected path ${path}`);
  });
  return calls;
}

const spectatorCalls = (calls: string[]) => calls.filter(path => path.startsWith("/lol/spectator/"));
const entryCalls = (calls: string[]) => calls.filter(path => path.startsWith("/lol/league/"));
const notFoundSpectator = () => { throw new RiotSearchError("not_found", undefined, { endpoint: "spectator", stage: "http", reasonCode: "http_404", status: 404 }); };

beforeEach(() => {
  vi.resetAllMocks();
  puuidRun += 1;
  vi.stubEnv("RIOT_API_KEY", "test-key-never-real");
  vi.stubEnv("LOL_PUBLIC_ENABLED", "true");
  vi.stubEnv("LOL_LIVE_ENABLED", "true");
  vi.stubEnv("LOL_PERSISTENCE_ENABLED", "false");
  mocks.catalog.mockResolvedValue({
    version: "16.21.1",
    items: {},
    spells: { "4": { name: "점멸", image: "SummonerFlash.png" }, "14": { name: "점화", image: "SummonerDot.png" } },
    runes: { "8000": { name: "정밀", icon: "perk-images/Styles/Precision.png" }, "8005": { name: "정복자", icon: "perk-images/Styles/Conqueror.png" } },
  });
  mocks.champions.mockResolvedValue({ version: "16.21.1", champions: [{ id: 100, imageId: "Ahri", name: "아리", title: "", tags: [] }] });
  mocks.stats.mockResolvedValue({
    patch: "16.21", matches: 1000,
    rows: [{ team_position: "TOP", champion_id: 100, games: 25, wins: 15, bans: 40, matches: 1000 },
      { team_position: "MIDDLE", champion_id: 101, games: 5, wins: 3, bans: 2, matches: 1000 }],
  });
  mocks.requireAdmin.mockResolvedValue({ ok: true });
});

describe("진행 중 경기 공개 경로 경계", () => {
  it("LOL_LIVE_ENABLED가 꺼져 있으면 404이고 Riot과 호출 제한 모두 건드리지 않는다", async () => {
    vi.stubEnv("LOL_LIVE_ENABLED", "");
    const calls = riot({});
    const response = await publicPost(request({ riotId: bgmsRiotId() }));
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("플래그가 켜져 있어도 같은 출처가 아니면 403이다", async () => {
    riot({});
    const req = new Request(`${ORIGIN}/api/lol/live`, { method: "POST", headers: { host: "localhost:3000", origin: "http://evil.example", "x-forwarded-for": "198.51.100.200", "content-type": "application/json" }, body: JSON.stringify({ riotId: bgmsRiotId() }) });
    expect((await publicPost(req)).status).toBe(403);
  });

  it("게임 중이 아니면 not_in_game을 돌려주고 참가자 조회를 하지 않는다", async () => {
    const riotId = bgmsRiotId();
    const calls = riot({ spectator: notFoundSpectator });
    const response = await publicPost(request({ riotId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "not_in_game" });
    expect(spectatorCalls(calls)).toHaveLength(1);
    expect(entryCalls(calls)).toEqual([]);
  });

  it("커스텀 게임은 참가자와 밴을 노출하지 않고 추가 호출도 하지 않는다", async () => {
    const calls = riot({ spectator: () => game({ gameType: "CUSTOM_GAME", gameQueueConfigId: 0 }) });
    const response = await publicPost(request({ riotId: bgmsRiotId() }));
    const body = await response.json();
    expect(body.status).toBe("unsupported_mode");
    expect(body).not.toHaveProperty("participants");
    expect(body).not.toHaveProperty("bans");
    expect(entryCalls(calls)).toEqual([]);
    expect(mocks.stats).not.toHaveBeenCalled();
  });

  it("익명과 봇 참가자에게는 랭크 호출을 하지 않고, 공개 참가자만 entries를 한 번씩 부른다", async () => {
    const participants = Array.from({ length: 10 }, (_, n) => participant(n));
    participants[1] = participant(1, { puuid: null });
    participants[2] = participant(2, { riotId: undefined });
    participants[3] = participant(3, { bot: true, puuid: null });
    participants[4] = participant(4, { puuid: "짧음" });
    const calls = riot({ spectator: () => game({}, participants) });
    const response = await publicPost(request({ riotId: bgmsRiotId() }));
    const body = await response.json();
    expect(response.status).toBe(200);
    // 공개 참가자는 여섯 명이다(익명 3, 봇 1 제외).
    expect(entryCalls(calls)).toHaveLength(6);
    expect(new Set(entryCalls(calls)).size).toBe(6);
    expect(body.participants.filter((item: any) => item.identity.status === "private")).toHaveLength(3);
    expect(body.participants.filter((item: any) => item.identity.status === "bot")).toHaveLength(1);
    expect(body.participants[1].rank).toEqual({ status: "hidden" });
  });

  it("응답에는 참가자 puuid 원문이 없다", async () => {
    riot({});
    const response = await publicPost(request({ riotId: bgmsRiotId() }));
    const text = await response.text();
    expect(text).not.toContain("test-puuid-");
    expect(text).toContain("플레이어1#KR1");
  });

  it("일부 참가자 랭크 요청이 429면 그 칸만 실패로 두고 전체는 200이다", async () => {
    riot({
      entries: target => {
        if (target === puuid(3)) throw new RiotSearchError("rate_limited", 7, { endpoint: "league", stage: "http", reasonCode: "http_429", status: 429 });
        return [soloEntry];
      },
    });
    const response = await publicPost(request({ riotId: bgmsRiotId() }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.rankFailureCount).toBe(1);
    expect(body.participants[3].rank).toEqual({ status: "failed", reason: "rate_limited" });
    expect(body.participants[0].rank).toMatchObject({ status: "ranked", tier: "GOLD", leaguePoints: 45 });
  });

  it("랭크 키 만료는 해당 칸에 키 갱신 사유로 나뉘고 전체 응답은 유지된다", async () => {
    riot({
      entries: target => {
        if (target === puuid(5)) throw new RiotSearchError("key_or_permission", undefined, { endpoint: "league", stage: "http", reasonCode: "http_403", status: 403 });
        return [soloEntry];
      },
    });
    const response = await publicPost(request({ riotId: bgmsRiotId() }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.participants[5].rank).toEqual({ status: "failed", reason: "key_or_permission" });
  });

  it("관전 조회가 429면 429와 Retry-After를 그대로 돌려준다", async () => {
    riot({ spectator: () => { throw new RiotSearchError("rate_limited", 9); } });
    const response = await publicPost(request({ riotId: bgmsRiotId() }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("9");
  });

  it("관전 조회의 키 만료는 기존 키 갱신 안내(503)로 돌려준다", async () => {
    riot({ spectator: () => { throw new RiotSearchError("key_or_permission"); } });
    const response = await publicPost(request({ riotId: bgmsRiotId() }));
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.reasonCode).toBe("riot_key_renewal");
  });

  it("Riot ID의 계정이 없으면 404이다", async () => {
    riot({ account: () => { throw new RiotSearchError("not_found", undefined, { endpoint: "account", stage: "http", reasonCode: "http_404", status: 404 }); } });
    const response = await publicPost(request({ riotId: bgmsRiotId() }));
    expect(response.status).toBe(404);
  });

  it("같은 Riot ID를 짧은 시간 안에 다시 조회하면 관전 API를 다시 부르지 않는다", async () => {
    const riotId = bgmsRiotId();
    const calls = riot({});
    await publicPost(request({ riotId }));
    const second = await publicPost(request({ riotId }));
    expect(second.status).toBe(200);
    expect(spectatorCalls(calls)).toHaveLength(1);
  });

  it("솔로 랭크가 아닌 큐는 챔피언 통계를 조회하지 않는다", async () => {
    riot({ spectator: () => game({ gameQueueConfigId: 440 }) });
    const body = await (await publicPost(request({ riotId: bgmsRiotId() }))).json();
    expect(mocks.stats).not.toHaveBeenCalled();
    expect(body.championStats.status).toBe("not_applicable");
    expect(body.participants[0].champion).toEqual({ status: "not_applicable" });
  });

  it("솔로 랭크에서는 표본 충분·부족을 기존 20판 규칙으로 나누고 티어 필터를 적용한다", async () => {
    riot({ spectator: () => game({}, [participant(0), participant(1, { championId: 101 }), ...Array.from({ length: 8 }, (_, n) => participant(n + 2, { championId: 300 + n }))]) });
    const body = await (await publicPost(request({ riotId: bgmsRiotId(), tier: "master_plus" }))).json();
    expect(body.championStats).toMatchObject({ status: "ok", patch: "16.21", tierFilter: "master_plus", tierLabel: "마스터+" });
    expect(body.participants[0].champion).toMatchObject({ status: "ok", games: 25, winRate: 15 / 25 });
    expect(body.participants[1].champion).toMatchObject({ status: "small_sample", games: 5 });
    expect(body.participants[2].champion).toEqual({ status: "none" });
  });

  it("챔피언 통계 조회가 실패해도 경기 정보는 유지되고 통계만 불러오지 못함으로 둔다", async () => {
    mocks.stats.mockRejectedValue(new Error("db down"));
    riot({});
    // 통계 캐시를 피하려고 다른 티어를 쓴다.
    const body = await (await publicPost(request({ riotId: bgmsRiotId(), tier: "diamond_plus" }))).json();
    expect(body.status).toBe("ready");
    expect(body.participants[0].champion).toEqual({ status: "unavailable" });
  });

  it("잘못된 Riot ID 형식은 400이다", async () => {
    riot({});
    expect((await publicPost(request({ riotId: "태그없음" }))).status).toBe(400);
    expect(mocks.requestJson).not.toHaveBeenCalled();
  });
});

describe("관리자 확인 경로", () => {
  it("관리자 가드가 거부하면 Riot을 호출하지 않는다", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, error: new Response(null, { status: 403 }) });
    const calls = riot({});
    const response = await adminPost(request({ riotId: bgmsRiotId() }, { path: "/api/admin/lol/live" }));
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("LOL_LIVE_ENABLED가 꺼져 있어도 관리자 가드를 통과하면 조회한다", async () => {
    vi.stubEnv("LOL_LIVE_ENABLED", "");
    riot({});
    const response = await adminPost(request({ riotId: bgmsRiotId() }, { path: "/api/admin/lol/live" }));
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("ready");
  });
});
