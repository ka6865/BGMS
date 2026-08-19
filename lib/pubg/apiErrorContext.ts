import { createHmac } from "node:crypto";

export type PubgErrorStage =
  | "cache_lookup"
  | "match_fetch"
  | "match_parse"
  | "participant_lookup"
  | "analysis"
  | "unknown";

export type PubgClientKind = "browser" | "crawler" | "unknown";

export type PubgAnalysisStep =
  | "telemetry_cache_reserve"
  | "telemetry_r2_read"
  | "telemetry_download"
  | "telemetry_parse"
  | "telemetry_filter"
  | "telemetry_r2_upload"
  | "benchmark_lookup"
  | "analysis_engine"
  | "telemetry_payload"
  | "telemetry_cache_persistence"
  | "telemetry_cache_finalize";

export type PubgMatchErrorClassification = {
  errorCode: string;
  responseStatus: number;
};

const CRAWLER_USER_AGENT = /bot|crawler|spider|slurp|bingpreview|facebookexternalhit/i;
const TIMEOUT_ERROR = /timeout|timed out|abort/i;

export function classifyClientKind(userAgent: string | null): PubgClientKind {
  if (!userAgent) return "unknown";
  return CRAWLER_USER_AGENT.test(userAgent) ? "crawler" : "browser";
}

export function createPubgIdentifierFingerprint(value: string | null | undefined): string | null {
  const secret = process.env.PUBG_ERROR_FINGERPRINT_SECRET || process.env.PUBG_API_KEY;
  if (!value || !secret) return null;

  return createHmac("sha256", secret).update(value).digest("hex");
}

export function classifyPubgMatchError(input: {
  stage: PubgErrorStage;
  analysisStep?: PubgAnalysisStep | null;
  upstreamStatus?: number | null;
  error: unknown;
}): PubgMatchErrorClassification {
  const message = input.error instanceof Error ? input.error.message : String(input.error || "");

  if (input.stage === "match_fetch" && input.upstreamStatus === 404) {
    return { errorCode: "PUBG_MATCH_NOT_FOUND", responseStatus: 404 };
  }
  if (input.stage === "match_fetch" && input.upstreamStatus === 429) {
    return { errorCode: "PUBG_RATE_LIMITED", responseStatus: 429 };
  }
  if (input.stage === "match_fetch" && TIMEOUT_ERROR.test(message)) {
    return { errorCode: "PUBG_MATCH_TIMEOUT", responseStatus: 504 };
  }
  if (input.stage === "match_fetch" && input.upstreamStatus) {
    return { errorCode: "PUBG_MATCH_UPSTREAM_HTTP", responseStatus: 502 };
  }
  if (input.stage === "match_parse") {
    return { errorCode: "PUBG_MATCH_PARSE_FAILED", responseStatus: 502 };
  }
  if (input.stage === "participant_lookup") {
    return { errorCode: "PUBG_MATCH_PARTICIPANT_NOT_FOUND", responseStatus: 404 };
  }
  if (
    input.stage === "analysis"
    && input.analysisStep === "telemetry_cache_reserve"
    && message.includes("telemetry-map-cache-write-in-progress")
  ) {
    return { errorCode: "PUBG_MATCH_ANALYSIS_IN_PROGRESS", responseStatus: 409 };
  }
  if (input.stage === "analysis" && input.analysisStep === "telemetry_cache_persistence") {
    return {
      errorCode: "PUBG_MATCH_ANALYSIS_TELEMETRY_CACHE_PERSISTENCE",
      responseStatus: 503,
    };
  }
  if (input.stage === "analysis") {
    const suffix = input.analysisStep
      ? input.analysisStep.toUpperCase()
      : "UNKNOWN";
    return { errorCode: `PUBG_MATCH_ANALYSIS_${suffix}`, responseStatus: 500 };
  }
  return { errorCode: "PUBG_MATCH_UNKNOWN", responseStatus: 500 };
}
