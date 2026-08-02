import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import {
  isDatabaseCircuitOpen,
  isDatabaseUnavailableError,
  noteDatabaseAvailable,
  noteDatabaseUnavailable,
} from "@/lib/pubg/databaseCircuitBreaker";

export const maxDuration = 5;

function escapeLikePrefix(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function databaseUnavailableResponse() {
  return NextResponse.json(
    { suggestions: [] },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": "30",
      },
    },
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = normalizeName(searchParams.get("q") || "").slice(0, 32);

  if (!q || q.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  if (isDatabaseCircuitOpen()) {
    return databaseUnavailableResponse();
  }

  const supabase = await createClient();

  try {
    // lower_nickname은 저장 시 정규화되므로 LIKE + text_pattern_ops 인덱스를 사용한다.
    const prefix = escapeLikePrefix(q);
    const { data, error } = await supabase
      .from("pubg_player_cache")
      .select("nickname, platform")
      .like("lower_nickname", `${prefix}%`)
      .retry(false)
      .abortSignal(AbortSignal.timeout(2_000))
      .limit(8);

    if (error) throw error;
    noteDatabaseAvailable();

    return NextResponse.json(
      { suggestions: data || [] },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
    );
  } catch (error: unknown) {
    if (isDatabaseUnavailableError(error)) {
      noteDatabaseUnavailable();
      console.error("[SUGGEST-API] Supabase unavailable; database circuit opened");
      return databaseUnavailableResponse();
    }
    console.error("[SUGGEST-API] Query failed");
    return NextResponse.json({ suggestions: [] }, { status: 500 });
  }
}
