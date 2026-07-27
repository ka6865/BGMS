import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

interface ApiErrorRecord {
  timestamp: number;
  route: string;
  status: number;
  message: string;
  detail?: string;
  errorCode?: string;
}

export interface PubgApiErrorContext {
  failureStage?: string;
  errorCode?: string;
  upstreamStatus?: number | null;
  durationMs?: number | null;
  platform?: string | null;
  source?: string | null;
  clientKind?: string | null;
  requestId?: string | null;
  matchFingerprint?: string | null;
  nicknameFingerprint?: string | null;
}

export interface PubgApiErrorInput {
  route: string;
  status: number;
  message: string;
  detail?: string;
  context?: PubgApiErrorContext;
  notify?: boolean;
}

const supabaseAdmin = createSupabaseAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// 전역 에러 리스트 (슬라이딩 윈도우 감시용)
let errorQueue: ApiErrorRecord[] = [];
let lastAlertSentAt = 0;

const ALERT_COOLDOWN = 10 * 60 * 1000; // 10분 쿨다운
const WINDOW_SIZE = 5 * 60 * 1000; // 5분 범위
const ERROR_THRESHOLD = 10; // 임계값 10회

/**
 * PUBG API 실패 건을 모니터링 큐에 기록하고,
 * 빈도가 높아질 경우 즉각 디스코드로 경고 웹훅을 발송합니다.
 */
export async function reportPubgApiError(
  input: PubgApiErrorInput,
) {
  const now = Date.now();
  const { route, status, message, detail, context, notify = true } = input;
  errorQueue.push({
    timestamp: now,
    route,
    status,
    message,
    detail,
    errorCode: context?.errorCode,
  });

  // DB에 비동기 에러 로그 적립
  supabaseAdmin
    .from("pubg_api_errors")
    .insert({
      route,
      status,
      message,
      detail: detail ?? null,
      failure_stage: context?.failureStage ?? null,
      error_code: context?.errorCode ?? null,
      upstream_status: context?.upstreamStatus ?? null,
      duration_ms: context?.durationMs ?? null,
      platform: context?.platform ?? null,
      source: context?.source ?? null,
      client_kind: context?.clientKind ?? null,
      request_id: context?.requestId ?? null,
      match_fingerprint: context?.matchFingerprint ?? null,
      nickname_fingerprint: context?.nicknameFingerprint ?? null,
    })
    .then(({ error }) => {
      if (error) {
        console.error("[MONITORING DB LOG FAIL]:", error.message);
      }
    });

  // 5분보다 오래된 만료 레코드 정리
  const cutOff = now - WINDOW_SIZE;
  errorQueue = errorQueue.filter(err => err.timestamp >= cutOff);

  console.warn(`[MONITORING] API Error Recorded - Route: ${route}, Status: ${status}, Message: ${message}`);

  // 5분 동안 발생한 에러 수가 임계치에 도달하고 쿨다운이 지난 경우 알림 전송
  if (notify && errorQueue.length >= ERROR_THRESHOLD && now - lastAlertSentAt > ALERT_COOLDOWN) {
    const alertKey = `${route}:${status}:${context?.errorCode ?? "unknown"}`;
    if (await reserveDiscordAlertWindow(alertKey, now)) {
      lastAlertSentAt = now;
      await sendAlertToDiscord(errorQueue.length, [...errorQueue]);
    }
  }
}

async function reserveDiscordAlertWindow(alertKey: string, timestamp: number): Promise<boolean> {
  const windowStartedAt = new Date(Math.floor(timestamp / ALERT_COOLDOWN) * ALERT_COOLDOWN).toISOString();
  const { data, error } = await supabaseAdmin.rpc(
    "reserve_pubg_api_alert_delivery",
    {
      p_alert_key: alertKey,
      p_window_started_at: windowStartedAt,
    },
  );

  return !error && data === true;
}

/**
 * 디스코드 채널로 상세 장애 정보를 포함한 리치 임베드 알림을 전송합니다.
 */
async function sendAlertToDiscord(errorCount: number, recentErrors: ApiErrorRecord[]) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("[MONITORING] DISCORD_WEBHOOK_URL env is missing, skipping alert.");
    return;
  }

  // 경로 및 상태 코드별 집계
  const routeStats: Record<string, number> = {};
  const statusStats: Record<number, number> = {};

  recentErrors.forEach(err => {
    routeStats[err.route] = (routeStats[err.route] || 0) + 1;
    statusStats[err.status] = (statusStats[err.status] || 0) + 1;
  });

  const routeSummary = Object.entries(routeStats)
    .map(([r, c]) => `• \`${r}\`: ${c}회`)
    .join("\n");
  const statusSummary = Object.entries(statusStats)
    .map(([s, c]) => `• Code \`${s}\`: ${c}회`)
    .join("\n");

  const latestError = recentErrors[recentErrors.length - 1];

  const embed = {
    title: "🚨 PUBG API 장애 감지 알림",
    description: "최근 5분간 PUBG API 호출 에러 빈도가 임계치를 초과하였습니다. 서비스 상태 모니터링 및 조치가 필요합니다.",
    color: 15158332, // Red color
    fields: [
      { name: "총 오류 발생 수 (5분간)", value: `${errorCount}회`, inline: true },
      { name: "기준 임계치", value: `5분 내 ${ERROR_THRESHOLD}회`, inline: true },
      { name: "오류 발생 경로 현황", value: routeSummary || "데이터 없음", inline: false },
      { name: "상태 코드 현황", value: statusSummary || "데이터 없음", inline: false },
      { name: "가장 최근 에러 상세", value: `\`\`\`json\n${JSON.stringify(latestError, null, 2)}\n\`\`\``, inline: false },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: "BGMS API Auto Monitor System" }
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] })
    });

    if (!res.ok) {
      throw new Error(`Discord API responded with code: ${res.status}`);
    }
  } catch (err: any) {
    console.error("[MONITORING] Failed to dispatch Discord Alert:", err.message);
  }
}
