// 단일 경기 AI 코칭의 "BGMS 기록 기준 상위 N%" 근거. 서버가 RPC로 계산한 값만 프롬프트와 응답에 쓰고,
// 응답 문장의 상위·하위 % 표현은 이 값과 맞는지 검증한다. 모집단 정의는 migration
// 20261114120000_pubg_benchmark_percentiles.sql 주석을 따른다.

export const MIN_PERCENTILE_SAMPLE_COUNT = 200;

const METRIC_LABELS = { damage: "공식 피해량", kills: "킬", survival_time: "생존 시간" } as const;
type PercentileMetric = keyof typeof METRIC_LABELS;

const MODE_LABELS: Record<string, string> = {
  solo: "솔로", "solo-fpp": "솔로 1인칭", duo: "듀오", "duo-fpp": "듀오 1인칭", squad: "스쿼드", "squad-fpp": "스쿼드 1인칭",
};
const MATCH_TYPE_LABELS: Record<string, string> = { official: "일반전", competitive: "경쟁전" };

export interface MatchAiPercentile {
  metric: PercentileMetric;
  label: string;
  direction: "top" | "bottom";
  percent: number;
  sampleCount: number;
  scope: string;
}

const finiteCount = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
};

/**
 * RPC 행을 표시용 백분위로 바꾼다. 동점을 포함해 세므로 상위·하위 모두 보수적인 값이 된다.
 * 표본이 기준보다 적거나 동점이 많아 상위·하위 어느 쪽도 절반 이내가 아니면 뺀다.
 */
export function toMatchAiPercentiles(rows: unknown): MatchAiPercentile[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): MatchAiPercentile[] => {
    const metric = row?.metric as PercentileMetric;
    const total = finiteCount(row?.sample_count), above = finiteCount(row?.at_or_above), below = finiteCount(row?.at_or_below);
    const scope = MODE_LABELS[row?.game_mode] && MATCH_TYPE_LABELS[row?.match_type]
      ? `${MODE_LABELS[row.game_mode]} ${MATCH_TYPE_LABELS[row.match_type]}` : null;
    if (!Object.hasOwn(METRIC_LABELS, metric) || !scope || total === null || above === null || below === null
      || total < MIN_PERCENTILE_SAMPLE_COUNT || above > total || below > total) return [];
    const top = Math.max(1, Math.ceil((above / total) * 100));
    const bottom = Math.max(1, Math.ceil((below / total) * 100));
    const base = { metric, label: METRIC_LABELS[metric], sampleCount: total, scope };
    if (top <= 50) return [{ ...base, direction: "top", percent: top }];
    if (bottom <= 50) return [{ ...base, direction: "bottom", percent: bottom }];
    return [];
  }).sort((a, b) => Object.keys(METRIC_LABELS).indexOf(a.metric) - Object.keys(METRIC_LABELS).indexOf(b.metric));
}

export const formatPercentileRank = (item: Pick<MatchAiPercentile, "direction" | "percent">): string =>
  `${item.direction === "top" ? "상위" : "하위"} ${item.percent}%`;

/** 프롬프트용 비교 섹션. 값이 없으면 빈 문자열이다. */
export function formatMatchAiPercentileSection(items: readonly MatchAiPercentile[]): string {
  if (items.length === 0) return "";
  const scope = items[0].scope;
  const lines = items.map((item) => `- ${item.label}: ${formatPercentileRank(item)}`);
  return `[BGMS 기록 비교] (${scope} BGMS 기록 ${items[0].sampleCount}경기 기준, 최근 90일·생존 5분 이상)\n${lines.join("\n")}`;
}

const RANK_PATTERN = /(상위|하위)\s*(\d+(?:\.\d+)?)\s*%/gu;
const RANK_FALLBACK = "BGMS 기록 비교는 근거가 없어 보류합니다.";

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readStoredPercentiles(value: unknown): MatchAiPercentile[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is MatchAiPercentile => !!item && typeof item === "object"
    && Object.hasOwn(METRIC_LABELS, item.metric) && (item.direction === "top" || item.direction === "bottom")
    && Number.isInteger(item.percent) && item.percent >= 1 && item.percent <= 50);
}

/**
 * 응답 JSON에 서버 백분위 `benchmarkPercentiles`를 넣고, 문장의 상위·하위 % 표현을 그 값으로 검증한다.
 * percentiles를 주면(새 생성) 필드를 그 값으로 덮어쓰고, 주지 않으면(캐시 응답) 저장된 필드로 검증한다.
 * 근거와 다른 % 순위가 든 문장은 지운다. JSON이 아니면 그대로 두고, 재적용해도 결과가 같다.
 */
export function applyMatchAiPercentiles(text: string, percentiles?: readonly MatchAiPercentile[]): string {
  const record = parseRecord(text);
  if (!record) return text;
  const next: Record<string, unknown> = { ...record };
  if (percentiles) {
    if (percentiles.length > 0) next.benchmarkPercentiles = percentiles;
    else delete next.benchmarkPercentiles;
  }
  const allowed = new Set(readStoredPercentiles(next.benchmarkPercentiles).map(formatPercentileRank));
  if (next.benchmarkPercentiles !== undefined && allowed.size === 0) delete next.benchmarkPercentiles;
  const supported = (sentence: string) => [...sentence.matchAll(RANK_PATTERN)]
    .every(([, side, value]) => allowed.has(`${side} ${value}%`));
  const scrub = (value: unknown, fallback: string | null): unknown => {
    if (typeof value !== "string" || supported(value)) return value;
    const kept = value.split(/(?<=[.!?。！？])\s+/u).filter(supported).join(" ").trim();
    return kept || fallback;
  };
  for (const key of ["signatureSub", "finalVerdict"]) if (key in next) next[key] = scrub(next[key], RANK_FALLBACK);
  if (typeof next.signature === "string") next.signature = next.signature.replace(RANK_PATTERN, (token) => (supported(token) ? token : "")).trim();
  if (Array.isArray(next.briefFeedback)) next.briefFeedback = next.briefFeedback.map((sentence) => scrub(sentence, RANK_FALLBACK));
  if (Array.isArray(next.actionItems)) {
    next.actionItems = next.actionItems.map((item) => (item && typeof item === "object" && !Array.isArray(item)
      ? { ...item, desc: scrub((item as Record<string, unknown>).desc, "") }
      : item));
  }
  return JSON.stringify(next) === JSON.stringify(record) ? text : JSON.stringify(next);
}

/** 이 경기의 비교 모집단 백분위. 실패하면 빈 목록으로 두고 코칭은 백분위 없이 만든다. */
export async function fetchMatchAiPercentiles(
  supabase: { rpc: (name: string, args: Record<string, unknown>) => any },
  identity: { matchId: string; platform: string; playerId: string },
  signal?: AbortSignal,
): Promise<MatchAiPercentile[]> {
  try {
    let query = supabase.rpc("get_pubg_benchmark_percentiles", {
      p_match_id: identity.matchId, p_platform: identity.platform, p_player_id: identity.playerId,
    });
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw error;
    return toMatchAiPercentiles(data);
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn("[AI-ANALYZE] Benchmark percentile lookup failed:", (error as Error)?.message || error);
    return [];
  }
}
