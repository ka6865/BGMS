import { describe, expect, it, vi } from "vitest";
import { createSharedTelemetrySource } from "../lib/pubg-analysis/sharedTelemetrySourceContract";
import { parseBluezoneLegacyEvents, readBluezoneArchive, safeBluezoneErrorCode } from "../lib/pubg-analysis/bluezoneArchive";

const playerKey = "a".repeat(32);
const key = `telemetry-map/v62/steam/m/${playerKey}/lite_analyze.json`;
const events = [{ _T: "LogGameStatePeriodic", gameState: { safetyZoneRadius: 10000 } }];
const envelope = { analyzeFormat: 2, projection: "full", identity: { matchId: "m", platform: "steam", playerKey, mode: "lite", telemetryVersion: 62 }, events };

describe("bluezone archived sources", () => {
  it("does not mistake missing storage credentials for a missing archive", async () => {
    vi.stubEnv("CLOUDFLARE_R2_ENDPOINT", "");
    try { await expect(readBluezoneArchive("m", "steam", key)).rejects.toThrow("r2-credentials-missing"); }
    finally { vi.unstubAllEnvs(); }
  });
  it("binds legacy events to the exact DB path and public identity", () => {
    expect(parseBluezoneLegacyEvents(envelope, key, "m", "steam")).toEqual(events);
    expect(parseBluezoneLegacyEvents(envelope, key, "other", "steam")).toBeNull();
    expect(parseBluezoneLegacyEvents(envelope, key, "m", "kakao")).toBeNull();
    expect(parseBluezoneLegacyEvents({ ...envelope, identity: { ...envelope.identity, playerKey: "b".repeat(32) } }, key, "m", "steam")).toBeNull();
    expect(parseBluezoneLegacyEvents(events, key, "m", "steam")).toBeNull();
    expect(parseBluezoneLegacyEvents(events, key.replace("v62", "v60"), "m", "steam")).toEqual(events);
  });

  it("does not fetch a legacy object from a different match or platform", async () => {
    const download = vi.fn().mockResolvedValue(null);
    expect((await readBluezoneArchive("other", "steam", key, download)).source).toBe("missing");
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("resolves the matching analysis input when master points to the replay map", async () => {
    const download = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify(envelope));
    const result = await readBluezoneArchive("m", "steam", key.replace("_analyze", ""), download);
    expect(result.source).toBe("legacy");
    expect(download).toHaveBeenNthCalledWith(2, key);
    expect(parseBluezoneLegacyEvents({ ...envelope, identity: { ...envelope.identity, telemetryVersion: 9999 } }, key.replace("v62", "v9999"), "m", "steam")).toBeNull();
  });

  it("reads the shared checksum envelope before any personal copy", async () => {
    const data = { data: { id: "m", attributes: { createdAt: "2026-07-01T00:00:00Z", gameMode: "squad", mapName: "Baltic_Main" } }, included: [
      { type: "participant", id: "p", attributes: { stats: { playerId: "account.a", name: "A", kills: 1, damageDealt: 1, winPlace: 1, timeSurvived: 100 } } },
      { type: "roster", id: "r", relationships: { participants: { data: [{ id: "p" }] } } },
    ] };
    const source = createSharedTelemetrySource(data, "steam", [...events, { _T: "LogPlayerPosition", character: { accountId: "account.a" } }]);
    const download = vi.fn().mockResolvedValue(JSON.stringify(source));
    const result = await readBluezoneArchive("m", "steam", key, download);
    expect(result.source).toBe("shared");
    expect(result.events[0]._T).toBe("LogGameStatePeriodic");
    expect(download).toHaveBeenCalledTimes(1);
    const invalid = vi.fn().mockResolvedValue(JSON.stringify({ ...source, checksum: "invalid" }));
    await expect(readBluezoneArchive("m", "steam", key, invalid)).rejects.toThrow("bluezone-shared-source-invalid");
  });

  it("reports whitelisted diagnostic codes without exception secrets", () => {
    expect(safeBluezoneErrorCode(new Error("bluezone-storage-upload-failed"))).toBe("bluezone-storage-upload-failed");
    expect(safeBluezoneErrorCode(new Error("https://private.example token=secret"))).toBe("bluezone-unexpected-failure");
  });
});
