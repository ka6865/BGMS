/**
 * @fileoverview Overwolf GEP 세션 요약 payload 검증 및 정규화 (순수 모듈)
 *
 * BGMS Companion(Overwolf 앱)이 매치 종료 시 1회 전송하는 세션 요약을 검증한다.
 * 이 모듈은 Supabase 나 Next 런타임에 의존하지 않으므로 단위 테스트가 가능하다.
 *
 * 정책 기준:
 *  - GEP 데이터는 PUBG 공식 API 사후 분석 데이터를 대체하지 않는 보조 신호다.
 *  - damage/location 계열 필드는 서버에서도 한 번 더 차단한다.
 *  - GEP 닉네임은 신뢰 가능한 identity 가 아니므로 정규화만 하고 검증된 계정으로 취급하지 않는다.
 */

import { normalizeName } from "@/lib/pubg-analysis/utils";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";

export const MAX_SESSION_PAYLOAD_BYTES = 16 * 1024;
export const SESSION_QUOTA_MAX_EVENTS = 12;
export const SESSION_QUOTA_WINDOW_SECONDS = 600;

/** 서버에서도 저장을 거부하는 정책 금지 키. 클라이언트 리듀서 차단 목록과 동일해야 한다. */
export const BLOCKED_SUMMARY_KEYS = [
  "damage_dealt",
  "total_damage_dealt",
  "damage_taken",
  "damageTaken",
  "location",
  "team_location",
  "teamLocation"
] as const;

/** gep_summary 에 저장을 허용하는 키 목록. 그 외 키는 조용히 버린다. */
const ALLOWED_SUMMARY_KEYS = [
  "effective_match_id",
  "match_mode",
  "phase",
  "phase_is_official",
  "kills",
  "deaths",
  "revives",
  "knockdowns",
  "alive_players",
  "last_killer_name",
  "match_started_at",
  "match_ended_at",
  "match_end_event_count",
  "gep_local_version",
  "gep_public_version",
  "source"
] as const;

/** client_environment 에 저장을 허용하는 키 목록. */
const ALLOWED_ENVIRONMENT_KEYS = [
  "app",
  "source",
  "version",
  "overwolf_game_id",
  "overwolf_class_id",
  "overwolf_version",
  "language"
] as const;

export type NormalizedSessionEvent = {
  session_id: string;
  match_id: string | null;
  pseudo_match_id: string | null;
  player_id: string | null;
  platform: string | null;
  gep_summary: Record<string, string | number | boolean | null>;
  client_environment: Record<string, string | number | boolean | null>;
};

export type SessionPayloadResult =
  | { ok: true; value: NormalizedSessionEvent }
  | { ok: false; reason: "invalid_payload" | "invalid_session_id" | "blocked_field" };

function sanitizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function sanitizeIdentifier(value: unknown, maxLength: number): string | null {
  const text = sanitizeText(value, maxLength);
  if (!text) return null;
  // 식별자에는 영문/숫자/하이픈/언더바/마침표만 허용한다.
  const filtered = text.replace(/[^a-zA-Z0-9._-]/g, "");
  return filtered || null;
}

function sanitizeScalar(value: unknown): string | number | boolean | null {
  if (typeof value === "string") return value.slice(0, 220);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return null;
}

function hasBlockedKey(value: unknown, depth = 0): boolean {
  if (depth > 4 || !value || typeof value !== "object") return false;

  if (Array.isArray(value)) {
    return value.some((entry) => hasBlockedKey(entry, depth + 1));
  }

  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    if ((BLOCKED_SUMMARY_KEYS as readonly string[]).includes(key)) return true;
    return hasBlockedKey(nested, depth + 1);
  });
}

function pickAllowed(
  source: unknown,
  allowedKeys: readonly string[]
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  if (!source || typeof source !== "object" || Array.isArray(source)) return result;

  allowedKeys.forEach((key) => {
    const raw = (source as Record<string, unknown>)[key];
    if (raw === undefined) return;
    result[key] = sanitizeScalar(raw);
  });

  return result;
}

/**
 * 세션 요약 payload 를 검증하고 저장 가능한 형태로 정규화합니다.
 * player_id 는 GEP 닉네임 기반이므로 identity 정규화만 수행하고 인증된 계정으로 취급하지 않습니다.
 */
export function normalizeSessionPayload(body: unknown): SessionPayloadResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "invalid_payload" };
  }

  if (hasBlockedKey(body)) {
    return { ok: false, reason: "blocked_field" };
  }

  const raw = body as Record<string, unknown>;
  const sessionId = sanitizeIdentifier(raw.session_id, 200);
  if (!sessionId) {
    return { ok: false, reason: "invalid_session_id" };
  }

  const playerId = sanitizeText(raw.player_id, 100);
  const platform = sanitizeText(raw.platform, 40);

  return {
    ok: true,
    value: {
      session_id: sessionId,
      match_id: sanitizeIdentifier(raw.match_id, 100),
      pseudo_match_id: sanitizeIdentifier(raw.pseudo_match_id, 100),
      player_id: playerId ? normalizeName(playerId) || null : null,
      platform: platform ? normalizePlatform(platform) : null,
      gep_summary: pickAllowed(raw.gep_summary, ALLOWED_SUMMARY_KEYS),
      client_environment: pickAllowed(raw.client_environment, ALLOWED_ENVIRONMENT_KEYS)
    }
  };
}
