import { beforeEach, describe, expect, it, vi } from "vitest";
const { download, create } = vi.hoisted(() => ({ download: vi.fn(), create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/pubg-analysis/r2Service", () => ({ downloadFromR2: download, uploadRecoveryObjectToR2: create }));
import { buildSharedTelemetrySourceKey, parseSharedTelemetrySource, readSharedTelemetrySource, writeSharedTelemetrySource } from "@/lib/pubg-analysis/sharedTelemetrySource";
import { inspectDeletionKey } from "@/lib/pubg-analysis/r2DeletionGuard";

const matchData = {
  data: { id: "match-shared", attributes: { createdAt: "2026-08-01T00:00:00Z", mapId: "Baltic_Main", gameMode: "squad", matchType: "official", duration: 600 } },
  included: [
    ...["A", "B"].map((name) => ({ id: `p-${name}`, type: "participant", attributes: { stats: { name, playerId: `account.${name}`, kills: 1, damageDealt: 100, winPlace: 2, timeSurvived: 500 } } })),
    { id: "roster-team", type: "roster", relationships: { participants: { data: [{ id: "p-A" }, { id: "p-B" }] } } },
  ],
};
const events = ["A", "B"].flatMap((name) => Array.from({ length: 20 }, (_, i) => ({
  _T: "LogPlayerPosition", _D: new Date(Date.parse("2026-08-01T00:00:00Z") + i * 1000).toISOString(),
  character: { name, accountId: `account.${name}`, location: { x: i, y: 1, z: 0 } },
})));

beforeEach(() => { vi.clearAllMocks(); download.mockResolvedValue(null); create.mockResolvedValue({ etag: "etag" }); });
async function saved() {
  await writeSharedTelemetrySource(matchData, "steam", events);
  return JSON.parse(create.mock.calls[0][1]);
}

describe("one shared PUBG event source per game", () => {
  it("keeps official attributes, every participant and every position, independent of player or replay mode", async () => {
    const value = await saved();
    expect(create.mock.calls[0][0]).toBe("telemetry-source/v1/steam/match-shared.json");
    expect(value.matchData).toEqual(matchData);
    expect(value.events).toHaveLength(40);
    expect(value).not.toHaveProperty("identity.playerKey");
    expect(parseSharedTelemetrySource(value, "match-shared", "steam")).toEqual(value);
    expect(inspectDeletionKey(create.mock.calls[0][0])).toEqual({ allowed: false, reason: "protected-pattern" });
  });
  it("concurrent A and B requests converge on the winner without overwriting it", async () => {
    const winner = await saved(); create.mockClear();
    download.mockResolvedValue(JSON.stringify(winner));
    create.mockRejectedValue(Object.assign(new Error("already exists"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } }));
    await expect(Promise.all([writeSharedTelemetrySource(matchData, "steam", events), writeSharedTelemetrySource(matchData, "steam", events)])).resolves.toEqual([undefined, undefined]);
    expect(new Set(create.mock.calls.map((call) => call[0])).size).toBe(1);
  });
  it.each(["platform", "match", "checksum", "version", "events", "metadata"])("rejects corrupted or differently bound %s", async (kind) => {
    const source = await saved();
    if (kind === "platform") source.platform = "kakao";
    if (kind === "match") source.matchId = "another-match";
    if (kind === "checksum") source.checksum = "0".repeat(64);
    if (kind === "version") source.filterVersion = 100;
    if (kind === "events") source.events[0].character.accountId = "another-player";
    if (kind === "metadata") source.matchData.included[0].attributes.stats.kills = 99;
    download.mockResolvedValue(JSON.stringify(source));
    expect(await readSharedTelemetrySource("match-shared", "steam")).toBeNull();
  });
  it.each(["missing-stats", "missing-roster", "duplicate-account", "duplicate-roster-ref", "missing-evidence"])("does not archive incomplete official evidence: %s", async (kind) => {
    const value = structuredClone(matchData);
    let input = events;
    if (kind === "missing-stats") delete (value.included[0] as any).attributes.stats.kills;
    if (kind === "missing-roster") value.included.pop();
    if (kind === "duplicate-account") (value.included[1] as any).attributes.stats.playerId = "account.A";
    if (kind === "duplicate-roster-ref") (value.included[2] as any).relationships.participants.data.push({ id: "p-A" });
    if (kind === "missing-evidence") input = events.map((event) => ({ ...event, character: { ...event.character, accountId: "unrelated" } }));
    await expect(writeSharedTelemetrySource(value, "steam", input)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it("malformed existing source and ambiguous upload failure are never treated as successful retention", async () => {
    create.mockRejectedValue(Object.assign(new Error("exists"), { $metadata: { httpStatusCode: 412 } }));
    download.mockResolvedValue("malformed");
    await expect(writeSharedTelemetrySource(matchData, "steam", events)).rejects.toThrow("conflict-invalid");
    create.mockRejectedValue(new Error("connection lost"));
    await expect(writeSharedTelemetrySource(matchData, "steam", events)).rejects.toThrow("connection lost");
  });
  it("unsafe identifiers cannot choose arbitrary R2 keys", () => {
    expect(() => buildSharedTelemetrySourceKey("../other", "steam")).toThrow();
    expect(() => buildSharedTelemetrySourceKey("match-shared", "console" as any)).toThrow();
  });
});
