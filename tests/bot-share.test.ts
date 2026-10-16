import { describe, expect, it } from "vitest";
import { buildBotShare, countBotParticipants, isBotParticipant } from "@/lib/pubg-analysis/botShare";
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
