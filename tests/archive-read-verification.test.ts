import { describe, expect, it } from "vitest";
import { selectArchivePair, recalculateArchive, recalculateReplayPayload, assertReplayMatchesRecalculation } from "../scripts/verify_archived_match_reads";
import { createSharedTelemetrySource } from "../lib/pubg-analysis/sharedTelemetrySourceContract";

const now = Date.parse("2026-10-05T00:00:00Z");
const row = { match_id: "m", platform: "steam", player_id: "A", account_id: "account.A", played_at: "2026-10-04T00:00:00Z" };

describe("real archive verification boundaries", () => {
  it("selects two distinct public accounts from the same recent game", () => {
    const b = { ...row, player_id: "B", account_id: "account.B" };
    expect(selectArchivePair([row, row, b], [], now)).toEqual([row, b]);
    expect(selectArchivePair([row, b], [{ platform: "steam", account_id: "account.B" }], now)).toEqual([]);
    expect(selectArchivePair([row, { ...b, platform: "kakao" }], [], now)).toEqual([]);
    expect(selectArchivePair([row, { ...b, played_at: "2026-08-01T00:00:00Z" }], [], now)).toEqual([]);
  });

  it("recalculates A and B directly from one verified source without PUBG", () => {
    const included = ["A", "B"].map(name => ({ type: "participant", id: name, attributes: { stats: { playerId: `account.${name}`, name, kills: 1, damageDealt: 100, winPlace: 1, timeSurvived: 60 } } }));
    const data = { data: { id: "m", attributes: { gameMode: "squad", mapName: "Baltic_Main", createdAt: "2026-10-04T00:00:00Z" } }, included: [...included, { type: "roster", id: "r", relationships: { participants: { data: [{ id: "A" }, { id: "B" }] } } }] };
    const events = ["A", "B"].flatMap(name => [{ _T: "LogPlayerPosition", _D: "2026-10-04T00:00:01Z", character: { name, accountId: `account.${name}`, teamId: 1, location: { x: 1000, y: 1000, z: 1000 } } }]);
    const source = createSharedTelemetrySource(data, "steam", events);
    expect(recalculateArchive(source, "account.A").mapData?.events.length).toBeGreaterThan(0);
    expect(recalculateArchive(source, "account.B").mapData?.events.length).toBeGreaterThan(0);
    expect(() => recalculateArchive(source, "account.C")).toThrow("archive-verification-participant-missing");
    for (const accountId of ["account.A", "account.B"]) {
      const expected = recalculateReplayPayload(source, accountId);
      expect(() => assertReplayMatchesRecalculation(expected, structuredClone(expected))).not.toThrow();
      expect(() => assertReplayMatchesRecalculation(expected, { ...expected, mapName: "Desert_Main" })).toThrow("archive-verification-replay-content-mismatch");
      const changed = structuredClone(expected);
      (changed.events[0] as Record<string, unknown>).x = -1;
      expect(changed.events).toHaveLength(expected.events.length);
      expect(() => assertReplayMatchesRecalculation(expected, changed)).toThrow("archive-verification-replay-content-mismatch");
    }
    const mapIdOnly = structuredClone(data);
    delete (mapIdOnly.data.attributes as { mapName?: string }).mapName;
    Object.assign(mapIdOnly.data.attributes, { mapId: "Baltic_Main" });
    expect(recalculateReplayPayload(createSharedTelemetrySource(mapIdOnly, "steam", events), "account.A").mapName).toBe("Erangel");
  });
});
