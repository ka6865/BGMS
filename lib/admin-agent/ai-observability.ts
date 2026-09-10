import { classifyAiErrorCode } from "@/lib/pubg-analysis/aiErrorCode";

export type AiUsageObservationRow = {
  id?: string | null;
  user_id?: string | null;
  model_name?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cost_usd?: number | string | null;
  analysis_type?: string | null;
  status?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  duration_ms?: number | null;
  request_id?: string | null;
  platform?: string | null;
  created_at: string;
};

export type PubgErrorObservationRow = {
  id?: string | null;
  route?: string | null;
  status?: number | null;
  message?: string | null;
  error_code?: string | null;
  failure_stage?: string | null;
  duration_ms?: number | null;
  platform?: string | null;
  request_id?: string | null;
  created_at: string;
};

export type AiErrorSummary = {
  code: string;
  label: string;
  count: number;
  lastAt: string | null;
};

export type AiRecentError = {
  id: string;
  createdAt: string;
  analysisType: string;
  errorCode: string;
  errorLabel: string;
  message: string;
  userId: string | null;
  durationMs: number | null;
  platform: string | null;
  requestId: string | null;
};

export type PubgErrorSummary = {
  total: number;
  byStatus: Record<string, number>;
  byReason: Array<{ reason: string; count: number; lastAt: string | null }>;
  recent: Array<{
    id: string;
    createdAt: string;
    route: string;
    status: number | null;
    reason: string;
    failureStage: string | null;
    platform: string | null;
    durationMs: number | null;
  }>;
};

export type AiWindowSummary = {
  windowHours: number;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  successRate: number;
  uniqueUsers: number;
  memberUsageRate?: number;
  guestRequests: number;
  totalCostUsd: number;
  promptTokens: number;
  completionTokens: number;
  averageDurationMs: number | null;
  byType: Record<string, number>;
  topUsers: Array<{ userId: string; count: number; nickname?: string }>;
  errorsByReason: AiErrorSummary[];
  recentErrors: AiRecentError[];
};

export type AiObservability = {
  generatedAt: string;
  windows: {
    hours24: AiWindowSummary;
    days7: AiWindowSummary;
  };
  pubgApi: {
    hours24: PubgErrorSummary;
    days7: PubgErrorSummary;
  };
};

const ERROR_LABELS: Record<string, string> = {
  auth: "로그인/권한",
  configuration: "AI 설정 누락",
  invalid_input: "입력 또는 분석 데이터 부족",
  timeout: "응답 시간 초과",
  rate_limit: "요청 제한 또는 모델 혼잡",
  parse: "AI 응답 형식 처리 실패",
  validation: "AI 응답 내용 검증 실패",
  storage: "캐시/DB 처리 실패",
  model: "AI 모델 응답 실패",
  upstream: "PUBG 외부 API 오류",
  unknown: "분류되지 않은 오류",
};

export function getAiErrorLabel(code: string | null | undefined): string {
  return ERROR_LABELS[code || "unknown"] || code || ERROR_LABELS.unknown;
}

// Older streaming routes recorded provider usage as success before final
// validation, then wrote a second error row. Preserve billing, count one outcome.
export function normalizeAiUsageRows(rows: AiUsageObservationRow[]): AiUsageObservationRow[] {
  const requests = new Map<string, AiUsageObservationRow>();
  return rows.reduce<AiUsageObservationRow[]>((result, source) => {
    const row = { ...source };
    if (row.status && row.status !== "success" && (!row.error_code || row.error_code === "unknown")) {
      row.error_code = classifyAiErrorCode(row.error_message || "");
    }
    if (!row.request_id) {
      result.push(row);
      return result;
    }
    const key = JSON.stringify([row.request_id, row.user_id, row.analysis_type, row.platform]);
    const current = requests.get(key);
    if (!current) {
      requests.set(key, row);
      result.push(row);
      return result;
    }
    current.cost_usd = Number(current.cost_usd || 0) + Number(row.cost_usd || 0);
    current.prompt_tokens = Number(current.prompt_tokens || 0) + Number(row.prompt_tokens || 0);
    current.completion_tokens = Number(current.completion_tokens || 0) + Number(row.completion_tokens || 0);
    const durations = [current.duration_ms, row.duration_ms].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
    current.duration_ms = durations.length ? Math.max(...durations) : null;
    if (row.status && row.status !== "success") {
      current.status = row.status;
      current.error_code = row.error_code;
      current.error_message = row.error_message;
    }
    if (Date.parse(row.created_at) > Date.parse(current.created_at)) current.created_at = row.created_at;
    return result;
  }, []);
}

export function getPubgErrorLabel(reason: string): string {
  return ({
    PUBG_MATCH_NOT_FOUND: "매치 데이터 없음 (404)",
    PUBG_MATCH_PARTICIPANT_NOT_FOUND: "매치 내 플레이어 없음 (404)",
    PUBG_RATE_LIMITED: "PUBG 호출 제한 (429)",
  } as Record<string, string>)[reason] || reason;
}

