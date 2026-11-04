import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { downloadMayhemDataset } from "../lib/lol/mayhemDataset";

vi.mock("server-only", () => ({}));

const INDEX_URL = "https://arammayhem.com/data/v1/index.json";
const AUGMENTS_URL = "https://arammayhem.com/data/v1/latest/augments.json";
const COMBOS_URL = "https://arammayhem.com/data/v1/latest/combos.json";
const RELEASE_ID = "website:20261102_212843:71dfaa9991cd";
const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
const ATTRIBUTION = "Data: arammayhem.com";

function documents() {
  return {
    index: {
      schemaVersion: 1,
      apiVersion: "v1",
      releaseId: RELEASE_ID,
      generatedAt: "2026-11-03T05:28:43Z",
      latestPatch: "26.21",
      license: { name: "CC BY 4.0", url: LICENSE_URL, attribution: ATTRIBUTION,
        attributionUrl: "https://arammayhem.com/", terms: "https://arammayhem.com/data/" },
      latest: { folder: "latest", patch: "26.21", files: {
        augments: { json: AUGMENTS_URL }, combos: { json: COMBOS_URL },
      } },
      patches: [{ patch: "26.21", statsDate: "2026-11-02", statsDateSource: "release" }],
    },
    augments: {
      schemaVersion: 1,
      attribution: ATTRIBUTION,
      source: "https://arammayhem.com/data/",
      license: "CC BY 4.0: free to use, copy and republish, including commercially, with attribution.",
      licenseUrl: LICENSE_URL,
      meta: { patch: "26.21", statsDate: "2026-11-02", statsDateSource: "release", releaseId: RELEASE_ID },
      rows: [
        { augmentId: "infernal_conduit", pickRate: 42.5, pickRateRank: 1 },
        { augmentId: "marksmage", pickRate: null, pickRateRank: null },
        { augmentId: "bees!!!", pickRate: 0, pickRateRank: 3 },
      ],
    },
    combos: {
      schemaVersion: 1,
      attribution: ATTRIBUTION,
      source: "https://arammayhem.com/data/",
      license: "CC BY 4.0: free to use, copy and republish, including commercially, with attribution.",
      licenseUrl: LICENSE_URL,
      meta: { releaseId: RELEASE_ID },
      rows: [
        { comboId: 1, championId: "Brand", augmentIds: ["infernal_conduit"], types: ["god"],
          url: "https://arammayhem.com/combo/brand-infernal-conduit/" },
        { comboId: 2, championId: "Neeko", augmentIds: ["void_rift", "dont_blink"], types: [],
          url: "https://arammayhem.com/combo/neeko-void-rift-588/" },
      ],
    },
  };
}

function response(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
}

function fetcherFor(values: Response[]) {
  let cursor = 0;
  return vi.fn<typeof fetch>(async () => {
    const next = values[cursor++];
    if (!next) throw new Error("unexpected request");
    return next;
  });
}

function responses(input = documents(), secondIndex = input.index) {
  return [response(input.index, { etag: '"index-v1"' }), response(input.augments), response(input.combos), response(secondIndex)];
}

