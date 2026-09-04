import { describe, expect, it } from "vitest";
import {
  buildR2BurstUpdate,
  buildBurstTelemetryIdentity,
  parseCanonicalBurstEvents,
} from "../scripts/backfill_weapon_meta_bursts";
import {
  createTelemetryAnalyzeCacheEnvelope,
  buildTelemetryAnalyzeCacheKey,
} from "../lib/pubg-analysis/telemetryCacheKey";

describe("R2 weapon-meta burst backfill", () => {
  it("updates only burst columns for an existing match-level weapon sample", () => {
    const update = buildR2BurstUpdate({
      matchId: "match-1",
      platform: "steam",
      playerId: "playerone",
      events: [
        { _T: "LogPlayerTakeDamage", _D: "2026-08-01T00:00:00.000Z", attacker: { accountId: "account.me", teamId: 1 }, victim: { accountId: "enemy", teamId: 2 }, damageCauserName: "Item_Weapon_M249_C", damage: 10 },
        { _T: "LogPlayerTakeDamage", _D: "2026-08-01T00:00:01.100Z", attacker: { accountId: "account.me", teamId: 1 }, victim: { accountId: "enemy", teamId: 2 }, damageCauserName: "Item_Weapon_M249_C", damage: 10 },
      ],
      playerAccountId: "account.me",
      sampleWeaponNames: ["M249", "MG3"],
    });

    expect(update).toEqual([{
      match_id: "match-1",
      platform: "steam",
      player_id: "playerone",
      weapon_name: "M249",
      first_sec_hits: 1,
      sustained_hits: 1,
      sustained_burst_count: 1,
    }, {
      match_id: "match-1",
      platform: "steam",
      player_id: "playerone",
      weapon_name: "MG3",
      first_sec_hits: 0,
      sustained_hits: 0,
      sustained_burst_count: 0,
    }]);
  });

  it("accepts only the canonical v61 analyzed-event envelope for the exact identity", () => {
    const identity = buildBurstTelemetryIdentity({ match_id: "match-1", platform: "steam" }, "account.me");
    expect(identity).not.toBeNull();
    const envelope = createTelemetryAnalyzeCacheEnvelope(identity!, [{ _T: "LogPlayerTakeDamage" }]);

    expect(parseCanonicalBurstEvents(envelope, identity!)).toEqual(envelope.events);
    expect(parseCanonicalBurstEvents(envelope, {
      ...identity!,
      playerId: "account.other",
    })).toBeNull();
    expect(parseCanonicalBurstEvents(envelope, {
      ...identity!,
      platform: "kakao",
    })).toBeNull();
    expect(parseCanonicalBurstEvents(envelope, {
      ...identity!,
      telemetryVersion: 60,
    })).toBeNull();
    expect(parseCanonicalBurstEvents(envelope.events, identity!)).toBeNull();
    expect(buildTelemetryAnalyzeCacheKey(identity!)).toContain("v61/steam/match-1");
  });

  it("rejects empty, malformed, unknown, or mixed-invalid analyzed event arrays", () => {
    const identity = buildBurstTelemetryIdentity({ match_id: "match-1", platform: "steam" }, "account.me");
    expect(identity).not.toBeNull();

    const envelope = (events: unknown[]) => createTelemetryAnalyzeCacheEnvelope(identity!, events);
    expect(parseCanonicalBurstEvents(envelope([{}]), identity!)).toBeNull();
    expect(parseCanonicalBurstEvents(envelope([]), identity!)).toBeNull();
    expect(parseCanonicalBurstEvents(envelope([{ _T: "LogUnknownEvent" }]), identity!)).toBeNull();
    expect(parseCanonicalBurstEvents(envelope([
      { _T: "LogPlayerKill" },
      {},
    ]), identity!)).toBeNull();
  });
});
