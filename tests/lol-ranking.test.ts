import { describe, expect, it } from "vitest";
import {
  RankingValidationError, buildMasteryBoard, evaluateRankingPublish, excludeRankingRows, parseMasteryTop, parseRankingLeague,
  riotIdHmac, selectRankingCandidates, toRankingRows, lolMastersPublic, RANKING_MAX_PAYLOAD_BYTES,
  type ResolvedRankingEntry,
} from "@/lib/lol/ranking";

const secret = "x".repeat(40);
const puuid = (n: number) => `puuid-${n}-${"a".repeat(20)}`;
const league = (tier: "CHALLENGER" | "GRANDMASTER", entries: unknown[]) => ({ queue: "RANKED_SOLO_5x5", tier, entries });
const entry = (n: number, leaguePoints: number, extra: Record<string, unknown> = {}) => ({
  puuid: puuid(n), leaguePoints, wins: n, losses: 1, rank: "I", freshBlood: false, hotStreak: false, inactive: false, veteran: false, ...extra,
});

describe("랭킹 명단 검증", () => {
  it("실측 형식의 명단을 티어별 항목으로 바꾸고 summonerId 없이도 통과한다", () => {
    const parsed = parseRankingLeague(league("CHALLENGER", [entry(1, 1200), entry(2, 1100, { inactive: true })]), "CHALLENGER");
    expect(parsed).toEqual([
      { puuid: puuid(1), tier: "CHALLENGER", leaguePoints: 1200, wins: 1, losses: 1 },
      { puuid: puuid(2), tier: "CHALLENGER", leaguePoints: 1100, wins: 2, losses: 1 },
    ]);
  });

  it.each([
    ["티어 불일치", league("GRANDMASTER", []), "CHALLENGER"],
    ["큐 불일치", { ...league("CHALLENGER", []), queue: "RANKED_FLEX_SR" }, "CHALLENGER"],
    ["puuid 없음", league("CHALLENGER", [{ leaguePoints: 1, wins: 1, losses: 1 }]), "CHALLENGER"],
    ["puuid 형식 불량", league("CHALLENGER", [{ ...entry(1, 1), puuid: "bad id!" }]), "CHALLENGER"],
    ["wins 없음", league("CHALLENGER", [{ ...entry(1, 1), wins: undefined }]), "CHALLENGER"],
    ["LP 음수", league("CHALLENGER", [entry(1, -5)]), "CHALLENGER"],
    ["entries 아님", { queue: "RANKED_SOLO_5x5", tier: "CHALLENGER", entries: null }, "CHALLENGER"],
  ])("%s이면 실패한다(잘못된 값으로 채우지 않음)", (_label, raw, tier) => {
    expect(() => parseRankingLeague(raw, tier as "CHALLENGER")).toThrow(RankingValidationError);
  });
});

