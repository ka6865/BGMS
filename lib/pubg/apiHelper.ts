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

// 인스턴스 로컬 에러 리스트.
// 알림 본문에 최근 오류 샘플을 담고, DB 집계가 실패할 때 폴백 카운트로 쓴다.
// 임계값 판정 자체는 DB 집계를 우선한다(아래 resolveWindowErrorCount 참고).
let errorQueue: ApiErrorRecord[] = [];
let lastAlertSentAt = 0;

const ALERT_COOLDOWN = 10 * 60 * 1000; // 10분 쿨다운
const WINDOW_SIZE = 5 * 60 * 1000; // 5분 범위
const ERROR_THRESHOLD = 10; // 임계값 10회
const ALERT_MIN_STATUS = 500; // 알림 판정 대상 최소 상태 코드

/**
 * 윈도우 안에서 발생한 알림 대상 오류 건수를 구합니다.
 *
 * Vercel 서버리스는 요청을 여러 인스턴스에 분산하므로 모듈 스코프 큐는
 * 전체 오류의 일부만 봅니다. 운영 실측에서 5xx 74건이 한 구간에 몰렸는데도
 * 인스턴스별 카운트가 임계값에 도달하지 못해 알림이 대부분 누락됐습니다.
 *
 * 모든 오류는 이미 pubg_api_errors 에 적립되므로 그 테이블을 집계해
 * 인스턴스 수와 무관하게 같은 판정 결과를 얻습니다.
 * 집계 실패 시에는 기존 동작인 인스턴스 로컬 카운트로 되돌립니다.
 */
async function resolveWindowErrorCount(now: number, localCount: number): Promise<number> {
  const windowStartedAt = new Date(now - WINDOW_SIZE).toISOString();
  try {
    const { data, error } = await supabaseAdmin.rpc("count_pubg_api_errors_in_window", {
      p_window_started_at: windowStartedAt,
      p_min_status: ALERT_MIN_STATUS,
      p_route: null,
    });
    if (error || typeof data !== "number" || !Number.isFinite(data)) {
      return localCount;
    }
    // DB 적립이 비동기라 방금 발생한 오류가 아직 안 보일 수 있다.
    // 둘 중 큰 값을 쓰면 누락 방향으로 기울지 않는다.
    return Math.max(data, localCount);
  } catch {
    return localCount;
  }
}

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
  if (notify && now - lastAlertSentAt > ALERT_COOLDOWN) {
    const windowErrorCount = await resolveWindowErrorCount(now, errorQueue.length);
    if (windowErrorCount >= ERROR_THRESHOLD) {
      const alertKey = `${route}:${status}:${context?.errorCode ?? "unknown"}`;
      if (await reserveDiscordAlertWindow(alertKey, now)) {
        lastAlertSentAt = now;
        await sendAlertToDiscord(windowErrorCount, [...errorQueue]);
      }
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
