import { describe, expect, it } from "vitest";
import {
  KNOWN_BATTLE_ROYALE_MODES,
  evaluateMatchEligibility,
  isAiSummaryEligibleMatch,
  isStandardBenchmarkMatch,
  normalizeBenchmarkMatchType,
} from "@/lib/pubg-analysis/matchEligibility";

describe("shared PUBG population eligibility", () => {
  it("recognizes exactly the six standard battle-royale modes", () => {
    expect(KNOWN_BATTLE_ROYALE_MODES).toEqual([
      "solo", "solo-fpp", "duo", "duo-fpp", "squad", "squad-fpp",
    ]);
    for (const gameMode of KNOWN_BATTLE_ROYALE_MODES) {
      expect(isAiSummaryEligibleMatch({ gameMode, matchType: "official" })).toBe(true);
      expect(evaluateMatchEligibility({ gameMode, matchType: "official" }, "ai-summary").reason).toBe("eligible");
    }
  });

  it("allows blank/unknown AI match type only when a known BR mode is present", () => {
    expect(isAiSummaryEligibleMatch({ gameMode: " squad-fpp ", matchType: "" })).toBe(true);
    expect(isAiSummaryEligibleMatch({ gameMode: "squad-fpp", matchType: "unknown" })).toBe(true);
    expect(isAiSummaryEligibleMatch({ gameMode: "unknown", matchType: "official" })).toBe(false);
    expect(isAiSummaryEligibleMatch({ matchType: "official" })).toBe(false);
  });

  it("accepts ranked aliases for both AI and benchmark populations and canonicalizes storage", () => {
    const ranked = {
      gameMode: "DUO-FPP",
      matchType: " ranked-fpp ",
    };
    expect(isAiSummaryEligibleMatch(ranked)).toBe(true);
    expect(isStandardBenchmarkMatch(ranked)).toBe(true);
    expect(normalizeBenchmarkMatchType(ranked)).toBe("competitive");
  });

  it("does not infer a battle-royale party mode from ranked or explicit TPP gameMode aliases", () => {
    for (const gameMode of ["ranked", "ranked-fpp", "ranked-tpp", "squad-tpp"]) {
      const result = evaluateMatchEligibility({ gameMode, matchType: "official" }, "ai-summary");
      expect(result.eligible, gameMode).toBe(false);
      expect(["non_battle_royale_mode", "unknown_mode"]).toContain(result.reason);
    }
  });

  it("treats a secondary normal mode as custom-family evidence, not a type alias", () => {
    const result = evaluateMatchEligibility({
      gameMode: "squad-fpp",
      matchType: "official",
      matchInfo: { mode: "normal" },
    }, "ai-summary");
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("custom_mode_family");
  });

  it("canonicalizes secondary ranked/official mode evidence for benchmark storage", () => {
    expect(evaluateMatchEligibility({
      gameMode: "squad-fpp",
      matchType: "official",
      matchInfo: { mode: "ranked" },
    }, "benchmark")).toMatchObject({ eligible: true, matchType: "competitive" });
    expect(evaluateMatchEligibility({
      gameMode: "squad-fpp",
      matchInfo: { mode: "official" },
    }, "benchmark")).toMatchObject({ eligible: true, matchType: "official" });
  });

  it.each([
    ["TDM mode", { gameMode: " tDm-squad-fpp ", matchType: "official" }, "tdm_mode"],
    ["TDM map", { gameMode: "squad-fpp", matchType: "official", mapName: "  ITALY_TDM_MAIN " }, "tdm_map"],
    ["AI mode", { gameMode: "squad-ai", matchType: "official" }, "ai_or_bot"],
    ["AI type", { gameMode: "squad-fpp", matchType: "AIROYALE" }, "ai_or_bot"],
    ["event family", { gameMode: "event-squad-fpp", matchType: "official" }, "event_mode"],
    ["custom family", { gameMode: "normal-squad-fpp", matchType: "official" }, "custom_mode_family"],
    ["custom flag", { gameMode: "squad-fpp", matchType: "official", attributes: { isCustomMatch: true } }, "custom_match"],
    ["telemetry event flag", {
      gameMode: "squad-fpp",
      matchType: "official",
      telemetry: [{ _T: "LogMatchStart", isCustomGame: true }],
    }, "custom_match"],
    ["canonical telemetry flags", {
      gameMode: "squad-fpp",
      matchType: "official",
      telemetryFlags: { isCustomGame: true },
    }, "custom_match"],
    ["nested canonical telemetry event flags", {
      gameMode: "squad-fpp",
      matchType: "official",
      telemetryFlags: { LogMatchStart: { isEventMode: true } },
    }, "event_mode"],
    ["nested match attributes", {
      gameMode: "squad-fpp",
      matchType: "official",
      matchAttributes: { isCustomMatch: true },
    }, "custom_match"],
    ["telemetry mode flag", {
      gameMode: "squad-fpp",
      matchType: "official",
      telemetry: [{ _T: "LogMatchStart", isEventMode: true }],
    }, "event_mode"],
    ["arcade family", { gameMode: "arcade-squad", matchType: "official" }, "event_mode"],
    ["missing mode", { matchType: "official" }, "missing_mode"],
    ["unknown mode", { gameMode: "unknown", matchType: "official" }, "unknown_mode"],
  ] as const)("rejects %s with a stable reason", (_label, input, reason) => {
    const result = evaluateMatchEligibility(input, "ai-summary");
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe(reason);
  });

  it("collects snake_case and nested matchInfo evidence without inventing fields", () => {
    const nested = {
      matchInfo: {
        game_mode: "squad-fpp",
        match_type: "official",
        map_name: "Baltic_Main",
      },
    };
    expect(isAiSummaryEligibleMatch(nested)).toBe(true);
    expect(isStandardBenchmarkMatch(nested)).toBe(true);
    expect(evaluateMatchEligibility({ matchInfo: { game_mode: "unknown" }, gameMode: "squad-fpp" }, "ai-summary").eligible).toBe(false);
  });

  it("requires canonical official/competitive type for benchmark persistence", () => {
    expect(isStandardBenchmarkMatch({ gameMode: "squad-fpp", matchType: "unknown" })).toBe(false);
    expect(isStandardBenchmarkMatch({ gameMode: "squad-fpp", matchType: "seasonal" })).toBe(false);
    expect(isStandardBenchmarkMatch({ gameMode: "squad-fpp", matchType: "official" })).toBe(true);
  });

  it("uses token boundaries instead of rejecting arbitrary words containing an exclusion token", () => {
    expect(evaluateMatchEligibility({ gameMode: "squad-fpp", matchType: "customary" }, "ai-summary").reason)
      .toBe("match_type_not_canonical");
    expect(evaluateMatchEligibility({ gameMode: "squad-fpp", matchType: "eventual" }, "ai-summary").reason)
      .toBe("match_type_not_canonical");
  });

  it.each([
    ["seasonal", "seasonal_match"],
    ["eventMode", "event_mode"],
    ["squad-fpp-war", "custom_mode_family"],
    ["squad-fpp-zombie", "custom_mode_family"],
    ["squad-fpp-conquest", "custom_mode_family"],
    ["squad-fpp-esports", "custom_mode_family"],
    ["squad-fpp-training", "event_mode"],
    ["squad-fpp-tdm", "tdm_mode"],
    ["squad-fpp-arcade", "event_mode"],
    ["squad-fpp-custom", "custom_mode_family"],
    ["normal", "custom_mode_family"],
  ] as const)("rejects secondary mode family %s even with a canonical primary BR mode", (secondaryMode, reason) => {
    const result = evaluateMatchEligibility({
      gameMode: "squad-fpp",
      matchType: "official",
      matchInfo: { mode: secondaryMode },
    }, "ai-summary");
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe(reason);
  });

  it("does not reject separator-aware near misses such as reward, eventual, or customary", () => {
    for (const mode of ["reward", "eventual", "customary"]) {
      const result = evaluateMatchEligibility({
        gameMode: "squad-fpp",
        matchType: "official",
        matchInfo: { mode },
      }, "ai-summary");
      expect(result.eligible, mode).toBe(true);
    }
  });
});
