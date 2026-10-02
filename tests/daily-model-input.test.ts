import { describe, expect, it, vi } from "vitest";
import type { DailyEvidence } from "@/lib/learn/dailyEvidence";

const sdk = vi.hoisted(() => ({
  model: vi.fn(),
  content: vi.fn(),
}));
vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel(options: unknown) {
      sdk.model(options);
      return { generateContent: sdk.content };
    }
  },
}));

import { buildDailyModelInput, generateDailySceneResponse, validateDailyAiStory } from "@/lib/learn/dailyAi";

const evidence: DailyEvidence = {
  dayKst: "2026-09-23", matchId: "match-1", accountId: "account.winner",
  nickname: "Winner", mode: "squad", mapName: "미라마", leaderboardRank: 10,
  playedAt: "2026-09-23T08:05:55Z", kills: 0, damage: 0, teamKills: 0,
  facts: [
    { id: "landing", timeSeconds: 60, kind: "landing", text: "Winner 착지", sourceIndices: [1] },
    { id: "route-1", timeSeconds: 200, kind: "route", text: "아군 위치 관측", sourceIndices: [2] },
    { id: "revive-818.722", timeSeconds: 818.722, kind: "revive", text: "Winner → Teammate 소생",
      sourceIndices: [3], eventType: "LogPlayerRevive", actorId: "account.winner", victimId: "account.teammate" },
    { id: "finish", timeSeconds: 1000, kind: "finish", text: "경기 종료 · 아군 1위", sourceIndices: [4] },
  ],
  roster: [{ name: "Winner", kills: 0, isRanker: true }, { name: "Teammate", kills: 0, isRanker: false }],
  killEvents: [], teamKillEvents: [], weapons: [], route: [], aircraft: [], zones: [], limitations: [],
};

describe("daily production and comparison input", () => {
  it("includes the full facts including the revive omitted in the old comparison", () => {
    const input = buildDailyModelInput(evidence);
    expect(input.facts).toEqual(evidence.facts);
    expect(input.facts.find((fact) => fact.kind === "revive")).toMatchObject({
      timeSeconds: 818.722, sourceIndices: [3], eventType: "LogPlayerRevive",
      actorId: "account.winner", victimId: "account.teammate",
    });
    expect(input.facts.some((fact) => fact.kind === "route")).toBe(true);
    const ids = new Set(input.facts.map((fact) => fact.id));
    expect(input.sceneCandidates.every((scene) => scene.evidenceIds.every((id) => ids.has(id)))).toBe(true);
    expect(input.sceneCandidates.some((scene) => scene.kind === "recovery")).toBe(true);
  });

  it("sends that exact input and retains malformed model output for evaluation", async () => {
    sdk.content.mockResolvedValueOnce({ response: {
      text: () => "not JSON", candidates: [{ finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 123 }, modelVersion: "test-version",
    } });
    const output = await generateDailySceneResponse(evidence, "test-key", "test-model");
    expect(JSON.parse(sdk.content.mock.calls.at(-1)![0])).toEqual(buildDailyModelInput(evidence));
    expect(sdk.model).toHaveBeenLastCalledWith(expect.objectContaining({ model: "test-model" }));
    expect(output).toMatchObject({ value: null, rawText: "not JSON", usage: { promptTokenCount: 123 }, modelVersion: "test-version" });
  });

  it("publishes code-built scenes and excludes unsolicited model prose", () => {
    const input = buildDailyModelInput(evidence);
    const sceneIds = input.sceneCandidates.slice(0, 5).map((scene) => scene.id);
    const story = validateDailyAiStory({ sceneIds, conclusion: "능선에서 상대를 유인해 승리했다" }, evidence);
    expect(story.schemaVersion).toBe(2);
    expect(story.scenes?.some((scene) => scene.kind === "recovery")).toBe(true);
    expect(story.scenes?.some((scene) => scene.kind === "finish")).toBe(true);
    expect(JSON.stringify(story)).not.toContain("유인");
    expect(story.selection).toHaveProperty("usedFallback");
  });
});
