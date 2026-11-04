import { NextResponse } from "next/server";
import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";

export const dynamic = "force-dynamic";
export const maxDuration = 5;

export async function GET(request: Request) {
  const denied = await guardLolPublicRequest(request, "read");
  if (denied) return denied;
  const response = (suggestions: { gameName: string; tagLine: string }[], status = 200) =>
    NextResponse.json({ suggestions }, { status, headers: { "Cache-Control": "private, no-store" } });
  const raw = new URL(request.url).searchParams.get("q") ?? "";
  const query = raw.trim();
  if (query.length < 2 || query.length > 81 || /[\u0000-\u001f\u007f]/.test(raw) || query.split("#").length > 2) return response([]);
  try {
    const { data, error } = await createServiceRoleSupabase().rpc("suggest_lol_accounts", { p_query: query })
      .abortSignal(AbortSignal.timeout(2_000));
    if (error) throw error;
    return response((data ?? []).slice(0, 8).map((row: { game_name: string; tag_line: string }) => ({ gameName: row.game_name, tagLine: row.tag_line })));
  } catch {
    return response([], 503);
  }
}