describe("랭킹 정렬과 행 변환", () => {
  it("챌린저를 먼저 두고 LP 내림차순, 같은 LP는 Riot ID 순서로 정렬한다", () => {
    const resolved: ResolvedRankingEntry[] = [
      { puuid: puuid(1), tier: "GRANDMASTER", leaguePoints: 500, wins: 1, losses: 1, gameName: "Zed", tagLine: "KR1" },
      { puuid: puuid(2), tier: "CHALLENGER", leaguePoints: 1000, wins: 1, losses: 1, gameName: "Bravo", tagLine: "KR2" },
      { puuid: puuid(3), tier: "GRANDMASTER", leaguePoints: 500, wins: 1, losses: 1, gameName: "Alpha", tagLine: "KR3" },
    ];
    const rows = toRankingRows(resolved, entry => riotIdHmac(entry.gameName, entry.tagLine, secret));
    expect(rows.map(row => [row.rank, row.riot_id, row.tier])).toEqual([
      [1, "Bravo#KR2", "CHALLENGER"], [2, "Alpha#KR3", "GRANDMASTER"], [3, "Zed#KR1", "GRANDMASTER"],
    ]);
  });

  it("공개 행에 PUUID 필드를 넣지 않는다", () => {
    const rows = toRankingRows([{ puuid: puuid(9), tier: "CHALLENGER", leaguePoints: 1, wins: 1, losses: 0, gameName: "A", tagLine: "B" }],
      entry => riotIdHmac(entry.gameName, entry.tagLine, secret));
    expect(JSON.stringify(rows)).not.toContain(puuid(9));
    expect(Object.keys(rows[0])).not.toContain("puuid");
  });

  it("상위 1000명만 후보로 고른다", () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({ puuid: puuid(i), tier: "GRANDMASTER" as const, leaguePoints: i, wins: 0, losses: 0 }));
    const chosen = selectRankingCandidates(many);
    expect(chosen).toHaveLength(1000);
    expect(chosen[0].leaguePoints).toBe(1199);
  });

  it("제외된 계정을 빼고 순위를 다시 매긴다", () => {
    const rows = [1, 2, 3].map(n => ({ rank: n, riot_id: `P${n}#KR`, tier: "CHALLENGER" as const, league_points: 10 - n, wins: 1, losses: 1, riot_id_hmac: String(n).repeat(64).slice(0, 64) }));
    const result = excludeRankingRows(rows, new Set(["2".repeat(64)]));
    expect(result.removed).toBe(1);
    expect(result.rows.map(row => row.rank)).toEqual([1, 2]);
    expect(result.rows.map(row => row.riot_id)).toEqual(["P1#KR", "P3#KR"]);
  });
});

