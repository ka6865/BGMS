import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { createTelemetryAnalyzeCacheEnvelope } from "@/lib/pubg-analysis/telemetryCacheKey";
import { createTelemetryIdentity } from "@/lib/pubg-analysis/telemetryIdentity";
import { TELEMETRY_VERSION } from "@/lib/pubg-analysis/constants";
import { DeathEncounterSourceError, loadDeathEncounters } from "@/lib/pubg/deathEncounters.server";

const now = () => new Date("2026-08-27T00:00:10.000Z");
const subject = { name: "Me", accountId: "account.subject", teamId: 1 };
const killer = { name: "Enemy", accountId: "account.enemy", teamId: 2 };
const events = [
  { _T: "LogPlayerKillV2", _D: "2026-08-27T00:00:05.000Z", victim: subject, killer },
];

function upstreamMatch() {
  return {
    data: {
      id: "match-1",
      relationships: { assets: { data: [{ type: "asset", id: "asset-1" }] } },
    },
    included: [
      {
        type: "asset",
        id: "asset-1",
        attributes: { URL: "https://telemetry-cdn.pubg.com/asset-1-telemetry.json" },
      },
      {
        type: "participant",
        id: "participant-1",
        attributes: { stats: { name: "Me", playerId: "account.subject" } },
      },
      {
        type: "participant",
        id: "participant-2",
        attributes: { stats: { name: "Mate", playerId: "account.mate" } },
      },
      {
        type: "roster",
        id: "roster-1",
        relationships: { participants: { data: [{ type: "participant", id: "participant-1" }, { type: "participant", id: "participant-2" }] } },
      },
    ],
  };
}

describe("loadDeathEncounters", () => {
  it("uses a verified private R2 envelope before calling upstream", async () => {
    const identity = createTelemetryIdentity({ matchId: "match-1", platform: "steam", playerId: "account.subject", mode: "lite", telemetryVersion: TELEMETRY_VERSION });
    const envelope = createTelemetryAnalyzeCacheEnvelope(identity, events);
    const read = vi.fn(async () => JSON.stringify(envelope));
    const fetch = vi.fn();
    const result = await loadDeathEncounters({ matchId: "match-1", platform: "steam", subjectAccountId: "account.subject" }, { downloadFromR2: read, fetch, now });
    expect(result.source).toMatchObject({ kind: "r2", verifiedSubjectAccountId: "account.subject" });
    expect(result.encounters[0]).toMatchObject({ targetAccountId: "account.enemy", nicknameAtMatch: "Enemy" });
    expect(read).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves a nickname to the official participant account and validates the telemetry asset", async () => {
    process.env.PUBG_API_KEY = "test-key";
    const fetch = vi.fn(async (input: URL | RequestInfo) => { const url = String(input); return url.includes("/matches/")
      ? new Response(JSON.stringify(upstreamMatch()), { status: 200 })
      : new Response(JSON.stringify([
        { _T: "LogMatchDefinition", MatchId: "match.bro.official.pc-2018-15.steam.region.lobby.2026.08.27.00.match-1" },
        ...events,
      ]), { status: 200 }); });
    const result = await loadDeathEncounters({ matchId: "match-1", platform: "steam", nickname: "Me" }, { downloadFromR2: async () => null, fetch, now });
    expect(result.source).toMatchObject({ kind: "upstream", verifiedSubjectAccountId: "account.subject", verifiedSubjectNicknameAtMatch: "Me" });
    expect(result.encounters).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the supplied subject account is not an official participant", async () => {
    const error = await loadDeathEncounters({ matchId: "match-1", platform: "steam", subjectAccountId: "account.other" }, {
      downloadFromR2: async () => null,
      loadVerifiedUpstreamTelemetry: async () => ({ subjectAccountId: "account.subject", events }),
      now,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(DeathEncounterSourceError);
    expect((error as DeathEncounterSourceError).code).toBe("PUBG_DEATH_ENCOUNTER_INVALID_INPUT");
  });

  it("does not accept a pseudonymous public account key", async () => {
    const error = await loadDeathEncounters({ matchId: "match-1", platform: "steam", subjectAccountId: "a".repeat(32) }, { now }).catch((caught) => caught);
    expect(error).toBeInstanceOf(DeathEncounterSourceError);
    expect((error as DeathEncounterSourceError).status).toBe(400);
  });
});
