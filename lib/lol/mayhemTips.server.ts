import "server-only";
import { unstable_cache } from "next/cache";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { MAYHEM_TIP_LIMITS, selectMayhemTipItems, type MayhemTip, type MayhemTipComment, type MayhemTipCommentInput, type MayhemTipInput, type MayhemTipItem, type MayhemTipKind, type MayhemTipSort } from "./mayhemTips";

const signal = () => AbortSignal.timeout(10_000);
const table = "lol_mayhem_combo_tips";
const columns = "id,user_id,kind,champion_id,augment_ids,item_ids,summary,usage,anonymous,up_count,down_count,comment_count,created_at,updated_at";
type Row = { id: number; user_id: string; kind: MayhemTipKind; champion_id: number | null; augment_ids: number[]; item_ids: number[]; summary: string; usage: string; anonymous: boolean; up_count: number; down_count: number; comment_count: number; created_at: string; updated_at: string | null };

async function nicknames(userIds: string[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  const { data, error } = await createServiceRoleSupabase().from("profiles").select("id,nickname").in("id", ids).abortSignal(signal());
  if (error) throw new Error("mayhem_tips_unavailable");
  return new Map((data as { id: string; nickname: string | null }[]).map(p => [p.id, p.nickname?.trim() || null]));
}

// 작성자 ID는 화면에 내보내지 않고 닉네임·본인 여부·내 표로만 바꾼다.
async function toTips(rows: Row[], viewer: string | null): Promise<MayhemTip[]> {
  const db = createServiceRoleSupabase();
  const [names, votes] = await Promise.all([
    nicknames(rows.filter(row => !row.anonymous).map(row => row.user_id)),
    viewer && rows.length ? db.from("lol_mayhem_combo_tip_votes").select("tip_id,value").eq("user_id", viewer).in("tip_id", rows.map(row => row.id)).abortSignal(signal()) : { data: [], error: null },
  ]);
  if (votes.error) throw new Error("mayhem_tips_unavailable");
  const myVotes = new Map((votes.data as { tip_id: number; value: number }[]).map(v => [v.tip_id, v.value]));
  return rows.map(row => ({
    id: row.id, kind: row.kind, championId: row.champion_id, augmentIds: row.augment_ids, itemIds: row.item_ids, summary: row.summary, usage: row.usage,
    anonymous: row.anonymous, author: row.anonymous ? null : names.get(row.user_id) ?? null, up: row.up_count, down: row.down_count,
    myVote: (myVotes.get(row.id) ?? 0) as -1 | 0 | 1, mine: row.user_id === viewer, comments: row.comment_count, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

export const getMayhemTipItems = unstable_cache(async (version: string): Promise<MayhemTipItem[]> => {
  const response = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/item.json`, { cache: "no-store", redirect: "error", signal: signal() });
  if (!response.ok) throw new Error("mayhem_tip_items_unavailable");
  return selectMayhemTipItems(await response.json());
}, ["lol-mayhem-tip-items-v2"], { revalidate: 21600 });

export async function listMayhemTips(patch: string, champion: number | "common" | null, kind: MayhemTipKind | null, sort: MayhemTipSort, offset: number, viewer: string | null): Promise<{ rows: MayhemTip[]; total: number }> {
  let query = createServiceRoleSupabase().from(table).select(columns, { count: "exact" }).eq("status", "published").eq("client_patch", patch);
  if (kind) query = query.eq("kind", kind);
  if (champion === "common") query = query.is("champion_id", null);
  else if (champion !== null) query = query.eq("champion_id", champion);
  if (sort === "top") query = query.order("score", { ascending: false });
  const { data, error, count } = await query.order("created_at", { ascending: false }).order("id", { ascending: false })
    .range(offset, offset + MAYHEM_TIP_LIMITS.pageSize - 1).abortSignal(signal());
  if (error) throw new Error("mayhem_tips_unavailable");
  return { rows: await toTips(data as Row[], viewer), total: count ?? 0 };
}

const fields = (input: MayhemTipInput) => ({ kind: input.kind, champion_id: input.championId, augment_ids: input.augmentIds, item_ids: input.itemIds, summary: input.summary, usage: input.usage, anonymous: input.anonymous });

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

const commentTable = "lol_mayhem_combo_tip_comments";
type CommentRow = { id: number; parent_id: number | null; user_id: string; body: string; anonymous: boolean; status: string; created_at: string };

// 게시된 글의 댓글을 시간순으로 준다. 지운 댓글은 답글이 남아 있을 때만 자리로 보여 준다.
export async function listMayhemTipComments(tipId: number, viewer: string | null): Promise<MayhemTipComment[] | null> {
  const db = createServiceRoleSupabase();
  const [tip, comments] = await Promise.all([
    db.from(table).select("user_id").eq("id", tipId).eq("status", "published").abortSignal(signal()).maybeSingle(),
    db.from(commentTable).select("id,parent_id,user_id,body,anonymous,status,created_at").eq("tip_id", tipId).in("status", ["published", "deleted"])
      .order("created_at").order("id").limit(MAYHEM_TIP_LIMITS.comments).abortSignal(signal()),
  ]);
  if (tip.error || comments.error) throw new Error("mayhem_tips_unavailable");
  if (!tip.data) return null;
  const rows = comments.data as CommentRow[];
  const parents = new Set(rows.filter(row => row.parent_id && row.status === "published").map(row => row.parent_id));
  const visible = rows.filter(row => row.status === "published" || parents.has(row.id));
  const names = await nicknames(visible.filter(row => row.status === "published" && !row.anonymous).map(row => row.user_id));
  const owner = (tip.data as { user_id: string }).user_id;
  return visible.map(row => {
    const deleted = row.status !== "published";
    return { id: row.id, parentId: row.parent_id, body: deleted ? "" : row.body, author: deleted || row.anonymous ? null : names.get(row.user_id) ?? null, anonymous: !deleted && row.anonymous,
      deleted, mine: !deleted && row.user_id === viewer, byTipAuthor: !deleted && row.user_id === owner, createdAt: row.created_at };
  });
}

// 답글은 같은 글의 최상위 댓글에만 단다.
export async function createMayhemTipComment(userId: string, input: MayhemTipCommentInput): Promise<"not_found" | "bad_parent" | "ok"> {
  const db = createServiceRoleSupabase();
  const tip = await db.from(table).select("id").eq("id", input.tipId).eq("status", "published").abortSignal(signal()).maybeSingle();
  if (tip.error) throw new Error("mayhem_tips_unavailable");
  if (!tip.data) return "not_found";
  if (input.parentId) {
    const parent = await db.from(commentTable).select("tip_id,parent_id,status").eq("id", input.parentId).abortSignal(signal()).maybeSingle();
    if (parent.error) throw new Error("mayhem_tips_unavailable");
    const row = parent.data as { tip_id: number; parent_id: number | null; status: string } | null;
    if (!row || row.tip_id !== input.tipId || row.parent_id !== null || row.status !== "published") return "bad_parent";
  }
  const { error } = await db.from(commentTable).insert({ tip_id: input.tipId, parent_id: input.parentId, user_id: userId, body: input.body, anonymous: input.anonymous }).abortSignal(signal());
  if (error) throw new Error("mayhem_tips_unavailable");
  return "ok";
}

// 답글이 달린 댓글은 자리를 남기고(deleted), 아니면 행을 지운다.
export async function deleteMayhemTipComment(userId: string, id: number): Promise<boolean> {
  const db = createServiceRoleSupabase();
  const replies = await db.from(commentTable).select("id", { count: "exact", head: true }).eq("parent_id", id).eq("status", "published").abortSignal(signal());
  if (replies.error) throw new Error("mayhem_tips_unavailable");
  const query = (replies.count ?? 0) > 0
    ? db.from(commentTable).update({ status: "deleted" }).eq("id", id).eq("user_id", userId).eq("status", "published")
    : db.from(commentTable).delete().eq("id", id).eq("user_id", userId).eq("status", "published");
  const { data, error } = await query.select("id").abortSignal(signal());
  if (error) throw new Error("mayhem_tips_unavailable");
  return data.length > 0;
}
