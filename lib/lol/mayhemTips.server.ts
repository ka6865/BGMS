import "server-only";
import { unstable_cache } from "next/cache";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { classifyLolItems } from "./championStats";
import { MAYHEM_TIP_LIMITS, type MayhemTip, type MayhemTipInput, type MayhemTipItem, type MayhemTipSort } from "./mayhemTips";

const signal = () => AbortSignal.timeout(10_000);
const table = "lol_mayhem_combo_tips";
const columns = "id,user_id,champion_id,augment_ids,item_ids,summary,usage,anonymous,up_count,down_count,created_at,updated_at";
type Row = { id: number; user_id: string; champion_id: number | null; augment_ids: number[]; item_ids: number[]; summary: string; usage: string; anonymous: boolean; up_count: number; down_count: number; created_at: string; updated_at: string | null };

// 작성자 ID는 화면에 내보내지 않고 닉네임·본인 여부·내 표로만 바꾼다.
async function toTips(rows: Row[], viewer: string | null): Promise<MayhemTip[]> {
  const db = createServiceRoleSupabase();
  const named = [...new Set(rows.filter(row => !row.anonymous).map(row => row.user_id))];
  const [profiles, votes] = await Promise.all([
    named.length ? db.from("profiles").select("id,nickname").in("id", named).abortSignal(signal()) : { data: [], error: null },
    viewer && rows.length ? db.from("lol_mayhem_combo_tip_votes").select("tip_id,value").eq("user_id", viewer).in("tip_id", rows.map(row => row.id)).abortSignal(signal()) : { data: [], error: null },
  ]);
  if (profiles.error || votes.error) throw new Error("mayhem_tips_unavailable");
  const nicknames = new Map((profiles.data as { id: string; nickname: string | null }[]).map(p => [p.id, p.nickname?.trim() || null]));
  const myVotes = new Map((votes.data as { tip_id: number; value: number }[]).map(v => [v.tip_id, v.value]));
  return rows.map(row => ({
    id: row.id, championId: row.champion_id, augmentIds: row.augment_ids, itemIds: row.item_ids, summary: row.summary, usage: row.usage,
    anonymous: row.anonymous, author: row.anonymous ? null : nicknames.get(row.user_id) ?? null, up: row.up_count, down: row.down_count,
    myVote: (myVotes.get(row.id) ?? 0) as -1 | 0 | 1, mine: row.user_id === viewer, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

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

export async function listMayhemTips(patch: string, champion: number | "common" | null, sort: MayhemTipSort, offset: number, viewer: string | null): Promise<{ rows: MayhemTip[]; total: number }> {
  let query = createServiceRoleSupabase().from(table).select(columns, { count: "exact" }).eq("status", "published").eq("client_patch", patch);
  if (champion === "common") query = query.is("champion_id", null);
  else if (champion !== null) query = query.eq("champion_id", champion);
  if (sort === "top") query = query.order("score", { ascending: false });
  const { data, error, count } = await query.order("created_at", { ascending: false }).order("id", { ascending: false })
    .range(offset, offset + MAYHEM_TIP_LIMITS.pageSize - 1).abortSignal(signal());
  if (error) throw new Error("mayhem_tips_unavailable");
  return { rows: await toTips(data as Row[], viewer), total: count ?? 0 };
}

const fields = (input: MayhemTipInput) => ({ champion_id: input.championId, augment_ids: input.augmentIds, item_ids: input.itemIds, summary: input.summary, usage: input.usage, anonymous: input.anonymous });

export async function createMayhemTip(userId: string, patch: string, input: MayhemTipInput): Promise<MayhemTip | "daily_limit"> {
  const db = createServiceRoleSupabase();
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const recent = await db.from(table).select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", since).abortSignal(signal());
  if (recent.error) throw new Error("mayhem_tips_unavailable");
  if ((recent.count ?? 0) >= MAYHEM_TIP_LIMITS.dailyPerUser) return "daily_limit";
  const { data, error } = await db.from(table).insert({ user_id: userId, client_patch: patch, ...fields(input) }).select(columns).abortSignal(signal()).single();
  if (error || !data) throw new Error("mayhem_tips_unavailable");
  return (await toTips([data as Row], userId))[0];
}

// 본인 제보만 고친다. 숨김 처리된 제보는 고칠 수 없다.
export async function updateMayhemTip(userId: string, id: number, input: MayhemTipInput): Promise<MayhemTip | null> {
  const { data, error } = await createServiceRoleSupabase().from(table).update({ ...fields(input), updated_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", userId).eq("status", "published").select(columns).abortSignal(signal()).maybeSingle();
  if (error) throw new Error("mayhem_tips_unavailable");
  return data ? (await toTips([data as Row], userId))[0] : null;
}

export async function deleteMayhemTip(userId: string, id: number): Promise<boolean> {
  const { data, error } = await createServiceRoleSupabase().from(table).delete().eq("id", id).eq("user_id", userId).select("id").abortSignal(signal());
  if (error) throw new Error("mayhem_tips_unavailable");
  return data.length > 0;
}

export async function voteMayhemTip(userId: string, id: number, value: -1 | 0 | 1): Promise<{ up: number; down: number } | "not_found" | "own_tip"> {
  const { data, error } = await createServiceRoleSupabase().rpc("vote_lol_mayhem_combo_tip", { p_tip_id: id, p_user_id: userId, p_value: value }).abortSignal(signal());
  if (error?.code === "P0002") return "not_found";
  if (error?.code === "42501") return "own_tip";
  const row = (data as { up_count: number; down_count: number }[] | null)?.[0];
  if (error || !row) throw new Error("mayhem_tips_unavailable");
  return { up: row.up_count, down: row.down_count };
}
