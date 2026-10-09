import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), download: vi.fn(), upload: vi.fn(), write: vi.fn(), archive: vi.fn() }));
vi.mock("../lib/pubg-analysis/bluezoneArchive", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/pubg-analysis/bluezoneArchive")>(), readBluezoneArchive: mocks.archive,
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  from: mocks.from,
  storage: { from: () => ({ download: mocks.download, upload: mocks.upload }) },
}) }));
vi.mock("fs", () => ({ default: { existsSync: () => false, writeFileSync: mocks.write } }));
vi.mock("dotenv", () => ({ default: { config: vi.fn() } }));

function table(data: unknown, error: unknown = null) {
  const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
    maybeSingle: async () => ({ data, error }),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve) };
  return chain;
}

describe("bluezone maintenance safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.download.mockResolvedValue({ data: new Blob(["[]"]), error: null });
    mocks.upload.mockResolvedValue({ error: null });
    mocks.archive.mockResolvedValue({ events: [], source: "missing" });
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("does not replace the stored dataset after an existing-data or DB read failure", async () => {
    const { extractSimulatorData } = await import("../scripts/extract_bluezone");
    mocks.download.mockResolvedValueOnce({ data: null, error: { statusCode: "500" } });
    await expect(extractSimulatorData()).rejects.toThrow("bluezone-existing-data-unavailable");
    mocks.from.mockReturnValue(table(null, { message: "db unavailable" }));
    await expect(extractSimulatorData()).rejects.toThrow("bluezone-match-list-read-failed");
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("bounds expired match attempts, uses the stored platform, and avoids replacing unchanged data", async () => {
    const matches = Array.from({ length: 151 }, (_, i) => ({ match_id: `m${i}`, platform: "kakao", mapName: "에란겔" }));
    mocks.from.mockImplementation(name => table(name === "processed_match_telemetry" ? matches : null));
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response("", { status: 404 }));
    const { extractSimulatorData } = await import("../scripts/extract_bluezone");
    const summary = await extractSimulatorData();
    expect(summary.sources.notFound).toBe(150);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(150);
    expect(fetchMock).toHaveBeenCalledWith("https://api.pubg.com/shards/kakao/matches/m0", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("stops immediately on a PUBG rate limit without uploading a replacement", async () => {
    mocks.from.mockImplementation(name => table(name === "processed_match_telemetry"
      ? [{ match_id: "m", platform: "steam", mapName: "에란겔" }] : null));
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 429 }));
    const { extractSimulatorData } = await import("../scripts/extract_bluezone");
    await expect(extractSimulatorData()).rejects.toThrow("bluezone-pubg-rate-limited");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("extracts a stored old game without PUBG and supports a write-free limited dry run", async () => {
    const matches = [{ match_id: "m", platform: "steam", mapName: "에란겔" }, { match_id: "m", platform: "steam", mapName: "에란겔" }];
    mocks.from.mockImplementation(name => table(name === "processed_match_telemetry" ? matches : { storage_path: "stored" }));
    mocks.archive.mockResolvedValue({ source: "legacy", events: [{ _T: "LogGameStatePeriodic", _D: "2026-07-01T00:00:00Z", gameState: { safetyZoneRadius: 400000, safetyZonePosition: { x: 300000, y: 300000 } } }] });
    const { extractSimulatorData } = await import("../scripts/extract_bluezone");
    const result = await extractSimulatorData({ dryRun: true, limit: 1 });
    expect(result).toMatchObject({ dryRun: true, attemptedCount: 1, processedCount: 1, finalCount: 1, sources: { legacy: 1, upstream: 0 } });
    expect(mocks.archive).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("does not change the local file after a storage upload failure", async () => {
    mocks.from.mockImplementation(name => table(name === "processed_match_telemetry" ? [{ match_id: "m", platform: "steam", mapName: "에란겔" }] : null));
    mocks.archive.mockResolvedValue({ source: "shared", events: [{ _T: "LogGameStatePeriodic", gameState: { safetyZoneRadius: 400000, safetyZonePosition: { x: 300000, y: 300000 } } }] });
    mocks.upload.mockResolvedValueOnce({ error: { message: "upload denied" } });
    const { extractSimulatorData } = await import("../scripts/extract_bluezone");
    await expect(extractSimulatorData()).rejects.toThrow("bluezone-storage-upload-failed");
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("does not overwrite stored data when the archive is unavailable", async () => {
    mocks.from.mockImplementation(name => table(name === "processed_match_telemetry" ? [{ match_id: "m", platform: "steam", mapName: "에란겔" }] : null));
    mocks.archive.mockRejectedValue(new Error("request failed secret=https://private.example"));
    const { extractSimulatorData } = await import("../scripts/extract_bluezone");
    await expect(extractSimulatorData()).rejects.toThrow("bluezone-archive-read-failed");
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("keeps the entire existing dataset when another game succeeded before an upstream failure", async () => {
    mocks.download.mockResolvedValue({ data: new Blob([JSON.stringify([{ matchId: "old", mapName: "Baltic_Main", phases: [{ phase: 1, x: 1, y: 1, radius: 1 }] }])]), error: null });
    mocks.from.mockImplementation(name => table(name === "processed_match_telemetry"
      ? ["success", "failure"].map(match_id => ({ match_id, platform: "steam", mapName: "에란겔" })) : null));
    mocks.archive.mockResolvedValueOnce({ source: "shared", events: [{ _T: "LogGameStatePeriodic", gameState: { safetyZoneRadius: 400000, safetyZonePosition: { x: 300000, y: 300000 } } }] });
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 503 }));
    const { extractSimulatorData } = await import("../scripts/extract_bluezone");
    await expect(extractSimulatorData()).rejects.toThrow("bluezone-partial-fetch-failure");
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("stops immediately when the telemetry asset returns a rate limit", async () => {
    mocks.from.mockImplementation(name => table(name === "processed_match_telemetry"
      ? [{ match_id: "m", platform: "steam", mapName: "에란겔" }] : null));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "m", relationships: { assets: { data: [{ type: "asset", id: "asset" }] } } }, included: [{ type: "asset", id: "asset", attributes: { URL: "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/10/05/00/00/asset-telemetry.json" } }] })))
      .mockResolvedValueOnce(new Response("", { status: 429 }));
    const { extractSimulatorData } = await import("../scripts/extract_bluezone");
    await expect(extractSimulatorData()).rejects.toThrow("bluezone-pubg-rate-limited");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
