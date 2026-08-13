import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

export type AiUsageStatus = "success" | "error";

export type AiUsageContext = {
  status?: AiUsageStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  durationMs?: number | null;
  requestId?: string | null;
  platform?: string | null;
};

const supabaseAdmin = createSupabaseAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Gemini AI 사용량을 기록하고 단가에 맞춰 USD 비용을 산출하여 DB에 저장합니다.
 * 백그라운드 비동기로 수행되어 API 응답을 지연시키지 않습니다.
 */
export function trackAiUsage(
  userId: string | undefined,
  modelName: string,
  promptTokens: number,
  completionTokens: number,
  analysisType: "analyze" | "summary" | "squad",
  context: AiUsageContext = {},
): void {
  try {
    const status = context.status ?? "success";

    // Gemini API 단가 기준 (100만 토큰당 입력 $0.075, 출력 $0.30)
    // 1토큰당 단가 = 입력 0.000000075달러, 출력 0.00000030달러
    const inputRate = 0.000000075;
    const outputRate = 0.00000030;
    const costUsd = (promptTokens * inputRate) + (completionTokens * outputRate);

    // 백그라운드 비동기 처리
    supabaseAdmin
      .from("ai_usage_logs")
      .insert({
        user_id: userId || null,
        model_name: modelName || "unknown",
        prompt_tokens: Math.max(0, Math.trunc(promptTokens || 0)),
        completion_tokens: Math.max(0, Math.trunc(completionTokens || 0)),
        cost_usd: status === "success" ? parseFloat(costUsd.toFixed(6)) : 0,
        analysis_type: analysisType,
        status,
        error_code: context.errorCode || null,
        error_message: sanitizeAiErrorMessage(context.errorMessage),
        duration_ms: normalizeDuration(context.durationMs),
        request_id: context.requestId || null,
        platform: context.platform || null,
      })
      .then(({ error }) => {
        if (error) {
          console.error("[AI Usage Tracker Error]:", error);
        }
      });
  } catch (err) {
    console.error("[AI Usage Tracker Unexpected Error]:", err);
  }
}

export function trackAiFailure(
  userId: string | undefined,
  analysisType: "analyze" | "summary" | "squad",
  error: unknown,
  context: Omit<AiUsageContext, "status" | "errorCode" | "errorMessage"> & {
    errorCode?: string | null;
  } = {},
): void {
  const errorMessage = error instanceof Error ? error.message : String(error || "알 수 없는 AI 오류");
  trackAiUsage(userId, "unknown", 0, 0, analysisType, {
    ...context,
    status: "error",
    errorCode: context.errorCode || classifyAiErrorCode(errorMessage),
    errorMessage,
  });
}

export function classifyAiErrorCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("시간")) return "timeout";
  if (normalized.includes("api key") || normalized.includes("configuration")) return "configuration";
  if (normalized.includes("unauthorized") || normalized.includes("forbidden") || normalized.includes("로그인")) return "auth";
  if (normalized.includes("missing") || normalized.includes("required") || normalized.includes("no matches") || normalized.includes("데이터")) return "invalid_input";
  if (normalized.includes("429") || normalized.includes("rate limit") || normalized.includes("busy") || normalized.includes("바쁩")) return "rate_limit";
  if (normalized.includes("parse") || normalized.includes("json")) return "parse";
  if (normalized.includes("cache") || normalized.includes("supabase") || normalized.includes("database")) return "storage";
  if (normalized.includes("model") || normalized.includes("gemini") || normalized.includes("generation")) return "model";
  return "unknown";
}

function normalizeDuration(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.trunc(value), 86_400_000)
    : null;
}

function sanitizeAiErrorMessage(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/AIza[0-9A-Za-z_-]+/g, "[redacted-key]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || null;
}
