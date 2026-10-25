import "server-only";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import type { LolLadderDaily } from "./ladder";

export async function getLolLadderDaily(): Promise<LolLadderDaily[]> {
  if (process.env.LOL_PERSISTENCE_ENABLED !== "true") return [];
  const { data, error } = await createServiceRoleSupabase().rpc("get_lol_ladder_daily", { p_days: 30 }).abortSignal(AbortSignal.timeout(5000));
  if (error) throw new Error("랭크 컷 기록을 불러오지 못했습니다.");
  return data ?? [];
}
