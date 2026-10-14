import { describe, expect, it } from "vitest";
import { buildSquadAiCoachingPrompt } from "@/lib/pubg-analysis/squadAiCoachingPrompt";

const base = { groupKey: "Teammate_B", stats: {}, scores: {}, roleProfiles: [], nickname: "Player_A", benchmarkStats: {} };

describe("팀 AI 프롬프트의 팀 모드", () => {
  it("듀오는 2인 팀으로 알리고 스쿼드 표현을 금지한다", () => {
    const { prompt, systemInstruction } = buildSquadAiCoachingPrompt({ ...base, teamMode: "duo" });
    expect(prompt).toContain("듀오(2인 팀)");
    expect(systemInstruction).toContain("DUO team of exactly two players");
  });
  it("모드를 넘기지 않으면 기존 스쿼드 프롬프트를 유지한다", () => {
    const { prompt, systemInstruction } = buildSquadAiCoachingPrompt(base);
    expect(prompt).toContain("스쿼드(최대 4인 팀)");
    expect(systemInstruction).not.toContain("DUO team");
  });
});
