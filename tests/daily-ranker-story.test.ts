import { describe, expect, it } from "vitest";
import { validateDailyAiStory } from "@/lib/learn/dailyAi";
import { isWinningMatch, kstDate, previousKstDay } from "@/scripts/publish_daily_ranker_story";
import type { DailyEvidence } from "@/lib/learn/dailyEvidence";

const candidate = { accountId: "account.a", nickname: "Winner", rank: 16 };
const match = {
  data: { attributes: {
    shardId: "steam", gameMode: "solo", matchType: "competitive", isCustomMatch: false,
    createdAt: "2026-09-22T15:05:00Z",
  } },
  included: [{ type: "participant", attributes: { stats: { playerId: candidate.accountId, winPlace: 1 } } }],
};

describe("daily ranker publication boundaries", () => {
  it("uses the KST calendar day across midnight", () => {
    expect(kstDate(new Date("2026-09-22T15:05:00Z"))).toBe("2026-09-23");
    expect(previousKstDay(new Date("2026-09-24T01:00:00Z"))).toBe("2026-09-23");
  });

  it("accepts only the same account's Steam competitive winner on that day and mode", () => {
    expect(isWinningMatch(match, candidate, "2026-09-23", "solo")).toBe(true);
    expect(isWinningMatch(match, candidate, "2026-09-22", "solo")).toBe(false);
    expect(isWinningMatch(match, { ...candidate, accountId: "account.other" }, "2026-09-23", "solo")).toBe(false);
    expect(isWinningMatch(match, candidate, "2026-09-23", "squad")).toBe(false);
    expect(isWinningMatch({ ...match, data: { attributes: { ...match.data.attributes, matchType: "official" } } }, candidate, "2026-09-23", "solo")).toBe(false);
  });

  it("rejects unknown citations and never publishes model-written unsupported prose", () => {
    const evidence: DailyEvidence = {
      dayKst: "2026-09-23", matchId: "match-1", accountId: candidate.accountId,
      nickname: "Winner", mode: "solo", mapName: "미라마", leaderboardRank: 16,
      playedAt: "2026-09-22T15:05:00Z", kills: 1, damage: 100, teamKills: 1,
      facts: [{ id: "kill-1", timeSeconds: 42, kind: "kill", text: "M416 처치" }],
      killEvents: [{ timeSeconds: 42, victim: "Opponent", weapon: "M416" }],
      teamKillEvents: [{ timeSeconds: 42, killer: "Winner", victim: "Opponent", weapon: "M416", attackId: null }],
      route: [], aircraft: [],
      zones: [], weapons: [{ name: "M416", kills: 1 }], limitations: [],
    };
    const valid = {
      headline: "M416 첫 처치 이후 우승한 경기",
      conclusion: "42초에 M416 처치가 기록됐습니다. 경기 결과는 우승으로 끝났습니다.",
      points: [{ text: "M416으로 첫 처치가 기록됐습니다.", evidenceIds: ["kill-1"] }, { text: "첫 기록 이후 매치가 진행됐습니다.", evidenceIds: ["kill-1"] }],
    };
    expect(validateDailyAiStory(valid, evidence).points).toHaveLength(2);
    expect(() => validateDailyAiStory({ ...valid, points: [{ ...valid.points[0], evidenceIds: ["missing"] }, valid.points[1]] }, evidence)).toThrow("ai_point_evidence");
    const published = validateDailyAiStory({ ...valid, conclusion: "상대를 노렸고 정확하게 예측했습니다.", points: [
      { text: "근거 없이 상대를 노렸습니다.", evidenceIds: ["kill-1"] }, valid.points[1],
    ] }, evidence);
    expect(published.conclusion).not.toContain("노렸");
    expect(published.points[0].text).toBe("00:42 M416 처치");
  });

  it("names the squad's final credited weapon separately from the ranker's personal kill", () => {
    const evidence: DailyEvidence = {
      dayKst: "2026-09-23", matchId: "squad-1", accountId: candidate.accountId,
      nickname: "Winner", mode: "squad", mapName: "미라마", leaderboardRank: 1,
      playedAt: "2026-09-22T15:05:00Z", kills: 1, damage: 100, teamKills: 2,
      facts: [{ id: "landing", timeSeconds: 60, kind: "landing", text: "Winner 착지" },
        { id: "teammate-kill", timeSeconds: 200, kind: "teammate_kill", text: "Teammate 수류탄 처치" }],
      killEvents: [{ timeSeconds: 100, victim: "Opponent1", weapon: "M416" }],
      teamKillEvents: [{ timeSeconds: 100, killer: "Winner", victim: "Opponent1", weapon: "M416", attackId: 1 },
        { timeSeconds: 200, killer: "Teammate", victim: "Opponent2", weapon: "수류탄", attackId: -1 }],
      route: [], aircraft: [], zones: [], weapons: [{ name: "M416", kills: 1 }], limitations: [],
    };
    const story = validateDailyAiStory({ points: [{ evidenceIds: ["landing"] }, { evidenceIds: ["teammate-kill"] }] }, evidence);
    expect(story.conclusion).toContain("마지막 팀 처치는 03:20 Teammate의 수류탄");
    expect(story.conclusion).toContain("마지막 개인 처치는 01:40 M416");
  });
});