function getPubgErrorReason(row: PubgErrorObservationRow): string {
  if (row.status === 429) return "PUBG_RATE_LIMITED";
  return row.error_code || row.failure_stage || row.message || "unknown";
}

export function summarizeAiUsageRows(
  rows: AiUsageObservationRow[],
  windowHours: number,
  now = Date.now(),
): AiWindowSummary {
  const cutoff = now - windowHours * 60 * 60 * 1000;
  const scoped = normalizeAiUsageRows(rows).filter((row) => Date.parse(row.created_at) >= cutoff && Date.parse(row.created_at) <= now);
  const success = scoped.filter((row) => (row.status || "success") === "success");
  const failed = scoped.filter((row) => (row.status || "success") !== "success");
  const users = new Set(scoped.filter((row) => row.user_id).map((row) => row.user_id as string));
  const byType: Record<string, number> = {};
  const userCounts = new Map<string, number>();
  const errors = new Map<string, AiErrorSummary>();
  const durations = scoped
    .map((row) => row.duration_ms)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);

  for (const row of scoped) {
    if (row.user_id) userCounts.set(row.user_id, (userCounts.get(row.user_id) || 0) + 1);
    const type = row.analysis_type || "unknown";
    byType[type] = (byType[type] || 0) + 1;
  }
  for (const row of failed) {
    const code = row.error_code || "unknown";
    const current = errors.get(code);
    errors.set(code, {
      code,
      label: getAiErrorLabel(code),
      count: (current?.count || 0) + 1,
      lastAt: !current?.lastAt || Date.parse(row.created_at) > Date.parse(current.lastAt) ? row.created_at : current.lastAt,
    });
  }

  const recentErrors = failed
    .slice()
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, 20)
    .map((row, index) => ({
      id: row.id || row.request_id || `ai-error-${index}-${row.created_at}`,
      createdAt: row.created_at,
      analysisType: row.analysis_type || "unknown",
      errorCode: row.error_code || "unknown",
      errorLabel: getAiErrorLabel(row.error_code),
      message: row.error_message || getAiErrorLabel(row.error_code),
      userId: row.user_id || null,
      durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
      platform: row.platform || null,
      requestId: row.request_id || null,
    }));

  const totalRequests = scoped.length;
  return {
    windowHours,
    totalRequests,
    successRequests: success.length,
    failedRequests: failed.length,
    successRate: totalRequests ? Number(((success.length / totalRequests) * 100).toFixed(1)) : 0,
    uniqueUsers: users.size,
    guestRequests: scoped.filter((row) => !row.user_id).length,
    totalCostUsd: Number(scoped.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0).toFixed(6)),
    promptTokens: scoped.reduce((sum, row) => sum + Number(row.prompt_tokens || 0), 0),
    completionTokens: scoped.reduce((sum, row) => sum + Number(row.completion_tokens || 0), 0),
    averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    byType,
    topUsers: Array.from(userCounts, ([userId, count]) => ({ userId, count }))
      .sort((a, b) => b.count - a.count || a.userId.localeCompare(b.userId)).slice(0, 5),
    errorsByReason: Array.from(errors.values()).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    recentErrors,
  };
}

export function summarizePubgErrors(rows: PubgErrorObservationRow[], windowHours: number, now = Date.now()): PubgErrorSummary {
  const cutoff = now - windowHours * 60 * 60 * 1000;
  const scoped = rows.filter((row) => Date.parse(row.created_at) >= cutoff);
  const byStatus: Record<string, number> = {};
  const byReason = new Map<string, { count: number; lastAt: string | null }>();
  for (const row of scoped) {
    const status = String(row.status || "unknown");
    byStatus[status] = (byStatus[status] || 0) + 1;
    const reason = getPubgErrorReason(row);
    const current = byReason.get(reason);
    byReason.set(reason, {
      count: (current?.count || 0) + 1,
      lastAt: !current?.lastAt || Date.parse(row.created_at) > Date.parse(current.lastAt) ? row.created_at : current.lastAt,
    });
  }
  return {
    total: scoped.length,
    byStatus,
    byReason: Array.from(byReason.entries()).map(([reason, value]) => ({ reason, ...value })).sort((a, b) => b.count - a.count),
    recent: scoped.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 20).map((row, index) => ({
      id: row.id || row.request_id || `pubg-error-${index}-${row.created_at}`,
      createdAt: row.created_at,
      route: row.route || "unknown",
      status: typeof row.status === "number" ? row.status : null,
      reason: getPubgErrorReason(row),
      failureStage: row.failure_stage || null,
      platform: row.platform || null,
      durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
    })),
  };
}

export function buildAiObservability(
  aiRows: AiUsageObservationRow[],
  pubgRows: PubgErrorObservationRow[],
  now = Date.now(),
): AiObservability {
  return {
    generatedAt: new Date(now).toISOString(),
    windows: {
      hours24: summarizeAiUsageRows(aiRows, 24, now),
      days7: summarizeAiUsageRows(aiRows, 24 * 7, now),
    },
    pubgApi: {
      hours24: summarizePubgErrors(pubgRows, 24, now),
      days7: summarizePubgErrors(pubgRows, 24 * 7, now),
    },
  };
}
