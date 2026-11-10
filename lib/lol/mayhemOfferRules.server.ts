import "server-only";
import { unstable_cache } from "next/cache";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import type { MayhemOfferRule, MayhemOfferRuleAdmin, MayhemOfferRuleInput, MayhemOfferRuleKind, MayhemOfferRuleStatus } from "./mayhemOfferRules";

export const MAYHEM_OFFER_RULES_TAG = "lol-mayhem-offer-rules";
const table = "lol_mayhem_offer_rules";
const signal = () => AbortSignal.timeout(10_000);
type Row = { id: number; augment_id: number | null; kind: MayhemOfferRuleKind; text: string; patch: string | null; verified: boolean; status: MayhemOfferRuleStatus; source_quote: string | null; source_url: string | null; created_at: string; updated_at: string | null };
const columns = "id,augment_id,kind,text,patch,verified,status,source_quote,source_url,created_at,updated_at";
const toAdmin = (row: Row): MayhemOfferRuleAdmin => ({ id: row.id, augmentId: row.augment_id, kind: row.kind, text: row.text, patch: row.patch, verified: row.verified, status: row.status,
  sourceQuote: row.source_quote, sourceUrl: row.source_url, createdAt: row.created_at, updatedAt: row.updated_at });

// 공개 화면은 게시(active)된 규칙만 본다. 관리자가 바꾸면 태그로 바로 갱신한다.
export const getPublicMayhemOfferRules = unstable_cache(async (): Promise<MayhemOfferRule[]> => {
  const { data, error } = await createServiceRoleSupabase().from(table).select("id,augment_id,kind,text,patch,verified").eq("status", "active").not("augment_id", "is", null).limit(1000).abortSignal(signal());
  if (error) throw new Error("offer_rules_unavailable");
  return (data as Row[]).map(row => ({ id: row.id, augmentId: row.augment_id!, kind: row.kind, text: row.text, patch: row.patch, verified: row.verified }));
}, ["lol-mayhem-offer-rules-v1"], { revalidate: 3600, tags: [MAYHEM_OFFER_RULES_TAG] });

export async function listMayhemOfferRulesAdmin(): Promise<MayhemOfferRuleAdmin[]> {
  const { data, error } = await createServiceRoleSupabase().from(table).select(columns).order("status").order("created_at", { ascending: false }).limit(1000).abortSignal(signal());
  if (error) throw new Error("offer_rules_unavailable");
  return (data as Row[]).map(toAdmin);
}

const fields = (input: MayhemOfferRuleInput, reviewer: string) => ({ augment_id: input.augmentId, kind: input.kind, text: input.text, patch: input.patch, verified: input.verified, status: input.status, source_url: input.sourceUrl, reviewed_by: reviewer });

export async function saveMayhemOfferRule(reviewer: string, input: MayhemOfferRuleInput, id: number | null): Promise<MayhemOfferRuleAdmin | null> {
  const db = createServiceRoleSupabase();
  const query = id === null ? db.from(table).insert(fields(input, reviewer)) : db.from(table).update({ ...fields(input, reviewer), updated_at: new Date().toISOString() }).eq("id", id);
  const { data, error } = await query.select(columns).abortSignal(signal()).maybeSingle();
  if (error) throw new Error(error.code === "23505" ? "offer_rule_duplicate" : error.code === "23514" ? "offer_rule_invalid" : "offer_rules_unavailable");
  return data ? toAdmin(data as Row) : null;
}

export async function deleteMayhemOfferRule(id: number): Promise<boolean> {
  const { data, error } = await createServiceRoleSupabase().from(table).delete().eq("id", id).select("id").abortSignal(signal());
  if (error) throw new Error("offer_rules_unavailable");
  return data.length > 0;
}
