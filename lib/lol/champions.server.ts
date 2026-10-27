import "server-only";
import { getLolDataDragonVersion } from "./dataDragon.server";
import { LOL_CHAMPION_TAGS, type LolChampion, type LolChampionTag } from "./champions";

const TTL_MS = 6 * 60 * 60_000;
const MAX_BYTES = 4 * 1024 * 1024;
let cached: { version: string; champions: LolChampion[]; expiresAt: number } | undefined;
let inflight: Promise<{ version: string; champions: LolChampion[] } | null> | undefined;

const imageIdPattern = /^[A-Za-z0-9]{1,40}$/;
const tags = new Set<string>(LOL_CHAMPION_TAGS);

// Data Dragon champion.json의 형식이 바뀌어도 화면에 깨진 값이 나가지 않도록 필요한 필드만 검사해 고른다.
export function parseLolChampions(json: unknown): LolChampion[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object") return [];
  const champions: LolChampion[] = [];
  for (const entry of Object.values(data as Record<string, unknown>)) {
    const item = entry as { id?: unknown; key?: unknown; name?: unknown; title?: unknown; tags?: unknown };
    const key = Number(item.key);
    if (typeof item.id !== "string" || !imageIdPattern.test(item.id) || typeof item.key !== "string" || !Number.isSafeInteger(key) || key <= 0
      || typeof item.name !== "string" || !item.name.trim() || item.name.length > 40) continue;
    champions.push({
      id: key,
      imageId: item.id,
      name: item.name.trim(),
      title: typeof item.title === "string" ? item.title.trim().slice(0, 60) : "",
      tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is LolChampionTag => typeof tag === "string" && tags.has(tag)) : [],
    });
  }
  return champions.sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

export async function getLolChampions(): Promise<{ version: string; champions: LolChampion[] } | null> {
  const version = await getLolDataDragonVersion();
  if (cached && cached.version === version && cached.expiresAt > Date.now()) return cached;
  if (inflight) return inflight;
  const request = (async () => {
    try {
      const response = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/champion.json`, {
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok || Number(response.headers.get("Content-Length")) > MAX_BYTES) {
        await response.body?.cancel();
        throw new Error("invalid_champion_response");
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_BYTES) throw new Error("champion_response_too_large");
      const champions = parseLolChampions(JSON.parse(new TextDecoder().decode(bytes)));
      if (!champions.length) throw new Error("empty_champion_list");
      cached = { version, champions, expiresAt: Date.now() + TTL_MS };
      return cached;
    } catch {
      console.warn("[lol-champions] fallback", { reasonCode: "champion_list_unavailable" });
      // 새 버전을 못 받으면 이전 버전 목록이라도 보여 준다.
      return cached ?? null;
    }
  })();
  inflight = request;
  try { return await request; } finally { if (inflight === request) inflight = undefined; }
}
