import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeSurvivalMasteryPayload,
  shouldRefreshSurvivalMastery,
} from "@/lib/pubg/survivalMastery";

const ROUTE_SOURCE = readFileSync(resolve("app/api/pubg/player/route.ts"), "utf8");
const MIGRATION_SOURCE = readFileSync(
  resolve("supabase/migrations/20260817172423_add_survival_mastery_cache.sql"),
  "utf8",
);

describe("PUBG survival mastery", () => {
  it("normalizes the official data.attributes payload", () => {
    expect(normalizeSurvivalMasteryPayload({
      data: {
        type: "survivalMasterySummary",
        id: "account.1",
        attributes: {
          xp: 1317,
          tier: 3,
          level: 441,
          totalMatchesPlayed: 782,
          latestMatchId: "match-1",
        },
      },
    })).toEqual({
      xp: 1317,
      tier: 3,
      level: 441,
      totalMatchesPlayed: 782,
    });
  });

  it("rejects missing or invalid level data", () => {
    expect(normalizeSurvivalMasteryPayload(null)).toBeNull();
    expect(normalizeSurvivalMasteryPayload({ data: { attributes: { xp: 1317 } } })).toBeNull();
    expect(normalizeSurvivalMasteryPayload({ data: { attributes: { level: "441" } } })).toBeNull();
  });

  it("refreshes missing and stale data but keeps recent data cached", () => {
    const now = Date.parse("2026-08-18T00:00:00.000Z");
    expect(shouldRefreshSurvivalMastery(null, now)).toBe(true);
    expect(shouldRefreshSurvivalMastery("2026-08-17T11:59:59.999Z", now)).toBe(true);
    expect(shouldRefreshSurvivalMastery("2026-08-17T12:00:00.001Z", now)).toBe(false);
  });
});

describe("survival mastery cache integration contract", () => {
  it("stores account-level mastery data in the existing player cache", () => {
    expect(MIGRATION_SOURCE).toContain("survival_mastery_data jsonb");
    expect(MIGRATION_SOURCE).toContain("survival_mastery_updated_at timestamptz");
  });

  it("uses the official survival mastery endpoint in the player route", () => {
    expect(ROUTE_SOURCE).toContain("/survival_mastery");
    expect(ROUTE_SOURCE).toContain("survival_mastery_data");
    expect(ROUTE_SOURCE).toContain("survival_mastery_updated_at");
  });
});
