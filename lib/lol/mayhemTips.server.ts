import "server-only";
import { unstable_cache } from "next/cache";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { classifyLolItems } from "./championStats";
import { MAYHEM_TIP_LIMITS, type MayhemTip, type MayhemTipInput, type MayhemTipItem } from "./mayhemTips";

const signal = () => AbortSignal.timeout(10_000);
const columns = "id,champion_id,augment_ids,item_ids,summary,usage,created_at";
type Row = { id: number; champion_id: number | null; augment_ids: number[]; item_ids: number[]; summary: string; usage: string; created_at: string };
const toTip = (row: Row): MayhemTip => ({ id: row.id, championId: row.champion_id, augmentIds: row.augment_ids, itemIds: row.item_ids, summary: row.summary, usage: row.usage, createdAt: row.created_at });

// 칼바람 맵(12)에서 살 수 있는 완성 아이템과 신발만 제보에 고를 수 있다.
export const getMayhemTipItems = unstable_cache(async (version: string): Promise<MayhemTipItem[]> => {
  const response = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/item.json`, { cache: "no-store", redirect: "error", signal: signal() });
  if (!response.ok) throw new Error("mayhem_tip_items_unavailable");
  const json = await response.json() as { data?: Record<string, { name?: string; image?: { full?: string }; maps?: Record<string, boolean> }> };
  const meta = classifyLolItems(json);
  return Object.entries(json.data ?? {}).flatMap(([key, item]) => {
    const id = Number(key), kind = meta[id];
    if (!kind || !(kind.final || kind.boots) || item.maps?.["12"] !== true || !item.name || !item.image?.full) return [];
    return [{ id, name: item.name.replace(/<[^>]*>/g, ""), image: item.image.full, boots: kind.boots }];
  }).sort((a, b) => Number(a.boots) - Number(b.boots) || a.name.localeCompare(b.name, "ko"));
}, ["lol-mayhem-tip-items-v1"], { revalidate: 21600 });

export async function listMayhemTips(patch: string, champion: number | "common" | null, offset: number): Promise<{ rows: MayhemTip[]; total: number }> {
  let query = createServiceRoleSupabase().from("lol_mayhem_combo_tips").select(columns, { count: "exact" })
    .eq("status", "published").eq("client_patch", patch);
  if (champion === "common") query = query.is("champion_id", null);
  else if (champion !== null) query = query.eq("champion_id", champion);
  const { data, error, count } = await query.order("created_at", { ascending: false }).range(offset, offset + MAYHEM_TIP_LIMITS.pageSize - 1).abortSignal(signal());
  if (error) throw new Error("mayhem_tips_unavailable");
  return { rows: (data as Row[]).map(toTip), total: count ?? 0 };
}

export async function createMayhemTip(userId: string, patch: string, input: MayhemTipInput): Promise<MayhemTip | "daily_limit"> {
  const db = createServiceRoleSupabase();
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const recent = await db.from("lol_mayhem_combo_tips").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", since).abortSignal(signal());
  if (recent.error) throw new Error("mayhem_tips_unavailable");
  if ((recent.count ?? 0) >= MAYHEM_TIP_LIMITS.dailyPerUser) return "daily_limit";
  const { data, error } = await db.from("lol_mayhem_combo_tips").insert({
    user_id: userId, client_patch: patch, champion_id: input.championId, augment_ids: input.augmentIds, item_ids: input.itemIds, summary: input.summary, usage: input.usage,
  }).select(columns).abortSignal(signal()).single();
  if (error || !data) throw new Error("mayhem_tips_unavailable");
  return toTip(data as Row);
}