describe("arammayhem Mayhem dataset downloader", () => {
  it("returns bounded raw files, hashes, whole-dataset rates and source metadata", async () => {
    const fetcher = fetcherFor(responses());
    const result = await downloadMayhemDataset(fetcher);

    expect(result).toMatchObject({
      releaseId: RELEASE_ID,
      rates: [
        { externalId: "infernal_conduit", pickRate: 42.5, pickRateRank: 1, sourcePatch: "26.21" },
        { externalId: "marksmage", pickRate: null, pickRateRank: null, sourcePatch: "26.21" },
        { externalId: "bees!!!", pickRate: 0, pickRateRank: 3, sourcePatch: "26.21" },
      ],
      metadata: { sourceStatsDate: "2026-11-02", sourcePatch: "26.21", statsDateSource: "release",
        license: "CC BY 4.0", attribution: ATTRIBUTION },
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([INDEX_URL, AUGMENTS_URL, COMBOS_URL, INDEX_URL]);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === "error" && init.signal instanceof AbortSignal)).toBe(true);
    for (const raw of Object.values(result.raw)) {
      expect(raw.hash).toBe(createHash("sha256").update(raw.body).digest("hex"));
      expect(Buffer.byteLength(raw.body, "utf8")).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
    expect(result.raw.index.etag).toBe('"index-v1"');
    expect(result.raw.combos.lastModified).toBeNull();
    expect(result.batchHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps combo augment arrays intact and does not invent per-combo patch or date fields", async () => {
    const result = await downloadMayhemDataset(fetcherFor(responses()));
    expect(result.combos[1]).toEqual({ comboId: 2, championId: "Neeko", augmentIds: ["void_rift", "dont_blink"],
      types: [], sourceUrl: "https://arammayhem.com/combo/neeko-void-rift-588/" });
    expect(result.combos[1]).not.toHaveProperty("sourcePatch");
    expect(result.combos[1]).not.toHaveProperty("statsDate");
  });

  it("원본의 15개 증강 편집 묶음을 나누거나 누락하지 않는다", async () => {
    const input = documents();
    input.combos.rows[0].augmentIds = Array.from({ length: 15 }, (_, index) => `group_${index}`);
    const result = await downloadMayhemDataset(fetcherFor(responses(input)));
    expect(result.combos[0].augmentIds).toEqual(input.combos.rows[0].augmentIds);
  });

  it("does not change batchHash when index confirmation timestamps change", async () => {
    const first = documents();
    const second = documents();
    first.index.generatedAt = "2026-11-03T05:28:43Z";
    second.index.generatedAt = "2026-11-04T05:28:43Z";
    const left = await downloadMayhemDataset(fetcherFor(responses(first)));
    const right = await downloadMayhemDataset(fetcherFor(responses(second)));
    expect(left.batchHash).toBe(right.batchHash);
    expect(left.raw.index.hash).not.toBe(right.raw.index.hash);
  });

  it("rejects mismatched source release IDs", async () => {
    const input = documents();
    input.combos.meta.releaseId = "website:other-release";
    await expect(downloadMayhemDataset(fetcherFor(responses(input)))).rejects.toThrow("source_release_mismatch");
  });

  it("rejects an index release change during the read", async () => {
    const input = documents();
    const secondIndex = { ...input.index, releaseId: "website:changed" };
    await expect(downloadMayhemDataset(fetcherFor(responses(input, secondIndex)))).rejects.toThrow("source_release_mismatch");
  });

  it("rejects duplicate IDs and out-of-range rates", async () => {
    const duplicate = documents();
    duplicate.augments.rows.push({ augmentId: "infernal_conduit", pickRate: 10, pickRateRank: 2 });
    await expect(downloadMayhemDataset(fetcherFor(responses(duplicate)))).rejects.toThrow("source_invalid_schema");

    const badRate = documents();
    badRate.augments.rows[0]!.pickRate = 100.01;
    await expect(downloadMayhemDataset(fetcherFor(responses(badRate)))).rejects.toThrow("source_invalid_schema");

    for (const pickRateRank of [0, 1.5]) {
      const badRank = documents();
      badRank.augments.rows[0]!.pickRateRank = pickRateRank;
      await expect(downloadMayhemDataset(fetcherFor(responses(badRank)))).rejects.toThrow("source_invalid_schema");
    }

    const duplicateCombo = documents();
    duplicateCombo.combos.rows[1]!.comboId = duplicateCombo.combos.rows[0]!.comboId;
    await expect(downloadMayhemDataset(fetcherFor(responses(duplicateCombo)))).rejects.toThrow("source_invalid_schema");
  });

  it("rejects forbidden and oversized responses without retrying", async () => {
    const forbidden = fetcherFor([new Response("forbidden", { status: 403 })]);
    await expect(downloadMayhemDataset(forbidden)).rejects.toThrow("source_forbidden");
    expect(forbidden).toHaveBeenCalledTimes(1);

    const oversized = fetcherFor([new Response(" ".repeat(4 * 1024 * 1024 + 1), {
      headers: { "content-type": "application/json" },
    })]);
    await expect(downloadMayhemDataset(oversized)).rejects.toThrow("source_too_large");
    expect(oversized).toHaveBeenCalledTimes(1);
  });

  it("rejects HTML, malformed JSON, unsafe IDs, and cross-host combo URLs", async () => {
    const html = fetcherFor([new Response("<html></html>", { headers: { "content-type": "text/html" } })]);
    await expect(downloadMayhemDataset(html)).rejects.toThrow("source_content_type");

    const invalidJson = fetcherFor([new Response("<html>", { headers: { "content-type": "application/json" } })]);
    await expect(downloadMayhemDataset(invalidJson)).rejects.toThrow("source_invalid_json");

    const badId = documents();
    badId.augments.rows[0]!.augmentId = "__proto__";
    await expect(downloadMayhemDataset(fetcherFor(responses(badId)))).rejects.toThrow("source_invalid_schema");

    const unsafeKey = documents();
    Object.defineProperty(unsafeKey.combos.rows[0], "__proto__", { value: "unsafe", enumerable: true });
    await expect(downloadMayhemDataset(fetcherFor(responses(unsafeKey)))).rejects.toThrow("source_invalid_schema");

    const badLicense = documents();
    badLicense.augments.license = "<p>CC BY 4.0</p>";
    await expect(downloadMayhemDataset(fetcherFor(responses(badLicense)))).rejects.toThrow("source_invalid_schema");

    const badUrl = documents();
    badUrl.combos.rows[0]!.url = "https://example.com/combo/brand/";
    await expect(downloadMayhemDataset(fetcherFor(responses(badUrl)))).rejects.toThrow("source_invalid_schema");
  });
});
