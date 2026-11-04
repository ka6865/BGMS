import "server-only";
import { unstable_cache } from "next/cache";
import { filterMayhemItemComponents, parseMayhemItemRatings, withMayhemItemMetadata, type MayhemItemRatings } from "./mayhemItems";
import { getPublicReference, referencePublicEnabled } from "./mayhemReferenceStore.server";

async function json(url: string, maxBytes: number): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("mayhem_items_unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new Error("mayhem_items_oversize"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const versions = unstable_cache(async () => {
  const value = await json("https://ddragon.leagueoflegends.com/api/versions.json", 128 * 1024);
  if (!Array.isArray(value) || value.length > 1000) throw new Error("mayhem_items_version_invalid");
  return value.filter((v): v is string => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v));
}, ["lol-mayhem-item-versions"], { revalidate: 3600 });

const metadata = unstable_cache(async (version: string) => json(
  `https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/item.json`, 4 * 1024 * 1024,
), ["lol-mayhem-item-metadata"], { revalidate: 21600 });

const ratings = unstable_cache(async (championId: number): Promise<MayhemItemRatings | null> => {
  const raw = await json(`https://data.v2.iesdev.com/api/v1/query_objects/prod/lol/aram_mayhem_champion?champion_id=${championId}`, 1024 * 1024);
  const parsed = parseMayhemItemRatings(raw, championId);
  if (!parsed) return null;
  const version = (await versions()).find(version => version.startsWith(`${parsed.patch}.`));
  if (!version) throw new Error("mayhem_items_version_unavailable");
  const official = await metadata(version);
  return filterMayhemItemComponents(withMayhemItemMetadata(parsed, version, official), official);
}, ["lol-mayhem-item-ratings-v5-no-components"], { revalidate: 21600 });

export async function getMayhemItemRatings(championId: number): Promise<MayhemItemRatings | null> {
  if (!Number.isSafeInteger(championId) || championId < 1 || championId > 99999) throw new Error("invalid_champion_id");
  if (referencePublicEnabled()) return getPublicReference("item_ratings", undefined, championId);
  return ratings(championId);
}
