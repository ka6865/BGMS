import { describe, expect, it } from "vitest";
import {
  RankingValidationError, accountHmac, buildMasterBoard, evaluateRankingPublish, excludeResolved, extractMatchForAccount,
  isMasterEligible, lolMastersPublic, parseRankingLeague, parseSeasonEnd, parseSeasonStart, planAccountUpdate,
  riotIdHmac, selectRankingCandidates, toPublicMasterBoard, toPublicRankingBoard, toRankingRows, MASTER_ROW_LIMIT,
  RANKING_MAX_PAYLOAD_BYTES, type MatchCore, type ResolvedRankingEntry,
} from "@/lib/lol/ranking";

const secret = "x".repeat(40);
const puuid = (n: number) => `puuid-${n}-${"a".repeat(20)}`;
const SEASON = "2026-01-08T00:00:00+09:00";
const seasonStartMs = Date.parse(SEASON);
const league = (tier: "CHALLENGER" | "GRANDMASTER", entries: unknown[]) => ({ queue: "RANKED_SOLO_5x5", tier, entries });
const entry = (n: number, leaguePoints: number) => ({ puuid: puuid(n), leaguePoints, wins: n, losses: 1, inactive: false, rank: "I" });

describe("명단 검증과 후보", () => {
  it("실측 형식의 명단을 티어별 항목으로 바꾼다", () => {
    expect(parseRankingLeague(league("CHALLENGER", [entry(1, 1200)]), "CHALLENGER")).toEqual([
      { puuid: puuid(1), tier: "CHALLENGER", leaguePoints: 1200, wins: 1, losses: 1 },
    ]);
  });

  it.each([
    ["티어 불일치", league("GRANDMASTER", []), "CHALLENGER"],
    ["puuid 없음", league("CHALLENGER", [{ leaguePoints: 1, wins: 1, losses: 1 }]), "CHALLENGER"],
    ["LP 음수", league("CHALLENGER", [{ ...entry(1, 1), leaguePoints: -5 }]), "CHALLENGER"],
  ])("%s이면 실패한다", (_label, raw, tier) => {
    expect(() => parseRankingLeague(raw, tier as "CHALLENGER")).toThrow(RankingValidationError);
  });

  it("챌린저를 먼저 두고 그랜드마스터는 LP가 높은 순서로 채운다", () => {
    const entries = [
      { puuid: puuid(1), tier: "GRANDMASTER" as const, leaguePoints: 900, wins: 0, losses: 0 },
      { puuid: puuid(2), tier: "CHALLENGER" as const, leaguePoints: 100, wins: 0, losses: 0 },
    ];
    expect(selectRankingCandidates(entries).map(item => item.puuid)).toEqual([puuid(2), puuid(1)]);
  });
});

describe("시즌 설정", () => {
  it("시작 시각을 시즌 키로 바꾼다", () => {
    expect(parseSeasonStart(SEASON)).toMatchObject({ key: "2026-01-08", startMs: seasonStartMs });
  });

  it.each([[undefined], [""], ["2026-01-08"], ["어제"]])("시작 시각 %s이면 실패한다", value => {
    expect(() => parseSeasonStart(value)).toThrow(RankingValidationError);
  });

  it("종료 시각은 시작보다 늦어야 한다", () => {
    expect(parseSeasonEnd("2026-04-20T00:00:00+09:00", seasonStartMs).iso).toBe("2026-04-19T15:00:00.000Z");
    expect(() => parseSeasonEnd("2026-01-07T00:00:00+09:00", seasonStartMs)).toThrow(RankingValidationError);
    expect(() => parseSeasonEnd(undefined, seasonStartMs)).toThrow("LOL_SEASON_END");
  });
});

