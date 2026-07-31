/**
 * @fileoverview Overwolf GEP 세션 요약 수신 엔드포인트
 *
 * BGMS Companion(Overwolf 앱)이 매치 종료 시 1회 전송하는 세션 요약을 받는다.
 * 이 라우트는 기존 app/api/pubg/* 파이프라인과 완전히 분리된 네임스페이스이며
 * overwolf_session_events 테이블에만 적재한다.
 *
 * 보안 메모:
 *  - 클라이언트는 service role key 를 갖지 않는다. 이 라우트만 service role 로 DB 에 접근한다.
 *  - 익명 공개 엔드포인트이므로 payload 크기 제한, 필드 화이트리스트, 세션 단위 쿼터로 방어한다.
 *  - session_id 기준 idempotent 처리로 중복 matchEnd 를 흡수한다.
 */

import { NextResponse } from "next/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import {
  MAX_SESSION_PAYLOAD_BYTES,
  SESSION_QUOTA_MAX_EVENTS,
  SESSION_QUOTA_WINDOW_SECONDS,
  normalizeSessionPayload
} from "@/lib/overwolf/session-payload";

const clean = (value: string | undefined) => (value || "").replace(/['";\s]+/g, "").trim();
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

// Overwolf 앱 창은 overwolf-extension:// origin 으로 요청하므로 CORS 를 명시 허용한다.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-BGMS-Session-Id",
  "Access-Control-Max-Age": "86400"
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_SESSION_PAYLOAD_BYTES) {
    return jsonResponse({ error: "세션 payload가 너무 큽니다." }, 413);
  }

  const body = await request.json().catch(() => null);
  const normalized = normalizeSessionPayload(body);

  if (!normalized.ok) {
    if (normalized.reason === "blocked_field") {
      return jsonResponse({ error: "정책상 저장할 수 없는 필드가 포함되어 있습니다." }, 422);
    }
    return jsonResponse({ error: "세션 payload가 올바르지 않습니다." }, 400);
  }

  const supabaseUrl = clean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "세션 저장 설정이 준비되지 않았습니다." }, 503);
  }

  const supabaseAdmin = createSupabaseAdminClient(supabaseUrl, serviceRoleKey);
  const requestHost = getRequestHost(request);
  const environment = getServerEnvironment();

  const { data: quotaAccepted, error: quotaError } = await supabaseAdmin.rpc(
    "consume_overwolf_session_quota",
    {
      p_quota_key: normalized.value.session_id,
      p_max_events: SESSION_QUOTA_MAX_EVENTS,
      p_window_seconds: SESSION_QUOTA_WINDOW_SECONDS
    }
  );

  if (quotaError) {
    return jsonResponse({ error: "세션 전송 제한을 확인하지 못했습니다." }, 503);
  }
  if (!quotaAccepted) {
    return jsonResponse({ error: "세션 전송 빈도가 너무 높습니다." }, 429);
  }

  const { data: inserted, error: insertError } = await supabaseAdmin.rpc(
    "record_overwolf_session_event",
    {
      p_session_id: normalized.value.session_id,
      p_match_id: normalized.value.match_id,
      p_pseudo_match_id: normalized.value.pseudo_match_id,
      p_player_id: normalized.value.player_id,
      p_platform: normalized.value.platform,
      p_gep_summary: normalized.value.gep_summary,
      p_client_environment: normalized.value.client_environment,
      p_source_host: requestHost,
      p_is_internal: isLocalHost(requestHost) || environment !== "production"
    }
  );

  if (insertError) {
    return jsonResponse({ error: "세션 저장에 실패했습니다." }, 500);
  }

  // 중복 matchEnd 로 같은 session_id 가 다시 오면 duplicate 로 응답하고 성공 처리한다.
  return jsonResponse({
    success: true,
    stored: Boolean(inserted),
    duplicate: !inserted,
    session_id: normalized.value.session_id
  }, 200);
}

function jsonResponse(payload: Record<string, unknown>, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}

function getRequestHost(request: Request) {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const rawHost = forwardedHost || request.headers.get("host") || new URL(request.url).host;
  return rawHost.replace(/:\d+$/, "").toLowerCase();
}

function isLocalHost(host: string | null | undefined) {
  if (!host) return false;
  const normalized = host.toLowerCase();
  return LOCAL_HOSTS.has(normalized) || normalized.endsWith(".local");
}

function getServerEnvironment() {
  return process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown";
}
