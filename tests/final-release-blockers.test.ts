import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  getValidFullResultForMatch,
  isFullResultForPlayerPlatform,
} from "@/lib/pubg-analysis/cacheIdentity";
import { RESULT_VERSION, POPULATION_EVIDENCE_VERSION } from "@/lib/pubg-analysis/constants";
import {
  buildTelemetryAnalyzeCacheKey,
  createTelemetryAnalyzeCacheEnvelope,
  parseTelemetryAnalyzeCacheEnvelope,
} from "@/lib/pubg-analysis/telemetryCacheKey";

const canonicalFullResult = {
  matchId: "match-1",
  player_id: "player_a",
  platform: "steam",
  v: RESULT_VERSION,
  populationEvidenceVersion: POPULATION_EVIDENCE_VERSION,
  stats: { name: "Player_A", kills: 2 },
};

describe("final PUBG AI release-blocker contracts", () => {
  it("requires explicit embedded player identity and platform", () => {
    expect(isFullResultForPlayerPlatform({
      ...canonicalFullResult,
      player_id: undefined,
    }, "player_a", "steam")).toBe(false);
    expect(isFullResultForPlayerPlatform({
      ...canonicalFullResult,
      platform: "",
    }, "player_a", "steam")).toBe(false);
    expect(isFullResultForPlayerPlatform({
      ...canonicalFullResult,
      player_id: "other",
    }, "player_a", "steam")).toBe(false);
    expect(isFullResultForPlayerPlatform({
      ...canonicalFullResult,
      platform: "kakao",
    }, "player_a", "steam")).toBe(false);
    expect(isFullResultForPlayerPlatform(canonicalFullResult, "player_a", undefined as unknown as string)).toBe(false);
  });

  it("strict canonical lookup requires the population evidence marker when requested", () => {
    const row = {
      match_id: "match-1",
      player_id: "player_a",
      platform: "steam",
      data: { fullResult: canonicalFullResult },
    };
    const expected = {
      matchId: "match-1",
      playerId: "player_a",
      platform: "steam",
      minResultVersion: RESULT_VERSION,
      requirePopulationEvidence: true,
    } as const;

    expect(getValidFullResultForMatch(row, expected)).toBe(canonicalFullResult);
    expect(getValidFullResultForMatch({
      ...row,
      data: { fullResult: { ...canonicalFullResult, populationEvidenceVersion: undefined } },
    }, expected)).toBeNull();
    expect(getValidFullResultForMatch({
      ...row,
      data: { fullResult: { ...canonicalFullResult, populationEvidenceVersion: 0 } },
    }, expected)).toBeNull();
    expect(getValidFullResultForMatch({
      ...row,
      data: { fullResult: { ...canonicalFullResult, v: RESULT_VERSION + 1 } },
    }, { ...expected, requireExactResultVersion: true })).toBeNull();
  });

  it("canonical telemetry envelope rejects wrong identity and the legacy v60 key is not trusted", () => {
    const identity = {
      matchId: "match-1",
      platform: "steam" as const,
      playerId: "account.player",
      mode: "lite" as const,
      telemetryVersion: 61,
    };
    const envelope = createTelemetryAnalyzeCacheEnvelope(identity, [{ _T: "LogPlayerKillV2" }]);
    expect(parseTelemetryAnalyzeCacheEnvelope(envelope, identity)).toEqual(envelope.events);
    expect(parseTelemetryAnalyzeCacheEnvelope(envelope, {
      ...identity,
      playerId: "account.other",
    })).toBeNull();
    expect(parseTelemetryAnalyzeCacheEnvelope(envelope, {
      ...identity,
      platform: "kakao",
    })).toBeNull();
    expect(parseTelemetryAnalyzeCacheEnvelope(envelope, {
      ...identity,
      telemetryVersion: 60,
    })).toBeNull();
    expect(parseTelemetryAnalyzeCacheEnvelope(envelope.events, identity)).toBeNull();
    expect(buildTelemetryAnalyzeCacheKey(identity)).not.toContain("_v60_analyze.json");

    const source = fs.readFileSync("scripts/backfill_weapon_meta_bursts.ts", "utf8");
    expect(source).not.toMatch(/\$\{[^}]+\}_v60_analyze\.json/);
    expect(source).toContain("parseTelemetryAnalyzeCacheEnvelope");
  });

  it("AI routes use server-owned squad analysis rather than request numeric evidence", () => {
    const source = fs.readFileSync("app/api/pubg/ai-squad/route.ts", "utf8");
    expect(source).toContain("getSquadAnalysisData");
    expect(source).toContain("squadData.stats");
    expect(source).toContain("squadData.scores");
    expect(source).not.toMatch(/buildSquadAiCoachingPrompt\(\{[\s\S]{0,600}stats,\s*scores,\s*roleProfiles/);
  });

  it("single-match AI validates canonical evidence before cache lookup", () => {
    const source = fs.readFileSync("app/api/pubg/ai-analyze/route.ts", "utf8");
    const canonicalIndex = source.indexOf("getValidFullResultForMatch");
    const cacheIndex = source.indexOf("match_ai_coaching_cache");
    expect(canonicalIndex).toBeGreaterThanOrEqual(0);
    expect(cacheIndex).toBeGreaterThan(canonicalIndex);
    expect(source).toContain("requirePopulationEvidence: true");
  });
});