describe("장인 자격과 정렬(D안)", () => {
  it("판수 15 이상, 승률 50% 이상만 자격이 있다", () => {
    expect(isMasterEligible({ games: 14, wins: 14 })).toBe(false);
    expect(isMasterEligible({ games: 15, wins: 8 })).toBe(true);   // 53.3%
    expect(isMasterEligible({ games: 16, wins: 8 })).toBe(true);   // 정확히 50%
    expect(isMasterEligible({ games: 20, wins: 9 })).toBe(false);  // 45%
  });

  it("판수 내림차순, 같으면 티어·LP, 그다음 Riot ID로 정렬하고 자격 없는 계정은 뺀다", () => {
    const players = [
      { gameName: "Zed", tagLine: "KR1", tier: "GRANDMASTER" as const, leaguePoints: 900, champions: new Map([[266, { games: 20, wins: 12 }]]) },
      { gameName: "Alpha", tagLine: "KR2", tier: "CHALLENGER" as const, leaguePoints: 800, champions: new Map([[266, { games: 20, wins: 11 }]]) },
      { gameName: "Beta", tagLine: "KR3", tier: "CHALLENGER" as const, leaguePoints: 1000, champions: new Map([[266, { games: 20, wins: 10 }]]) },
      { gameName: "Low", tagLine: "KR4", tier: "CHALLENGER" as const, leaguePoints: 1, champions: new Map([[266, { games: 40, wins: 10 }]]) },
    ];
    const board = buildMasterBoard(players);
    expect(board).toHaveLength(1);
    expect(board[0].eligible_count).toBe(3);
    expect(board[0].rows.map(row => row.riot_id)).toEqual(["Beta#KR3", "Alpha#KR2", "Zed#KR1"]);
    expect(board[0].rows.map(row => row.rank)).toEqual([1, 2, 3]);
    expect(board[0].rows[0]).toEqual({ rank: 1, riot_id: "Beta#KR3", tier: "CHALLENGER", league_points: 1000, games: 20, wins: 10 });
  });

  it("행은 50명까지만 두고 자격자 수는 전체를 센다", () => {
    const players = Array.from({ length: 60 }, (_, i) => ({ gameName: `P${i}`, tagLine: "KR", tier: "GRANDMASTER" as const, leaguePoints: i,
      champions: new Map([[1, { games: 15 + i, wins: 15 + i }]]) }));
    const [champion] = buildMasterBoard(players);
    expect(champion.eligible_count).toBe(60);
    expect(champion.rows).toHaveLength(MASTER_ROW_LIMIT);
  });

  it("표시 행과 장인 행에는 키나 PUUID가 들어가지 않는다", () => {
    const resolved: ResolvedRankingEntry[] = [{ puuid: puuid(9), tier: "CHALLENGER", leaguePoints: 1, wins: 1, losses: 0, gameName: "A", tagLine: "B" }];
    expect(JSON.stringify(toRankingRows(resolved))).not.toMatch(/puuid|hmac/);
    const boardJson = JSON.stringify(buildMasterBoard([{ gameName: "A", tagLine: "B", tier: "CHALLENGER", leaguePoints: 1,
      champions: new Map([[1, { games: 15, wins: 10 }]]) }]));
    expect(boardJson).not.toMatch(/puuid|hmac/);
  });
});

describe("경기 결과 추출과 커서(멱등)", () => {
  const detail = (matchId: string, opts: { ts?: number; queue?: number; duration?: number; participants: Array<{ puuid: string; championId: number; win: boolean }> }) => ({
    metadata: { matchId },
    info: { gameStartTimestamp: opts.ts ?? seasonStartMs + 3600_000, queueId: opts.queue ?? 420, gameDuration: opts.duration ?? 1800, participants: opts.participants },
  });

  it("큐 420의 5분 이상 경기에서 대상 계정의 챔피언과 승패만 뽑는다", () => {
    const core = extractMatchForAccount(detail("KR_1", { participants: [{ puuid: puuid(1), championId: 266, win: true }, { puuid: puuid(2), championId: 1, win: false }] }), puuid(1), seasonStartMs);
    expect(core).toEqual({ matchId: "KR_1", startMs: seasonStartMs + 3600_000, counted: true, championId: 266, win: true });
    expect(JSON.stringify(core)).not.toContain(puuid(2));
  });

  it("다시하기, 다른 큐, 시즌 이전 경기는 커서만 넘기고 판수에서 뺀다", () => {
    const participants = [{ puuid: puuid(1), championId: 266, win: true }];
    expect(extractMatchForAccount(detail("R", { duration: 200, participants }), puuid(1), seasonStartMs)?.counted).toBe(false);
    expect(extractMatchForAccount(detail("Q", { queue: 450, participants }), puuid(1), seasonStartMs)?.counted).toBe(false);
    expect(extractMatchForAccount(detail("O", { ts: seasonStartMs - 1, participants }), puuid(1), seasonStartMs)?.counted).toBe(false);
  });

  it("참가자가 없으면 세지 않는다", () => {
    expect(extractMatchForAccount(detail("N", { participants: [{ puuid: puuid(2), championId: 1, win: true }] }), puuid(1), seasonStartMs)?.counted).toBe(false);
  });

  it("챔피언이나 승패 값이 잘못되면 실패한다", () => {
    expect(() => extractMatchForAccount(detail("B", { participants: [{ puuid: puuid(1), championId: "266" as never, win: true }] }), puuid(1), seasonStartMs))
      .toThrow(RankingValidationError);
  });

  const match = (id: string, startMs: number, counted = true): MatchCore => ({ matchId: id, startMs, counted, championId: 266, win: true });

  it("처음에는 모든 경기를 세고, 같은 목록을 다시 넣으면 아무것도 늘지 않는다", () => {
    const matches = [match("a", 1000), match("b", 2000), match("c", 3000)];
    const first = planAccountUpdate(null, matches, 100);
    expect(first.deltas.get(266)).toEqual({ games: 3, wins: 3 });
    const again = planAccountUpdate(first.newCursor, matches, 100);
    expect(again.accepted).toHaveLength(0);
    expect(again.deltas.size).toBe(0);
  });

  it("같은 시각의 경기는 커서 id로 한 번만 센다", () => {
    const first = planAccountUpdate(null, [match("a", 5000)], 10);
    const second = planAccountUpdate(first.newCursor, [match("a", 5000), match("b", 5000)], 10);
    expect(second.accepted.map(item => item.matchId)).toEqual(["b"]);
    expect(second.deltas.get(266)?.games).toBe(1);
  });

  it("호출 상한으로 일부만 받으면 빠진 경기는 다음 실행이 이어받는다", () => {
    const all = [match("a", 1000), match("b", 2000), match("c", 3000), match("d", 4000)];
    const part = planAccountUpdate(null, all, 2);
    expect(part.accepted.map(item => item.matchId)).toEqual(["a", "b"]);
    expect(part.remaining).toBe(2);
    const rest = planAccountUpdate(part.newCursor, all, 10);
    expect(rest.accepted.map(item => item.matchId)).toEqual(["c", "d"]);
    expect((part.deltas.get(266)?.games ?? 0) + (rest.deltas.get(266)?.games ?? 0)).toBe(4);
  });

  it("세지 않는 경기도 커서는 넘긴다", () => {
    const plan = planAccountUpdate(null, [match("x", 1000, false)], 10);
    expect(plan.deltas.size).toBe(0);
    expect(plan.newCursor).toEqual({ ms: 1000, ids: ["x"] });
  });
});

