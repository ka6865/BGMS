/**
 * @fileoverview Overwolf 세션 요약 조회 엔드포인트
 *
 * BGMS 웹의 세션 목록/상세 화면이 사용한다. 적재 경로(app/api/overwolf/session)와
 * 분리된 읽기 전용 라우트이며 overwolf_session_events 만 읽는다.
 *
 * 보안 메모:
 *  - player_id 는 사용자가 앱에서 직접 입력한 닉네임이며 인증된 identity 가 아니다.
 *    따라서 이 라우트는 비공개 데이터를 다루지 않는다는 전제로만 성립한다.
 *    적재되는 값 자체가 GEP 카운터와 이벤트 시점뿐이고 위치/데미지/개인정보는 없다.
 *  - source_host 와 is_internal 은 반환하지 않는다. RPC 가 컬럼에서 제외한다.
 *  - service role 키는 이 서버 라우트에만 있다. 클라이언트는 이 라우트만 호출한다.
 *  - 열거 방지를 위해 닉네임 최소 길이와 조회 상한을 둔다.
 */

import { NextResponse } from "next/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { toSessionSummaryView, toSessionSummaryViews } from "@/lib/overwolf/session-view";

const clean = (value: string | undefined) => (value || "").replace(/['";\s]+/g, "").trim();

/** 닉네임 열거를 어렵게 하기 위한 최소 길이. PUBG 최소 닉네임 길이와 맞춘다. */
const MIN_PLAYER_ID_LENGTH = 3;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId")?.trim() || "";
  const rawPlayer = url.searchParams.get("player")?.trim() || "";
  const rawPlatform = url.searchParams.get("platform")?.trim() || "";
  const rawLimit = Number(url.searchParams.get("limit") || DEFAULT_LIMIT);

  const supabaseUrl = clean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "세션 조회 설정이 준비되지 않았습니다." }, { status: 503 });
  }

  const supabaseAdmin = createSupabaseAdminClient(supabaseUrl, serviceRoleKey);

  if (sessionId) {
    if (sessionId.length > 200) {
      return NextResponse.json({ error: "세션 식별자가 올바르지 않습니다." }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin.rpc("get_overwolf_session", {
      p_session_id: sessionId
    });

    if (error) {
      return NextResponse.json({ error: "세션을 조회하지 못했습니다." }, { status: 503 });
    }

    const row = Array.isArray(data) ? data[0] : data;
    const view = row ? toSessionSummaryView(row) : null;

    if (!view) {
      return NextResponse.json({ error: "세션을 찾을 수 없습니다." }, { status: 404 });
    }

    return NextResponse.json({ success: true, session: view });
  }

  const playerId = rawPlayer ? normalizeName(rawPlayer) : "";
  if (!playerId || playerId.length < MIN_PLAYER_ID_LENGTH) {
    return NextResponse.json({ error: "닉네임을 확인해주세요." }, { status: 400 });
  }

  const platform = rawPlatform ? normalizePlatform(rawPlatform) : null;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.round(rawLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const { data, error } = await supabaseAdmin.rpc("list_overwolf_sessions", {
    p_player_id: playerId,
    p_platform: platform,
    p_limit: limit
  });

  if (error) {
    return NextResponse.json({ error: "세션 목록을 조회하지 못했습니다." }, { status: 503 });
  }

  return NextResponse.json({
    success: true,
    player_id: playerId,
    platform,
    sessions: toSessionSummaryViews(data)
  });
}
