export function classifyAiErrorCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("did not pass validation")) return "validation";
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