describe("키와 제외", () => {
  it("계정 키는 PUUID가 아니라 HMAC이고 같은 입력은 같은 값이다", () => {
    const key = accountHmac(puuid(1), secret);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain(puuid(1));
    expect(accountHmac(puuid(1), secret)).toBe(key);
    expect(() => accountHmac(puuid(1), "short")).toThrow(RankingValidationError);
  });

  it("Riot ID 키는 대소문자와 공백에 무관하다", () => {
    expect(riotIdHmac(" Alpha ", "KR1", secret)).toBe(riotIdHmac("alpha", "kr1", secret));
  });

  it("제외된 Riot ID를 뺀다", () => {
    const list = [{ gameName: "Alpha", tagLine: "KR1" }, { gameName: "Beta", tagLine: "KR2" }];
    const excluded = new Set([riotIdHmac("Beta", "KR2", secret)]);
    expect(excludeResolved(list, secret, excluded)).toEqual({ kept: [list[0]], removed: 1 });
  });
});

describe("게시 조건과 공개 DTO", () => {
  it("해석률이 95% 미만이면 명단 게시를 막는다", () => {
    expect(evaluateRankingPublish({ candidates: 1000, resolved: 960, payloadBytes: 1 }).publish).toBe(true);
    expect(evaluateRankingPublish({ candidates: 1000, resolved: 949, payloadBytes: 1 }).reasons.join(" ")).toContain("Riot ID 해석률");
    expect(evaluateRankingPublish({ candidates: 10, resolved: 10, payloadBytes: RANKING_MAX_PAYLOAD_BYTES + 1 }).publish).toBe(false);
  });

  it("명단 DTO는 키 없이 Riot ID와 공식 값만 남긴다", () => {
    const board = toPublicRankingBoard({ payload: [{ rank: 1, riot_id: "Alpha#KR1", tier: "CHALLENGER", league_points: 1, wins: 2, losses: 3 }],
      playerCount: 1, observedAt: "2026-10-30T20:00:00.000Z" });
    expect(JSON.stringify(board)).not.toMatch(/hmac|puuid/);
    expect(board?.rows[0]).toEqual({ rank: 1, riotId: "Alpha#KR1", tier: "CHALLENGER", leaguePoints: 1, wins: 2, losses: 3 });
  });

  it("장인 DTO는 시즌과 수집 범위를 포함하고 키를 빼며, 형식이 다르면 실패한다", () => {
    const board = toPublicMasterBoard({ observedAt: "2026-10-30T20:00:00.000Z", season: "2026-01-08", coverage: 80, playerCount: 1000,
      champions: [{ championId: 266, eligibleCount: 1, rows: [{ rank: 1, riot_id: "Alpha#KR1", tier: "CHALLENGER", league_points: 5, games: 20, wins: 12, riot_id_hmac: "a".repeat(64) }] }] });
    expect(JSON.stringify(board)).not.toMatch(/hmac|puuid/);
    expect(board?.coverage).toBe(80);
    expect(() => toPublicMasterBoard({ observedAt: "2026-10-30T20:00:00.000Z", season: "2026-01-08", coverage: 80, playerCount: 1, champions: "x" }))
      .toThrow(RankingValidationError);
    expect(toPublicMasterBoard(null)).toBeNull();
  });

  it("장인 메뉴 플래그는 정확히 true일 때만 켜진다", () => {
    expect(lolMastersPublic({ LOL_MASTERS_PUBLIC: "true" })).toBe(true);
    expect(lolMastersPublic({ LOL_MASTERS_PUBLIC: "1" })).toBe(false);
  });
});

describe("장인 게시본 변환", () => {
  it("게시본이 없을 때 RPC가 돌려주는 빈 값은 오류가 아니라 미집계다", () => {
    expect(toPublicMasterBoard({ observedAt: null, season: null, coverage: null, playerCount: null, champions: [] })).toBeNull();
  });
  it("값이 일부만 빠진 게시본은 오류로 처리한다", () => {
    expect(() => toPublicMasterBoard({ observedAt: "2026-10-30T00:00:00Z", season: null, coverage: 1, playerCount: 1, champions: [] })).toThrow();
  });
});
