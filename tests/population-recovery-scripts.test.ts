import { describe, expect, it } from "vitest";
import { RESULT_VERSION, POPULATION_EVIDENCE_VERSION } from "../lib/pubg-analysis/constants";
import {
  shouldSkipScraperMatch,
  hasTrustedScraperBenchmark,
  hasTrustedScraperCache,
} from "../scripts/scrape_elite";
import { buildWeaponMetaBackfillSamples } from "../scripts/backfill_weapon_meta";
import {
  BENCHMARK_FILTER_VERSION,
  BENCHMARK_POPULATION_EVIDENCE_VERSION,
} from "../lib/pubg-analysis/benchmarkLookup";
import { R2_BURST_POPULATION_MARKERS } from "../scripts/backfill_weapon_meta_bursts";

describe("population recovery and maintenance scripts", () => {
  it("only skips a current scraper cache when both canonical evidence markers are trusted", () => {
    const trustedFullResult = {
      v: RESULT_VERSION,
      populationEvidenceVersion: POPULATION_EVIDENCE_VERSION,
    };
    const trustedBenchmark = {
      filter_version: BENCHMARK_FILTER_VERSION,
      population_evidence_version: BENCHMARK_POPULATION_EVIDENCE_VERSION,
      match_type: "official",
    };

    expect(hasTrustedScraperCache(trustedFullResult)).toBe(true);
    expect(hasTrustedScraperBenchmark(trustedBenchmark)).toBe(true);
    expect(shouldSkipScraperMatch({ fullResult: trustedFullResult, benchmark: trustedBenchmark })).toBe(true);

    expect(hasTrustedScraperCache({ v: RESULT_VERSION })).toBe(false);
    expect(shouldSkipScraperMatch({
      fullResult: { v: RESULT_VERSION },
      benchmark: trustedBenchmark,
    })).toBe(false);
    expect(shouldSkipScraperMatch({
      fullResult: trustedFullResult,
      benchmark: { id: "legacy-row", match_type: "official" },
    })).toBe(false);
    expect(shouldSkipScraperMatch({
      fullResult: trustedFullResult,
      benchmark: { ...trustedBenchmark, match_type: "tdm" },
    })).toBe(false);
  });

  it("backfills only marked, benchmark-eligible full results and preserves wrapper evidence", () => {
    const base = {
      createdAt: "2026-08-12T01:00:00.000Z",
      gameMode: "squad-fpp",
      matchType: "official",
      populationEvidenceVersion: POPULATION_EVIDENCE_VERSION,
      weaponStats: { WeapHK416_C: { damage: 100, kills: 1, hits: 5 } },
    };
    const rows = [
      { match_id: "trusted", platform: "steam", player_id: "player", data: { fullResult: base } },
      { match_id: "unmarked", platform: "steam", player_id: "player", data: { fullResult: { ...base, populationEvidenceVersion: undefined } } },
      { match_id: "custom-wrapper", platform: "steam", player_id: "player", data: { isCustomMatch: true, fullResult: base } },
      { match_id: "event-wrapper", platform: "steam", player_id: "player", data: { fullResult: { ...base, telemetryFlags: { isEventMode: true } } } },
      { match_id: "tdm", platform: "steam", player_id: "player", data: { fullResult: { ...base, gameMode: "tdm" } } },
      { match_id: "missing-type", platform: "steam", player_id: "player", data: { fullResult: { ...base, matchType: undefined } } },
    ];

    const samples = buildWeaponMetaBackfillSamples(rows, {
      patchVersion: "42.3",
      patchStartedAt: "2026-08-12T00:00:00.000Z",
    });

    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      match_id: "trusted",
      match_type: "official",
      filter_version: BENCHMARK_FILTER_VERSION,
      population_evidence_version: POPULATION_EVIDENCE_VERSION,
    });
  });

  it("exposes the current burst markers for filtering without writing provenance", () => {
    expect(R2_BURST_POPULATION_MARKERS).toEqual({
      filter_version: BENCHMARK_FILTER_VERSION,
      population_evidence_version: POPULATION_EVIDENCE_VERSION,
    });
  });
});
