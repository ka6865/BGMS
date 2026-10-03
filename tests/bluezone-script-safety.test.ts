import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), download: vi.fn(), upload: vi.fn(), write: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  from: mocks.from,
  storage: { from: () => ({ download: mocks.download, upload: mocks.upload }) },
}) }));
vi.mock("fs", () => ({ default: { existsSync: () => false, writeFileSync: mocks.write } }));
vi.mock("dotenv", () => ({ default: { config: vi.fn() } }));

function table(data: unknown, error: unknown = null) {
  const chain = { select: () => chain, eq: () => chain,
    maybeSingle: async () => ({ data, error }),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve) };
  return chain;
}

describe("bluezone maintenance safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.download.mockResolvedValue({ data: new Blob(["[]"]), error: null });
    mocks.upload.mockResolvedValue({ error: null });
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

  it("bounds expired match attempts, uses the stored platform, and acknowledges upload failures", async () => {
    const matches = Array.from({ length: 151 }, (_, i) => ({ match_id: `m${i}`, platform: "kakao", mapName: "에란겔" }));
    mocks.from.mockImplementation(name => table(name === "processed_match_telemetry" ? matches : null));
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response("", { status: 404 }));
    mocks.upload.mockResolvedValueOnce({ error: { message: "upload denied" } });
    const { extractSimulatorData } = await import("../scripts/extract_bluezone");
    await expect(extractSimulatorData()).rejects.toThrow("bluezone-storage-upload-failed");
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
});