describe("제외 키", () => {
  it("같은 Riot ID는 대소문자와 공백과 무관하게 같은 키이고 PUUID와 무관하다", () => {
    expect(riotIdHmac(" Alpha ", "KR1", secret)).toBe(riotIdHmac("alpha", "kr1", secret));
    expect(riotIdHmac("Alpha", "KR1", secret)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("짧은 키는 거절한다", () => {
    expect(() => riotIdHmac("a", "b", "short")).toThrow(RankingValidationError);
  });
});

describe("숙련도", () => {
  it("실측 항목에서 필요한 필드만 남기고 puuid 같은 나머지 필드는 버린다", () => {
    const parsed = parseMasteryTop([{
      championId: 266, championLevel: 7, championPoints: 500000, championPointsSinceLastLevel: 1, championPointsUntilNextLevel: 0,
      championSeasonMilestone: 0, lastPlayTime: 1700000000000, markRequiredForNextLevel: 0, milestoneGrades: [], nextSeasonMilestone: {},
      puuid: puuid(1), tokensEarned: 0,
    }]);
    expect(parsed).toEqual([{ championId: 266, championPoints: 500000, championLevel: 7 }]);
    expect(JSON.stringify(parsed)).not.toContain(puuid(1));
  });

  it.each([
    ["11개 항목", Array.from({ length: 11 }, (_, i) => ({ championId: i + 1, championPoints: 1, championLevel: 1 }))],
    ["championPoints 누락", [{ championId: 1, championLevel: 1 }]],
    ["championId 중복", [{ championId: 1, championPoints: 1, championLevel: 1 }, { championId: 1, championPoints: 2, championLevel: 1 }]],
    ["배열 아님", { championId: 1 }],
  ])("%s이면 실패한다", (_label, raw) => {
    expect(() => parseMasteryTop(raw)).toThrow(RankingValidationError);
  });

  it("챔피언별 상위 10명을 만들고 표본 3명 미만은 표본 부족으로 둔다", () => {
    const players = Array.from({ length: 4 }, (_, i) => ({
      gameName: `P${i}`, tagLine: "KR", riotIdHmac: String(i).repeat(64).slice(0, 64),
      masteries: [
        { championId: 1, championPoints: 100 + i, championLevel: 5 },
        ...(i === 0 ? [{ championId: 2, championPoints: 9, championLevel: 1 }] : []),
      ],
    }));
    const board = buildMasteryBoard(players);
    const one = board.find(item => item.champion_id === 1)!;
    expect(one.status).toBe("ok");
    expect(one.sample_size).toBe(4);
    expect(one.entries.map(entry => entry.riot_id)).toEqual(["P3#KR", "P2#KR", "P1#KR", "P0#KR"]);
    expect(board.find(item => item.champion_id === 2)).toEqual({ champion_id: 2, status: "insufficient", sample_size: 1, entries: [] });
    expect(JSON.stringify(board)).not.toContain("puuid");
  });
});

describe("게시 조건", () => {
  const ok = { candidates: 1000, resolved: 960, masteryCompleted: 955, payloadBytes: 1000 };
  it("해석률과 숙련도 완료율이 95% 이상이면 게시한다", () => {
    expect(evaluateRankingPublish(ok)).toEqual({ publish: true, reasons: [] });
  });
  it("해석률이 95% 미만이면 게시하지 않는다", () => {
    const result = evaluateRankingPublish({ ...ok, resolved: 949 });
    expect(result.publish).toBe(false);
    expect(result.reasons.join(" ")).toContain("Riot ID 해석률");
  });
  it("숙련도 완료율이 95% 미만이면 게시하지 않는다", () => {
    expect(evaluateRankingPublish({ ...ok, masteryCompleted: 900 }).publish).toBe(false);
  });
  it("명단이 비었거나 크기 상한을 넘으면 게시하지 않는다", () => {
    expect(evaluateRankingPublish({ candidates: 0, resolved: 0, masteryCompleted: 0, payloadBytes: 0 }).publish).toBe(false);
    expect(evaluateRankingPublish({ ...ok, payloadBytes: RANKING_MAX_PAYLOAD_BYTES + 1 }).publish).toBe(false);
  });
});

describe("장인 메뉴 플래그", () => {
  it("LOL_MASTERS_PUBLIC이 정확히 true일 때만 켜진다", () => {
    expect(lolMastersPublic({ LOL_MASTERS_PUBLIC: "true" })).toBe(true);
    expect(lolMastersPublic({ LOL_MASTERS_PUBLIC: "1" })).toBe(false);
    expect(lolMastersPublic({})).toBe(false);
  });
});

describe("공개 게시본 DTO", () => {
  it("riot_id_hmac과 PUUID를 DTO에 넣지 않는다", async () => {
    const { toPublicRankingBoard, toPublicMasteryBoard } = await import("@/lib/lol/ranking");
    const board = toPublicRankingBoard({ payload: [{ rank: 1, riot_id: "Alpha#KR1", tier: "CHALLENGER", league_points: 1, wins: 2, losses: 3, riot_id_hmac: "a".repeat(64) }],
      playerCount: 1, observedAt: "2026-10-30T20:00:00.000Z" });
    expect(JSON.stringify(board)).not.toMatch(/riot_id_hmac|puuid/);
    expect(board?.rows[0]).toEqual({ rank: 1, riotId: "Alpha#KR1", tier: "CHALLENGER", leaguePoints: 1, wins: 2, losses: 3 });
    const mastery = toPublicMasteryBoard({ observedAt: "2026-10-30T20:00:00.000Z", playerCount: 1, champions: [{ championId: 266, status: "ok", sampleSize: 3,
      entries: [{ rank: 1, riot_id: "Alpha#KR1", champion_points: 5, champion_level: 7, riot_id_hmac: "b".repeat(64) }] }] });
    expect(JSON.stringify(mastery)).not.toMatch(/riot_id_hmac|puuid/);
  });

  it("게시본이 없으면 null이고, 형식이 다르면 실패한다", async () => {
    const { toPublicRankingBoard } = await import("@/lib/lol/ranking");
    expect(toPublicRankingBoard(null)).toBeNull();
    expect(() => toPublicRankingBoard({ payload: "x", playerCount: 1, observedAt: "2026-10-30T20:00:00.000Z" })).toThrow(RankingValidationError);
  });
});
