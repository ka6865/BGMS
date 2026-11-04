export type MayhemItemAsset = { id: number; name: string; image: string | null };
export type MayhemItemRating = MayhemItemAsset & { tier: number; isBoots: boolean; components: MayhemItemAsset[] };
export type MayhemItemRatings = { championId: number; patch: string; date: string; version: string; items: MayhemItemRating[] };
export type ParsedMayhemRatings = { championId: number; patch: string; date: string; ratings: Array<{ id: number; tier: number }> };
const PORO_SNAX_IDS = new Set([2052, 220013]);
const invalid = () => new Error("mayhem_items_invalid");
type ItemMetadata = { from?: unknown; into?: unknown; gold?: { purchasable?: unknown } };
export function filterMayhemItemComponents(data: MayhemItemRatings, value: unknown): MayhemItemRatings {
  const items = (value as { data?: Record<string, ItemMetadata> } | null)?.data;
  if (!items || typeof items !== "object" || Array.isArray(items)) throw invalid();
  const components = new Set(Object.values(items).flatMap(item => Array.isArray(item?.from) ? item.from : []));
  return { ...data, items: data.items.filter(item => {
    if (item.isBoots) return true;
    const into = items[String(item.id)]?.into;
    // 이전 저장본은 into가 없으므로 보관된 제작 관계를 사용한다.
    return !(Array.isArray(into) ? into.some(id => typeof id === "string" && items[id]?.gold?.purchasable === true) : components.has(String(item.id)));
  }) };
}
export function parseMayhemItemRatings(value: unknown, championId: number): ParsedMayhemRatings | null {
  const root = value as { data?: unknown; meta?: { query?: unknown; game?: unknown } } | null;
  if (!root || root.meta?.query !== "aram_mayhem_champion" || root.meta.game !== "lol" || !Array.isArray(root.data) || root.data.length > 1) throw invalid();
  if (!root.data.length) return null;
  const row = root.data[0] as { champion_id?: unknown; patch?: unknown; dt?: unknown; data?: { items?: unknown } };
  if (!Number.isSafeInteger(championId) || championId <= 0 || championId > 99999 || row?.champion_id !== String(championId)
    || typeof row.patch !== "string" || !/^[1-9][0-9]?\.[1-9][0-9]?$/.test(row.patch)
    || typeof row.dt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.dt) || !Number.isFinite(Date.parse(row.dt)) || new Date(row.dt).toISOString().slice(0,10) !== row.dt
    || !row.data?.items || typeof row.data.items !== "object" || Array.isArray(row.data.items)) throw invalid();
  const entries = Object.entries(row.data.items); if (entries.length > 500) throw invalid();
  const ratings = entries.map(([key, value]) => {
    const tier = (value as { tier?: unknown } | null)?.tier;
    if (!/^[1-9][0-9]{0,5}$/.test(key) || typeof tier !== "number" || !Number.isInteger(tier) || tier < 1 || tier > 5) throw invalid();
    return { id: Number(key), tier };
  });
  return { championId, patch: row.patch, date: row.dt, ratings };
}
export function withMayhemItemMetadata(parsed: ParsedMayhemRatings, version: string, value: unknown): MayhemItemRatings {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !version.startsWith(`${parsed.patch}.`)) throw invalid();
  const items = (value as { data?: Record<string, { name?: unknown; image?: { full?: unknown }; from?: unknown; tags?: unknown }> } | null)?.data;
  if (!items || typeof items !== "object" || Array.isArray(items) || !Object.keys(items).length) throw invalid();
  const asset = (id: number): MayhemItemAsset => {
    const row = items[String(id)]; const name = row?.name, image = row?.image?.full;
    return { id, name: typeof name === "string" && name.trim() && name.length <= 120 ? name.trim() : `아이템 ${id}`, image: typeof image === "string" && /^[0-9]+\.png$/.test(image) ? image : null };
  };
  return { championId: parsed.championId, patch: parsed.patch, date: parsed.date, version,
    items: parsed.ratings.filter(row => !PORO_SNAX_IDS.has(row.id) && row.id !== 1001).map(row => {
      const from = items[String(row.id)]?.from;
      const components = Array.isArray(from) && from.length <= 8 ? from.filter(id => typeof id === "string" && /^[1-9][0-9]{0,5}$/.test(id) && !PORO_SNAX_IDS.has(Number(id))).map(id => asset(Number(id))) : [];
      const tags = items[String(row.id)]?.tags;
      return { ...asset(row.id), tier: row.tier, isBoots: Array.isArray(tags) && tags.includes("Boots"), components };
    }).sort((a,b) => a.tier - b.tier || a.name.localeCompare(b.name,"ko")),
  };
}
