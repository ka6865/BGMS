import { classifyAiErrorCode } from "./aiErrorCode";
export { classifyAiErrorCode } from "./aiErrorCode";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

export type AiUsageStatus = "success" | "partial" | "error" | "cancelled";

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
 * 호출자가 반환된 Promise를 await하거나 after에 연결해 저장 수명을 보장합니다.
 */
export async function trackAiUsage(
  userId: string | undefined,
  modelName: string,
  promptTokens: number,
  completionTokens: number,
  analysisType: "analyze" | "summary" | "squad",
  context: AiUsageContext = {},
): Promise<void> {
  try {
    const status = context.status ?? "success";

    // Gemini 표준 유료 단가(100만 토큰당 USD, 2026-10-12 갱신 요금표)에 따른 추정값이다. 무료 사용량·할인·실제 청구액은 반영하지 않는다.
    // gemini-3.6-flash는 2026-12-31까지 할인가이며, 지원 종료된 gemini-3.5-flash 요청은 3.6-flash로 자동 연결되므로 같은 단가를 쓴다.
    const flash36: [number, number] = Date.now() < Date.UTC(2027, 0, 1) ? [0.75, 3.75] : [1.50, 7.50];
    const rates: Record<string, [number, number]> = {
      "gemini-3.5-flash-lite": [0.30, 2.50],
      "gemini-3.1-flash-lite": [0.25, 1.50],
      "gemini-3.5-flash": flash36,
      "gemini-3.6-flash": flash36,
    };
    // shortcut: 미등록 모델은 기존 단가로 추정한다. 모델을 추가하면 단가표도 갱신한다.
    const [inputRate, outputRate] = rates[modelName] ?? [0.075, 0.30];
    const costUsd = (promptTokens * inputRate + completionTokens * outputRate) / 1_000_000;

    const { error } = await supabaseAdmin
      .from("ai_usage_logs")
      .insert({
        user_id: userId || null,
        model_name: modelName || "unknown",
        prompt_tokens: Math.max(0, Math.trunc(promptTokens || 0)),
        completion_tokens: Math.max(0, Math.trunc(completionTokens || 0)),
        cost_usd: parseFloat(costUsd.toFixed(6)),
        analysis_type: analysisType,
        status,
        error_code: context.errorCode || null,
        error_message: sanitizeAiErrorMessage(context.errorMessage),
        duration_ms: normalizeDuration(context.durationMs),
        request_id: context.requestId || null,
        platform: context.platform || null,
      });
    if (error) console.error("[AI Usage Tracker Error]:", error);
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
    modelName?: string;
    promptTokens?: number;
    completionTokens?: number;
  } = {},
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error || "알 수 없는 AI 오류");
  const { modelName, promptTokens, completionTokens, ...usageContext } = context;
  return trackAiUsage(userId, modelName || "unknown", promptTokens ?? 0, completionTokens ?? 0, analysisType, {
    ...usageContext,
    status: "error",
    errorCode: context.errorCode || classifyAiErrorCode(errorMessage),
    errorMessage,
  });
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
