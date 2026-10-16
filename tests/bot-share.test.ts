import { describe, expect, it } from "vitest";
import { buildBotShare, countBotParticipants, humanDamageRankPct, isBotParticipant } from "@/lib/pubg-analysis/botShare";
import { AnalysisEngine } from "@/lib/pubg-analysis/AnalysisEngine";

describe("봇 비율", () => {
  it("stats.playerId가 ai.로 시작하면 봇으로 본다", () => {
    expect(isBotParticipant({ attributes: { stats: { playerId: "ai.123" } } })).toBe(true);
    expect(isBotParticipant({ attributes: { stats: { playerId: "account.abc" } } })).toBe(false);
    expect(isBotParticipant({ attributes: { accountId: "ai.9", stats: null } })).toBe(true);
    expect(isBotParticipant(null)).toBe(false);
  });

  it("참가자 목록에서 봇 수를 센다", () => {
    const participants = [
      { attributes: { stats: { playerId: "ai.1" } } },
      { attributes: { stats: { playerId: "ai.2" } } },
      { attributes: { stats: { playerId: "account.1" } } },
    ];
    expect(countBotParticipants(participants)).toBe(2);
    expect(countBotParticipants(undefined)).toBe(0);
  });

  it("비율과 단계를 계산한다", () => {
    expect(buildBotShare(62, 30)).toEqual({ botCount: 30, humanCount: 32, percent: 48, level: "some" });
    expect(buildBotShare(64, 0)?.level).toBe("none");
    expect(buildBotShare(100, 10)?.level).toBe("few");
    expect(buildBotShare(100, 50)?.level).toBe("many");
    expect(buildBotShare(100, 80)?.level).toBe("mostly");
  });

  it("값이 없거나 맞지 않으면 표시하지 않는다", () => {
    expect(buildBotShare(62, undefined)).toBeNull();
    expect(buildBotShare(0, 0)).toBeNull();
    expect(buildBotShare(10, 11)).toBeNull();
    expect(buildBotShare(10, -1)).toBeNull();
  });
});

describe("분석 결과의 봇 수", () => {
  it("참가자 중 ai. 플레이어 수를 botCount로 남긴다", () => {
    const participant = (name: string, playerId: string) => ({ attributes: { stats: { name, playerId, damageDealt: 0 } } });
    const participants = [
      participant("Me", "account.me"),
      participant("Human", "account.h"),
      participant("Bot1", "ai.1"),
      participant("Bot2", "ai.2"),
    ];
    const result = new AnalysisEngine("Me", "account.me", new Set(["me"]), new Set(["account.me"]), new Set(), new Set(), "ours")
      .run([], { gameMode: "squad" }, [], participants, { name: "Me", damageDealt: 100, timeSurvived: 1200, winPlace: 10 }, [], {});
    expect(result.totalPlayers).toBe(4);
    expect(result.botCount).toBe(2);
  });
});

describe("봇을 뺀 딜량 순위 비율", () => {
  const p = (name: string, playerId: string, damageDealt: number) => ({ attributes: { stats: { name, playerId, damageDealt } } });
  const participants = [
    p("Top", "account.1", 900),
    p("BotHigh", "ai.1", 500),
    p("Me", "account.me", 300),
    p("Mid", "account.2", 200),
    p("BotLow1", "ai.2", 20),
    p("BotLow2", "ai.3", 10),
  ];

  it("봇은 순위와 분모에서 모두 빠진다", () => {
    expect(humanDamageRankPct(participants, "me")).toBeCloseTo(2 / 3);
    expect(humanDamageRankPct(participants, "top")).toBeCloseTo(1 / 3);
  });

  it("내 기록이 없거나 사람이 없으면 가장 낮은 비율로 둔다", () => {
    expect(humanDamageRankPct(participants, "ghost")).toBe(1);
    expect(humanDamageRankPct([p("Bot", "ai.9", 10)], "me")).toBe(1);
    expect(humanDamageRankPct(undefined, "me")).toBe(1);
  });
});
