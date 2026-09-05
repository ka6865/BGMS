/**
 * Structural validation and pairing for the debate evidence emitted by the
 * multi-match AI summary.  Gemini is instructed to keep the two stat arrays in
 * lockstep, but the renderer must never trust array position as that contract
 * is not enforceable at runtime.
 *
 * This module intentionally has no server, database, or React dependencies so
 * the same matcher can be used at the API boundary and in the client renderer.
 */

export interface DebateStat {
  label: string;
  value: string;
}

export interface DebateStatPair {
  user: DebateStat;
  benchmark: DebateStat;
}

/**
 * Server-owned evidence for one metric.  The route fills this from the main
 * mode's already-formatted user/benchmark values; provider values are never
 * trusted for the quantitative evidence that reaches the UI.
 */
export type CanonicalDebateEvidenceMap = Readonly<Record<string, DebateStatPair>>;

const COUNT_UNIT = "count";
const UNIT_LESS = "unitless";
type MeasurementDimension = "percentage" | "duration" | "distance" | "count" | "scalar";
type MeasurementUnit = "%" | "ms" | "s" | "m" | typeof COUNT_UNIT | typeof UNIT_LESS;
type Measurement = { dimension: MeasurementDimension; unit: MeasurementUnit; baseValue: number };

const MEASUREMENT_PATTERN = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)\s*(%|ms|밀리초|s|secs?|초|m|미터|회|횟수)?$/iu;

/**
 * Canonical metric names.  Aliases are deliberately narrow: only labels that
 * describe the same metric are grouped.  In particular, generic smoke rescue
 * wording is not silently treated as the teammate-knock opportunity rate.
 */
const METRIC_DEFINITIONS: Array<{
  key: string;
  dimension: MeasurementDimension;
  aliases: string[];
}> = [
  { key: "backup_latency", dimension: "duration", aliases: [
    "아군 백업 속도", "백업 속도", "평균 백업 속도",
    "상위권 백업 속도", "동일 티어 백업 속도",
    "상위권 평균 백업 속도", "동일 티어 평균 백업 속도",
  ] },
  { key: "damage_average", dimension: "scalar", aliases: [
    "평균 화력", "평균 딜량", "평균 데미지", "평균 대미지",
    "상위권 평균 화력", "상위권 평균 딜량", "상위권 평균 데미지", "상위권 평균 대미지",
    "동일 티어 평균 화력", "동일 티어 평균 딜량", "동일 티어 평균 데미지", "동일 티어 평균 대미지",
    "상위권 화력", "상위권 딜량", "동일 티어 화력", "동일 티어 딜량",
  ] },
  { key: "initiative_rate", dimension: "percentage", aliases: [
    "주도권 성공률", "선제 공격 성공률", "평균 주도권 성공률", "평균 선제 공격 성공률",
    "상위권 주도권 성공률", "상위권 선제 공격 성공률",
    "동일 티어 주도권 성공률", "동일 티어 선제 공격 성공률",
    "상위권 평균 주도권 성공률", "상위권 평균 선제 공격 성공률",
    "동일 티어 평균 주도권 성공률", "동일 티어 평균 선제 공격 성공률",
  ] },
  { key: "duel_win_rate", dimension: "percentage", aliases: [
    "1:1 교전 승률", "1:1 승률", "평균 1:1 교전 승률", "평균 1:1 승률",
    "상위권 1:1 승률", "동일 티어 1:1 승률", "상위권 1:1 교전 승률", "동일 티어 1:1 교전 승률",
    "상위권 평균 1:1 교전 승률", "동일 티어 평균 1:1 교전 승률",
    "상위권 평균 1:1 승률", "동일 티어 평균 1:1 승률",
    // Prompt prose sometimes decorates the metric instead of using the
    // evidence label verbatim (for example, "1:1 교전에서의 괴물 같은
    // 결정력(79%)"). Keep these aliases explicit and narrow so generic
    // "결정력" wording is not guessed as a duel metric.
    "1:1 교전 결정력", "1:1 교전에서의 결정력", "1:1 교전에서의 괴물 같은 결정력",
    "1:1 교전에서의 괴물같은 결정력",
  ] },
  { key: "pressure_index", dimension: "scalar", aliases: [
    "압박 지수", "평균 압박 지수", "상위권 압박 지수", "동일 티어 압박 지수",
    "상위권 평균 압박 지수", "동일 티어 평균 압박 지수",
  ] },
  { key: "reaction_latency", dimension: "duration", aliases: [
    "대응 사격 속도", "반응 속도", "평균 대응 사격 속도", "평균 반응 속도",
    "상위권 대응 사격 속도", "동일 티어 대응 사격 속도",
    "상위권 평균 대응 사격 속도", "동일 티어 평균 대응 사격 속도",
    "상위권 반응 속도", "동일 티어 반응 속도", "상위권 평균 반응 속도", "동일 티어 평균 반응 속도",
  ] },
  { key: "smoke_opportunity_rate", dimension: "percentage", aliases: [
    "아군 기절 대비 연막 구출률", "아군 기절 대비 연막 구출 성공률",
    "아군 기절 대비 평균 연막 구출률", "아군 기절 대비 평균 연막 구출 성공률",
    "상위권 아군 기절 대비 연막 구출률", "상위권 아군 기절 대비 연막 구출 성공률",
    "동일 티어 아군 기절 대비 연막 구출률", "동일 티어 아군 기절 대비 연막 구출 성공률",
    "상위권 기회 대비 평균 연막 구출률", "상위권 기회 대비 평균 연막 구출 성공률",
    "동일 티어 기회 대비 평균 연막 구출률", "동일 티어 기회 대비 평균 연막 구출 성공률",
  ] },
  { key: "trade_success_rate", dimension: "percentage", aliases: [
    "복수 성공률", "트레이드 성공률", "평균 복수 성공률", "평균 트레이드 성공률",
    "상위권 복수 성공률", "동일 티어 복수 성공률", "상위권 평균 복수 성공률", "동일 티어 평균 복수 성공률",
    "상위권 트레이드 성공률", "동일 티어 트레이드 성공률",
    "상위권 평균 트레이드 성공률", "동일 티어 평균 트레이드 성공률",
  ] },
  { key: "solo_kill_share", dimension: "percentage", aliases: [
    "솔로 비중", "솔로 킬 비중", "평균 솔로 비중", "평균 솔로 킬 비중",
    "상위권 솔로 비중", "상위권 솔로 킬 비중", "동일 티어 솔로 비중", "동일 티어 솔로 킬 비중",
    "상위권 평균 솔로 비중", "상위권 평균 솔로 킬 비중",
    "동일 티어 평균 솔로 비중", "동일 티어 평균 솔로 킬 비중",
  ] },
  { key: "death_phase", dimension: "scalar", aliases: [
    "사망 페이즈", "평균 사망 페이즈", "상위권 사망 페이즈", "동일 티어 사망 페이즈",
    "상위권 평균 사망 페이즈", "동일 티어 평균 사망 페이즈",
  ] },
];

const METRIC_BY_KEY = new Map(METRIC_DEFINITIONS.map((metric) => [metric.key, metric]));

// The UI/prompt names this debate topic `1:1 결정력`, and Gemini can reuse
// that exact wording in the structured stat arrays. Accept it only while
// pairing those arrays: treating the short topic label as measured prose
// would make the benchmark sanitizer erase a safe card title whenever the
// benchmark itself is unavailable.
const PAIR_ONLY_METRIC_ALIASES = new Map<string, string>([
  ["1:1 결정력", "duel_win_rate"],
  ["평균 1:1 결정력", "duel_win_rate"],
  ["상위권 1:1 결정력", "duel_win_rate"],
  ["동일 티어 1:1 결정력", "duel_win_rate"],
  ["상위권 평균 1:1 결정력", "duel_win_rate"],
  ["동일 티어 평균 1:1 결정력", "duel_win_rate"],
]);

const BENCHMARK_LANGUAGE_PATTERN = /(?:동일\s*조건\s*[·ㆍ・.]?\s*동일\s*티어|동일\s*티어|상위권|엘리트|벤치마크|benchmark)/iu;
const NUMERIC_VALUE_PATTERN = /[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)\s*(?:%|ms|밀리초|s|secs?|초|m|미터|회|횟수)?/iu;
const NUMERIC_VALUE_SOURCE = "[+-]?(?:(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|\\.\\d+)\\s*(?:%|ms|밀리초|s|secs?|초|m|미터|회|횟수)?";
const SAFE_UNRELATED_COUNT_PATTERN = /(?:최근|지난)\s*([+-]?(?:\d{1,3}(?:,\d{3})+|\d+))\s*(?:판|경기)/giu;

function normalizeSummaryMode(mode: string): string {
  const normalized = mode.trim().toLocaleLowerCase();
  if (normalized.includes("solo-squad") || normalized.includes("solo_squad")) return "solo-squad";
  if (normalized.includes("solo-duo") || normalized.includes("solo_duo")) return "solo-duo";
  if (normalized.includes("squad") || normalized.includes("스쿼드")) return "squad";
  if (normalized.includes("duo") || normalized.includes("듀오")) return "duo";
  if (normalized.includes("solo") || normalized.includes("솔로")) return "solo";
  return normalized;
}

function summaryModeMarkers(value: string): Set<string> {
  const protectedCompoundModes: Array<{ mode: string; pattern: RegExp }> = [
    { mode: "solo-squad", pattern: /(?:솔로\s*스쿼드|solo[\s_-]*squad)/giu },
    { mode: "solo-duo", pattern: /(?:솔로\s*듀오|solo[\s_-]*duo)/giu },
  ];
  const markers = new Set<string>();
  let remaining = value;
  // `solo` is also a telemetry concept (a kill earned without meaningful
  // teammate damage), not only a PUBG queue mode. Protect the explicit
  // metric phrases before scanning prose for foreign-mode markers so a DUO
  // debate about solo kills is not discarded as mixed-mode evidence.
  const soloMetricPatterns = [
    /(?:순수\s*무력\s*)?솔로\s*킬(?!\s*(?:비중\s*)?(?:모드|경기(?!당)|게임|매치|큐(?:우)?|queue|룰셋))(?:\s*비중)?/giu,
    /솔로\s*비중(?!\s*(?:모드|경기(?!당)|게임|매치|큐(?:우)?|queue|룰셋))/giu,
    /솔로\s*교전력(?!\s*(?:모드|경기(?!당)|게임|매치|큐(?:우)?|queue|룰셋))/giu,
  ];
  soloMetricPatterns.forEach((pattern) => {
    remaining = remaining.replace(pattern, " ");
  });
  protectedCompoundModes.forEach(({ mode, pattern }) => {
    if (pattern.test(remaining)) markers.add(mode);
    remaining = remaining.replace(pattern, " ");
  });
  if (/(?:스쿼드|squad)/iu.test(remaining)) markers.add("squad");
  if (/(?:듀오|duo)/iu.test(remaining)) markers.add("duo");
  if (/(?:솔로|solo)/iu.test(remaining)) markers.add("solo");
  return markers;
}

/** Return true when any prose field in a payload explicitly names another mode. */
export function hasUnsupportedAiSummaryMode(value: unknown, allowedMode: string): boolean {
  const normalizedAllowedMode = normalizeSummaryMode(allowedMode);
  const visit = (candidate: unknown): boolean => {
    if (typeof candidate === "string") {
      const markers = summaryModeMarkers(candidate);
      return Array.from(markers).some((marker) => marker !== normalizedAllowedMode);
    }
    if (Array.isArray(candidate)) return candidate.some(visit);
    if (candidate && typeof candidate === "object") {
      return Object.values(candidate as Record<string, unknown>).some(visit);
    }
    return false;
  };
  return visit(value);
}

/**
 * A benchmark comparison is only allowed to keep a provider-authored
 * direction when the predicate names a measurable direction and that
 * direction is meaningful for the metric.  Generic quality words such as
 * `좋다` are deliberately not mapped: the sanitizer cannot know whether a
 * higher damage/latency value is favourable from prose alone.
 */
type DirectionPredicate = "generic" | "higher" | "lower" | "faster" | "slower" | null;

const GENERIC_DIRECTION_PATTERN = /(?:좋(?:습니다|다|아요|은|게)|우수(?:합니다|하다|해요)?|뛰어나(?:요|다|습니다)?|better|best)/iu;
const HIGHER_DIRECTION_PATTERN = /(?:더\s*)?(?:높(?:습니다|다|아요|은)|많(?:습니다|다|아요|은)|상회|초과|higher|above|more)/iu;
const LOWER_DIRECTION_PATTERN = /(?:더\s*)?(?:낮(?:습니다|다|아요|은)|적(?:습니다|다|어요|은)|미만|lower|below|less)/iu;
const FASTER_DIRECTION_PATTERN = /(?:더\s*)?(?:빠르(?:습니다|다|어요|은)|신속(?:합니다|하다|해요)?|fast(?:er)?)/iu;
const SLOWER_DIRECTION_PATTERN = /(?:더\s*)?(?:느리(?:습니다|다|어요|은)|slow(?:er)?)/iu;

/** Metrics for which a larger canonical value is a favourable comparison. */
const HIGHER_IS_BETTER: Readonly<Record<string, boolean>> = {
  damage_average: true,
  initiative_rate: true,
  duel_win_rate: true,
  pressure_index: true,
  smoke_opportunity_rate: true,
  trade_success_rate: true,
  solo_kill_share: true,
  death_phase: true,
  backup_latency: false,
  reaction_latency: false,
};

function directionPredicate(value: string): DirectionPredicate {
  if (FASTER_DIRECTION_PATTERN.test(value)) return "faster";
  if (SLOWER_DIRECTION_PATTERN.test(value)) return "slower";
  if (HIGHER_DIRECTION_PATTERN.test(value)) return "higher";
  if (LOWER_DIRECTION_PATTERN.test(value)) return "lower";
  if (GENERIC_DIRECTION_PATTERN.test(value)) return "generic";
  return null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function compactLabel(label: string): string {
  // Whitespace/case normalization is safe for labels. Do not strip
  // punctuation or qualifier text here: doing so would silently turn an
  // unknown label into one of the explicit aliases (for example, `11 승률`
  // into `1:1 승률`) and reintroduce the very fuzzy pairing this boundary is
  // intended to prevent.
  return label
    .toLocaleLowerCase()
    .trim()
    .replace(/\s*:\s*/g, ":")
    .replace(/\s+/g, " ");
}

function metricKey(label: string): string | null {
  const compact = compactLabel(label);
  const pairOnlyKey = PAIR_ONLY_METRIC_ALIASES.get(compact);
  if (pairOnlyKey) return pairOnlyKey;
  for (const metric of METRIC_DEFINITIONS) {
    if (metric.aliases.some((alias) => compactLabel(alias) === compact)) return metric.key;
  }
  // Unknown labels are deliberately not pairable.  An exact match is not
  // enough: Gemini frequently emits generic labels (for example, "항목" or
  // "상위권") whose apparent equality says nothing about the metric.
  return null;
}

function metricKeysInText(value: string): string[] {
  const compact = compactLabel(value);
  return METRIC_DEFINITIONS
    .filter((metric) => metric.aliases.some((alias) => compact.includes(compactLabel(alias))))
    .map((metric) => metric.key);
}

function splitBenchmarkLanguageClauses(value: string): string[] {
  // Gemini tends to place one comparison per comma/conjunction. Splitting at
  // these boundaries lets us remove one unsupported metric while preserving a
  // supported comparison in the same paragraph. Comparison words such as
  // `대비`/`vs` deliberately stay inside one clause: they join the benchmark
  // and user values that must be canonicalized as a pair.
  return value
    .split(/(?<=[.!?。！？,，;；])\s*|\s+(?:(?:그리고|및|하지만|다만|반면에)\s+)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ComparisonSide = "user" | "benchmark" | null;

type MetricNumberOccurrence = {
  aliasStart: number;
  aliasEnd: number;
  numberStart: number;
  numberEnd: number;
  side: ComparisonSide;
};

const COMPARISON_BOUNDARY_PATTERN = /(?:대비|비교하면|비교해|vs|보다|그리고|및|하지만|다만|반면에|[,，;；.!?。！？])/giu;
const USER_COMPARISON_MARKER_PATTERN = /(?:내|나의|유저|사용자|현재(?:\s*기록)?)/iu;
const BENCHMARK_DIRECTIONAL_PATTERN = /(?:벤치마크|benchmark|동일\s*조건\s*[·ㆍ・.]?\s*동일\s*티어|동일\s*티어|상위권|엘리트)(?:\s*(?:을|를|에|과|와|보다|대비|기준(?:으로)?))?\s*(?:크게|완전히|상당히|훨씬)?\s*(?:압도(?:합니다|했다|한다|해요)?|미달(?:합니다|했다|한다|해요)?|우위(?:입니다|다|에\s*있습니다?|에\s*있다)?|열위(?:입니다|다|에\s*있습니다?|에\s*있다)?|능가(?:합니다|했다|한다|해요)?|앞서(?:갑니다|갑니다|고|며|있습니다?|있다)?|뒤처져?(?:\s*있습니다?|\s*있다)?)/iu;
const NEUTRAL_BENCHMARK_COMPARISON = "검증된 경기 지표를 바탕으로 분석합니다";
const NEUTRAL_BENCHMARK_SENTENCE = `${NEUTRAL_BENCHMARK_COMPARISON}.`;
const DEBATE_QUESTION_END_PATTERN = /(?:[?？]|(?:인가|일까|할까|했나|있는가|어떤가|충분한가)(?:요)?[.!]?)\s*$/u;

function findNumericToken(value: string, offset: number, leading: boolean): { start: number; end: number } | null {
  const pattern = new RegExp(
    leading
      ? `^\\s*(?:[:：]?\\s*)?(?:이|가|은|는|을|를|의|에|:|：)?\\s*(\\(\\s*${NUMERIC_VALUE_SOURCE}\\s*\\)|${NUMERIC_VALUE_SOURCE})`
      : `(\\(\\s*${NUMERIC_VALUE_SOURCE}\\s*\\)|${NUMERIC_VALUE_SOURCE})\\s*(?:의|에|대비|보다|이|가|은|는|을|를)?\\s*$`,
    "iu",
  );
  const match = value.match(pattern);
  if (!match) return null;

  // NUMERIC_VALUE_SOURCE intentionally allows an optional unit and spacing.
  // Return the parenthesized token as a whole when present so a replacement
  // does not leave a dangling `)` in prose such as `평균 화력(298)`. The
  // surrounding Korean particle is excluded from the replacement range.
  const token = match[1];
  const tokenOffset = match[0].indexOf(token);
  return {
    start: offset + tokenOffset,
    end: offset + tokenOffset + token.length,
  };
}

function comparisonSegmentPrefix(value: string, index: number): string {
  const prefix = value.slice(0, index);
  let boundaryEnd = 0;
  for (const match of prefix.matchAll(COMPARISON_BOUNDARY_PATTERN)) {
    if (match.index !== undefined) boundaryEnd = match.index + match[0].length;
  }
  return prefix.slice(boundaryEnd);
}

function metricNumberOccurrences(clause: string, metric: (typeof METRIC_DEFINITIONS)[number]): MetricNumberOccurrence[] {
  const aliases = metric.aliases
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  if (!aliases) return [];

  const aliasPattern = new RegExp(aliases, "giu");
  const occurrences: MetricNumberOccurrence[] = [];
  for (const match of clause.matchAll(aliasPattern)) {
    const aliasStart = match.index;
    if (aliasStart === undefined) continue;
    const alias = match[0];
    const aliasEnd = aliasStart + alias.length;
    const beforeStart = Math.max(0, aliasStart - 80);
    const before = clause.slice(beforeStart, aliasStart);
    const after = clause.slice(aliasEnd, Math.min(clause.length, aliasEnd + 80));
    const afterNumber = findNumericToken(after, aliasEnd, true);
    const beforeNumber = findNumericToken(before, beforeStart, false);
    const number = afterNumber || beforeNumber;
    if (!number) continue;

    const localPrefix = comparisonSegmentPrefix(clause, aliasStart);
    const side: ComparisonSide = BENCHMARK_LANGUAGE_PATTERN.test(alias)
      || BENCHMARK_LANGUAGE_PATTERN.test(localPrefix)
      ? "benchmark"
      : USER_COMPARISON_MARKER_PATTERN.test(localPrefix)
        ? "user"
        : null;
    occurrences.push({ aliasStart, aliasEnd, numberStart: number.start, numberEnd: number.end, side });
  }
  return occurrences;
}

function numericTokenRanges(value: string): Array<{ start: number; end: number }> {
  const pattern = new RegExp(NUMERIC_VALUE_SOURCE, "giu");
  return Array.from(value.matchAll(pattern))
    .map((match) => {
      const start = match.index ?? -1;
      return start >= 0 ? { start, end: start + match[0].length } : null;
    })
    .filter((range): range is { start: number; end: number } => range !== null);
}

function safeSampleCountRanges(value: string): Array<{ start: number; end: number }> {
  return Array.from(value.matchAll(SAFE_UNRELATED_COUNT_PATTERN))
    .map((match) => {
      const fullStart = match.index ?? -1;
      const token = match[1];
      if (fullStart < 0 || !token) return null;
      const tokenStart = fullStart + match[0].indexOf(token);
      return { start: tokenStart, end: tokenStart + token.length };
    })
    .filter((range): range is { start: number; end: number } => range !== null);
}

function metricNumberRanges(value: string): Array<{ start: number; end: number }> {
  return METRIC_DEFINITIONS.flatMap((metric) => metricNumberOccurrences(value, metric)
    .map(({ numberStart, numberEnd }) => ({ start: numberStart, end: numberEnd })));
}

function hasUnsafeUnattachedNumber(clause: string): boolean {
  const attachedRanges = metricNumberRanges(clause);
  const safeSampleRanges = safeSampleCountRanges(clause);
  return numericTokenRanges(clause).some(({ start, end }) => {
    // Ratio-style metric labels such as `1:1` contain digits but are not
    // measured values.
    if (clause[start - 1] === ":" || clause[end] === ":") return false;
    const attached = attachedRanges.some((range) => start >= range.start && end <= range.end);
    if (attached) return false;

    // Keep only the exact numeric token in an explicit sample-window phrase
    // (`최근 N판`/`지난 N경기`). Nearby numbers are provider-owned evidence;
    // checking a broad context would let `최근 3판에서 999킬` launder 999.
    const isSafeSampleCount = safeSampleRanges.some((range) => start === range.start && end === range.end);
    return !isSafeSampleCount;
  });
}

function hasUnsafeQuestionNumber(question: string): boolean {
  const safeSampleRanges = safeSampleCountRanges(question);
  return numericTokenRanges(question).some(({ start, end }) => {
    // `1:1` is a metric name, not a provider-authored measurement.
    if (question[start - 1] === ":" || question[end] === ":") return false;
    return !safeSampleRanges.some((range) => start === range.start && end === range.end);
  });
}

function canonicalizeSupportedMetricClause(
  clause: string,
  metricKeyValue: string,
  canonicalEvidence: CanonicalDebateEvidenceMap,
): string | null {
  const metric = METRIC_BY_KEY.get(metricKeyValue);
  const canonical = canonicalEvidence[metricKeyValue];
  if (!metric || !canonical) return null;

  const canonicalUser = toStat(canonical.user);
  const canonicalBenchmark = toStat(canonical.benchmark);
  if (!canonicalUser || !canonicalBenchmark
    || !unitsCompatible(metricKeyValue, canonicalUser.value, canonicalBenchmark.value)) return null;

  const occurrences = metricNumberOccurrences(clause, metric);
  if (occurrences.length === 0) return null;

  const benchmarkOccurrences = occurrences.filter(({ side }) => side === "benchmark");
  const userOccurrences = occurrences.filter(({ side }) => side === "user");
  const unresolvedOccurrences = occurrences.filter(({ side }) => side === null);

  // A comparison normally has one occurrence on each side. If one side has
  // no explicit marker, infer it only when the other side is unambiguous. Any
  // remaining ambiguity fails closed rather than choosing a fabricated value.
  if (benchmarkOccurrences.length > 1 || userOccurrences.length > 1) return null;
  if (unresolvedOccurrences.length > 0) {
    if (unresolvedOccurrences.length === 1 && benchmarkOccurrences.length === 1 && userOccurrences.length === 0) {
      // `상위권 평균 화력 250 대비 평균 화력 320`: the explicit benchmark
      // occurrence identifies the other value as user-owned.
      unresolvedOccurrences[0].side = "user";
    } else if (unresolvedOccurrences.length === 1 && userOccurrences.length === 1 && benchmarkOccurrences.length === 0) {
      // `내 평균 화력 320 대비 평균 화력 250`: the explicit user
      // occurrence identifies the other value as benchmark-owned.
      unresolvedOccurrences[0].side = "benchmark";
    } else if (/(?:대비|비교하면|비교해|vs|보다)/iu.test(clause) && unresolvedOccurrences.length >= 2) {
      // With no explicit side markers, a comparison operator separates the
      // user value from the benchmark value. All occurrences before it are
      // user-side; all after it are benchmark-side.
      const operatorIndex = clause.search(/(?:대비|비교하면|비교해|vs|보다)/iu);
      unresolvedOccurrences.forEach((occurrence) => {
        occurrence.side = occurrence.aliasStart < operatorIndex ? "user" : "benchmark";
      });
    } else {
      // A bare recognized metric (including `내 평균 화력 999`) is a
      // user-owned value unless an explicit benchmark qualifier says
      // otherwise. This also handles two user metrics in a sentence such as
      // `1:1 결정력(79%)과 평균 화력(298)은 벤치마크를...`.
      unresolvedOccurrences.forEach((occurrence) => { occurrence.side = "user"; });
    }
  }

  if (occurrences.some(({ side }) => side === null)) return null;

  const replacements = occurrences.map((occurrence) => {
    const stat = occurrence.side === "benchmark" ? canonicalBenchmark : canonicalUser;
    const start = Math.min(occurrence.aliasStart, occurrence.numberStart);
    const end = Math.max(occurrence.aliasEnd, occurrence.numberEnd);
    const originalNumber = clause.slice(occurrence.numberStart, occurrence.numberEnd).trim();
    const value = originalNumber.startsWith("(")
      ? `${stat.label}(${stat.value})`
      : `${stat.label} ${stat.value}`;
    return { start, end, value };
  });

  // Replace right-to-left so source offsets stay stable. Overlap should only
  // be possible for deliberately ambiguous provider prose; fail closed if it
  // occurs rather than emitting a partially rewritten sentence.
  replacements.sort((a, b) => b.start - a.start);
  for (let index = 1; index < replacements.length; index += 1) {
    if (replacements[index - 1].start < replacements[index].end) return null;
  }
  let result = clause;
  replacements.forEach(({ start, end, value }) => {
    result = `${result.slice(0, start)}${value}${result.slice(end)}`;
  });
  return result.replace(/\s{2,}/g, " ").trim();
}

function validateBenchmarkDirection(
  clause: string,
  metricKeyValue: string,
  canonicalUser: DebateStat,
  canonicalBenchmark: DebateStat,
): boolean {
  const predicate = directionPredicate(clause);
  if (predicate === null) return true;
  // Generic quality predicates (`좋다`, `우수하다`, …) are not tied to a
  // metric's monotonic direction and therefore cannot be proven at this
  // boundary.  Keep comparative prose fail-closed instead of guessing.
  if (predicate === "generic") return false;

  const metric = METRIC_BY_KEY.get(metricKeyValue);
  if (!metric) return false;
  const higherIsBetter = HIGHER_IS_BETTER[metricKeyValue];
  if (higherIsBetter === undefined) return false;
  const userMeasurement = parseMeasurement(canonicalUser.value);
  const benchmarkMeasurement = parseMeasurement(canonicalBenchmark.value);
  if (!userMeasurement || !benchmarkMeasurement
    || userMeasurement.dimension !== benchmarkMeasurement.dimension) return false;

  const occurrences = metricNumberOccurrences(clause, metric);
  const userOccurrence = occurrences.find(({ side }) => side === "user");
  const benchmarkOccurrence = occurrences.find(({ side }) => side === "benchmark");
  if (!userOccurrence || !benchmarkOccurrence) return false;

  // The predicate normally describes the nearest metric occurrence to its
  // left (`... 내 수치가 높습니다`).  If a provider writes the benchmark as
  // the subject, the same comparison is evaluated in the opposite order.
  const predicateMatch = clause.match(/(?:높|낮|빠르|느리|상회|초과|미만|more|less|above|below|faster|slower|higher|lower)/iu);
  const predicateIndex = predicateMatch?.index ?? -1;
  if (predicateIndex < 0) return false;
  const preceding = occurrences
    .filter(({ aliasEnd }) => aliasEnd <= predicateIndex)
    .sort((a, b) => b.aliasEnd - a.aliasEnd)[0];
  const subjectSide: ComparisonSide = preceding?.side || null;
  if (subjectSide === null) return false;

  const subjectValue = subjectSide === "user" ? userMeasurement.baseValue : benchmarkMeasurement.baseValue;
  const otherValue = subjectSide === "user" ? benchmarkMeasurement.baseValue : userMeasurement.baseValue;
  const epsilon = 1e-9;
  if (Math.abs(subjectValue - otherValue) <= epsilon) return false;

  const higher = subjectValue > otherValue;
  if (predicate === "higher") return higherIsBetter === true && higher;
  if (predicate === "lower") return higherIsBetter === false && !higher;
  if (predicate === "faster") return metric.dimension === "duration" && higherIsBetter === false && !higher;
  if (predicate === "slower") return metric.dimension === "duration" && higherIsBetter === false && higher;
  return false;
}

/**
 * Remove benchmark comparison prose for metrics that have no server-owned
 * evidence. Provider stat arrays are canonicalized separately, but prose
 * fields can still repeat a NULL benchmark number (for example, "상위권
 * 평균 50%의 1:1 승률"). A global qualifier replacement is insufficient: it
 * leaves the number behind and also erases legitimate observed comparisons
 * for metrics that are present. This helper fails closed per clause/metric.
 */
export function sanitizeUnsupportedAiSummaryBenchmarkLanguage(
  value: string,
  canonicalEvidence: CanonicalDebateEvidenceMap = {},
  options: { allowedMode?: string } = {},
): string {
  const supportedMetricKeys = new Set(Object.keys(canonicalEvidence));
  const clauses = splitBenchmarkLanguageClauses(value);
  const retained: string[] = [];

  const allowedMode = typeof options.allowedMode === "string" ? normalizeSummaryMode(options.allowedMode) : null;

  clauses.forEach((rawClause) => {
    let clause = rawClause;
    const keys = metricKeysInText(clause);
    const unsupportedKeys = keys.filter((key) => !supportedMetricKeys.has(key));
    const hasBenchmarkLanguage = BENCHMARK_LANGUAGE_PATTERN.test(clause);
    const hasNumericValue = NUMERIC_VALUE_PATTERN.test(clause);

    // Canonical evidence is scoped to the route's primary mode. A minority
    // mode marker next to a metric/benchmark claim must not be rewritten with
    // that primary-mode value. Keep standalone mode labels untouched, but
    // drop any measured/comparative minority-mode clause.
    const hasForeignMode = allowedMode !== null
      && hasUnsupportedAiSummaryMode(clause, allowedMode);
    if (hasForeignMode
      && (hasBenchmarkLanguage || hasNumericValue || keys.length > 0)) return;

    // Unknown metrics and benchmark claims cannot be grounded by the
    // route-owned evidence map. Removing only one phrase can strand its
    // provider number or leave a directional conclusion attached to a
    // supported metric, so fail closed for the whole clause.
    if (unsupportedKeys.length > 0 || (hasBenchmarkLanguage && keys.length === 0)) return;

    // A free numeric token must either be attached to a recognized metric or
    // be the explicit sample-window count ("최근 N판"/"지난 N경기"). This is
    // the key guard for mixed clauses such as "평균 화력 320과 비밀 지표
    // 777은 상위권보다...": the supported metric does not launder 777.
    if (hasNumericValue && hasUnsafeUnattachedNumber(clause)) return;

    // Provider prose is not an evidence boundary. For a recognized metric
    // that has server-owned user/benchmark values, rewrite only the number
    // immediately attached to that metric (and its label) with canonical
    // evidence. This preserves unrelated counts in the same sentence while
    // preventing fabricated `999`-style values from reaching fresh or cached
    // summary output. If the provider gives an ambiguous metric comparison,
    // fail closed for that clause instead of guessing which side a number
    // belongs to.
    if (hasNumericValue && keys.length > 0) {
      const supportedKeys = keys.filter((key) => supportedMetricKeys.has(key));
      for (const key of supportedKeys) {
        const metric = METRIC_BY_KEY.get(key);
        if (!metric || metricNumberOccurrences(clause, metric).length === 0) continue;
        const canonicalized = canonicalizeSupportedMetricClause(clause, key, canonicalEvidence);
        if (!canonicalized) return;
        clause = canonicalized;
      }

      const metricOccurrences = supportedKeys.flatMap((key) => {
        const metric = METRIC_BY_KEY.get(key);
        return metric ? metricNumberOccurrences(clause, metric) : [];
      });
      // A lone benchmark value is not a comparison and gives the provider an
      // opportunity to smuggle a made-up tier claim into otherwise valid
      // prose. Keep only explicit user↔benchmark pairs (or user-only metrics).
      if (hasBenchmarkLanguage
        && metricOccurrences.length > 0
        && metricOccurrences.every(({ side }) => side === "benchmark")
        && !/(?:대비|비교하면|비교해|vs|보다)/iu.test(clause)) return;
    }

    // Benchmark language without an attached, route-owned metric value is a
    // qualitative claim rather than evidence (for example, "평균 화력은
    // 상위권 수준입니다"). Do not let it reach the UI.
    if (hasBenchmarkLanguage && keys.length > 0) {
      const hasAttachedSupportedMetric = keys.some((key) => {
        const metric = METRIC_BY_KEY.get(key);
        return Boolean(metric && metricNumberOccurrences(clause, metric).length > 0);
      });
      if (!hasAttachedSupportedMetric) return;
    }

    // Canonical values do not automatically prove the provider's conclusion
    // about a comparison.  Keep only an explicit, metric-compatible
    // directional predicate whose relation agrees with those values. Generic
    // words such as `좋습니다` are intentionally unprovable and drop the
    // entire clause.
    if (hasBenchmarkLanguage && keys.some((key) => supportedMetricKeys.has(key))) {
      // Strong benchmark predicates such as `벤치마크를 압도합니다` do not
      // carry a measurable threshold. Remove the predicate and retain only
      // the already-canonicalized evidence; a bare neutral sentence is safe.
      if (BENCHMARK_DIRECTIONAL_PATTERN.test(clause)) {
        clause = clause.replace(BENCHMARK_DIRECTIONAL_PATTERN, NEUTRAL_BENCHMARK_COMPARISON);
      }
      const directionalKeys = keys.filter((key) => supportedMetricKeys.has(key));
      for (const key of directionalKeys) {
        const metric = METRIC_BY_KEY.get(key);
        const canonical = canonicalEvidence[key];
        const canonicalUser = canonical ? toStat(canonical.user) : null;
        const canonicalBenchmark = canonical ? toStat(canonical.benchmark) : null;
        if (!metric || !canonicalUser || !canonicalBenchmark) return;
        if (!validateBenchmarkDirection(clause, key, canonicalUser, canonicalBenchmark)) return;
      }
    }

    retained.push(clause);
  });

  const sanitized = retained.join(" ").replace(/\s{2,}/g, " ").trim();
  // normalizeAiSummaryDebatePayload validates non-empty fields before this
  // guard runs. Keep that shape valid even if every clause was unsafe.
  return sanitized || NEUTRAL_BENCHMARK_SENTENCE;
}

/**
 * Debate questions are prompts for the two coaches, not factual conclusions.
 * Preserve a natural, non-numeric question when the issue actually owns a
 * benchmark pair; the general prose sanitizer is deliberately stricter and
 * would otherwise replace useful questions such as "상위권과 비교하면
 * 화력은 충분한가?" with the same generic notice on every card.
 *
 * Questions containing unsafe numbers, another game mode, or a benchmark
 * comparison without issue-level evidence fall back to a topic-specific
 * question. This also repairs already-cached generic notices without trusting
 * any provider-authored measurement.
 */
export function sanitizeAiSummaryDebateQuestion(
  value: string,
  topic: string,
  canonicalEvidence: CanonicalDebateEvidenceMap = {},
  options: { allowedMode?: string; userStats?: unknown; benchmarkStats?: unknown } = {},
): string {
  const normalizedTopic = topic.trim() || "분석 항목";
  const fallback = `${normalizedTopic}에 대한 두 코치의 평가는?`;
  const question = value.trim();
  if (!question) return fallback;
  if (!DEBATE_QUESTION_END_PATTERN.test(question)) return fallback;
  if (hasUnsafeQuestionNumber(question)) return fallback;
  if (options.allowedMode && hasUnsupportedAiSummaryMode(question, options.allowedMode)) return fallback;

  const issueMetricKeys = new Set(
    matchDebateStatPairs(options.userStats, options.benchmarkStats)
      .map((pair) => metricKey(pair.user.label))
      .filter((key): key is string => key !== null && canonicalEvidence[key] !== undefined),
  );
  const questionMetricKeys = metricKeysInText(question);
  const hasBenchmarkLanguage = BENCHMARK_LANGUAGE_PATTERN.test(question);
  if (hasBenchmarkLanguage && issueMetricKeys.size === 0) return fallback;
  if (questionMetricKeys.some((key) => !issueMetricKeys.has(key))) return fallback;

  const sanitized = sanitizeUnsupportedAiSummaryBenchmarkLanguage(
    question,
    canonicalEvidence,
    { allowedMode: options.allowedMode },
  );
  if (sanitized !== NEUTRAL_BENCHMARK_SENTENCE) return sanitized;

  return question;
}

function parseMeasurement(value: string): Measurement | null {
  const match = value.trim().match(MEASUREMENT_PATTERN);
  if (!match) return null;

  const numericText = match[0]
    .slice(0, match[0].length - (match[1]?.length || 0))
    .trim()
    .replace(/,/g, "");
  const number = Number(numericText);
  if (!Number.isFinite(number)) return null;

  const rawUnit = match[1]?.toLocaleLowerCase();
  let unit: MeasurementUnit = UNIT_LESS;
  if (rawUnit === "%") unit = "%";
  else if (rawUnit === "ms" || rawUnit === "밀리초") unit = "ms";
  else if (rawUnit === "s" || rawUnit === "sec" || rawUnit === "secs" || rawUnit === "초") unit = "s";
  else if (rawUnit === "m" || rawUnit === "미터") unit = "m";
  else if (rawUnit === "회" || rawUnit === "횟수") unit = COUNT_UNIT;
  const dimension: MeasurementDimension = unit === "%"
    ? "percentage"
    : unit === "ms" || unit === "s"
      ? "duration"
      : unit === "m"
        ? "distance"
        : unit === COUNT_UNIT
          ? "count"
          : "scalar";
  const baseValue = unit === "s" ? number * 1000 : number;
  if (!Number.isFinite(baseValue) || baseValue < 0 || (dimension === "percentage" && baseValue > 100)) return null;
  return { dimension, unit, baseValue };
}

function unitsCompatible(metricKeyValue: string, userValue: string, benchmarkValue: string): boolean {
  const metric = METRIC_BY_KEY.get(metricKeyValue);
  if (!metric) return false;
  const userMeasurement = parseMeasurement(userValue);
  const benchmarkMeasurement = parseMeasurement(benchmarkValue);
  return userMeasurement !== null
    && benchmarkMeasurement !== null
    && userMeasurement.dimension === metric.dimension
    && benchmarkMeasurement.dimension === metric.dimension;
}

function toStat(value: unknown): DebateStat | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const label = typeof record.label === "string" ? record.label.trim() : "";
  const statValue = text(record.value);
  if (!label || !statValue) return null;
  return { label, value: statValue };
}

type DebateStatEntry = {
  stat: DebateStat | null;
  metric: string | null;
};

function toStatEntries(value: unknown): DebateStatEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((rawStat) => {
    const record = rawStat && typeof rawStat === "object"
      ? rawStat as Record<string, unknown>
      : null;
    const label = typeof record?.label === "string" ? record.label.trim() : "";
    return {
      stat: toStat(rawStat),
      // Count a known label even when its value is malformed. A duplicate
      // metric must fail closed rather than becoming pairable merely because
      // one duplicate row was filtered out before validation.
      metric: label ? metricKey(label) : null,
    };
  });
}

/**
 * Pair only semantically identical metrics with compatible value units.  The
 * returned order follows userStats, while every benchmark orphan is omitted.
 */
export function matchDebateStatPairs(userStats: unknown, benchmarkStats: unknown): DebateStatPair[] {
  const users = toStatEntries(userStats);
  const benchmarks = toStatEntries(benchmarkStats);
  const duplicateMetricKeys = new Set<string>();
  for (const keys of [users.map(({ metric }) => metric), benchmarks.map(({ metric }) => metric)]) {
    const counts = new Map<string, number>();
    keys.forEach((key) => {
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });
    counts.forEach((count, key) => {
      if (count > 1) duplicateMetricKeys.add(key);
    });
  }
  const unusedBenchmarkIndexes = new Set(
    benchmarks
      .map((_entry, index) => index)
      .filter((index) => {
        const metric = benchmarks[index].metric;
        return benchmarks[index].stat !== null && metric !== null && !duplicateMetricKeys.has(metric);
      }),
  );
  const pairs: DebateStatPair[] = [];

  users.forEach((userEntry) => {
    const user = userEntry.stat;
    const userMetric = userEntry.metric;
    if (!user || !userMetric || duplicateMetricKeys.has(userMetric)) return;
    const matchIndex = Array.from(unusedBenchmarkIndexes).find((index) => {
      const benchmarkEntry = benchmarks[index];
      const benchmark = benchmarkEntry.stat;
      return benchmark !== null
        && benchmarkEntry.metric === userMetric
        && unitsCompatible(userMetric, user.value, benchmark.value);
    });
    if (matchIndex === undefined) return;
    unusedBenchmarkIndexes.delete(matchIndex);
    const benchmark = benchmarks[matchIndex].stat;
    if (!benchmark) return;
    pairs.push({ user, benchmark });
  });

  return pairs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize one parsed final payload while preserving the documented coaching
 * text fields. Evidence arrays are rewritten to safe, matched pairs and all
 * provider-owned fields outside the contract are dropped.
 */
export interface NormalizeAiSummaryDebateOptions {
  /**
   * Optional server-owned evidence keyed by canonical metric. When supplied,
   * only provider pairs for those metrics survive, and both sides are replaced
   * with the server's exact formatted values. This prevents invented numbers
   * and keeps mixed-mode evidence scoped to the route's main mode.
   */
  canonicalEvidence?: CanonicalDebateEvidenceMap;
}

export function normalizeAiSummaryDebatePayload(
  value: unknown,
  options: NormalizeAiSummaryDebateOptions = {},
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (typeof value.signature !== "string" || !value.signature.trim()) return null;
  if (typeof value.signatureSub !== "string" || !value.signatureSub.trim()) return null;
  const signature = value.signature.trim();
  const signatureSub = value.signatureSub.trim();
  if (typeof value.finalVerdict !== "string") return null;
  const finalVerdict = value.finalVerdict.trim();
  if (!finalVerdict) return null;

  // The route prompt promises a complete three-way debate. Treat missing,
  // sparse, or partially shaped payloads as invalid rather than allowing the
  // client to render placeholders for data the model never supplied.
  if (!Array.isArray(value.debateIssues) || value.debateIssues.length !== 3) return null;
  if (value.debateIssues.some((issue) => !isRecord(issue))) return null;
  const issueTextFields = ["topic", "question", "kindOpinion", "spicyOpinion", "reason", "evaluation"] as const;
  const normalizedIssues: Record<string, unknown>[] = [];
  for (const rawIssue of value.debateIssues) {
    const issue = rawIssue as Record<string, unknown>;
    const trimmedFields: Record<string, string> = {};
    for (const field of issueTextFields) {
      if (typeof issue[field] !== "string") return null;
      const trimmed = issue[field].trim();
      if (!trimmed) return null;
      trimmedFields[field] = trimmed;
    }
    if (issue.winner !== "kind" && issue.winner !== "spicy") return null;
    if (!Array.isArray(issue.userStats) || !Array.isArray(issue.benchmarkStats)) return null;

    const matchedPairs = matchDebateStatPairs(issue.userStats, issue.benchmarkStats);
    const canonicalEvidence = options.canonicalEvidence;
    const pairs = canonicalEvidence
      ? matchedPairs.flatMap((pair) => {
        const key = metricKey(pair.user.label);
        if (!key) return [];
        const canonical = canonicalEvidence[key];
        if (!canonical) return [];

        // Validate the route-owned pair as well. This keeps a malformed map
        // from bypassing the same dimensional safeguards as provider data.
        const canonicalUser = toStat(canonical.user);
        const canonicalBenchmark = toStat(canonical.benchmark);
        if (!canonicalUser || !canonicalBenchmark || !unitsCompatible(key, canonicalUser.value, canonicalBenchmark.value)) {
          return [];
        }
        return [{ user: canonicalUser, benchmark: canonicalBenchmark }];
      })
      : matchedPairs;
    normalizedIssues.push({
      topic: trimmedFields.topic,
      question: trimmedFields.question,
      kindOpinion: trimmedFields.kindOpinion,
      spicyOpinion: trimmedFields.spicyOpinion,
      winner: issue.winner,
      reason: trimmedFields.reason,
      evaluation: trimmedFields.evaluation,
      userStats: pairs.map((pair) => pair.user),
      benchmarkStats: pairs.map((pair) => pair.benchmark),
    });
  }

  if (!Array.isArray(value.actionItems) || value.actionItems.length === 0) return null;
  const normalizedActionItems: Record<string, unknown>[] = [];
  for (const rawItem of value.actionItems) {
    if (!isRecord(rawItem)) return null;
    const item = rawItem as Record<string, unknown>;
    const itemFields: Record<string, string> = {};
    for (const field of ["icon", "title", "desc"] as const) {
      if (typeof item[field] !== "string") return null;
      const trimmed = item[field].trim();
      if (!trimmed) return null;
      itemFields[field] = trimmed;
    }
    normalizedActionItems.push(itemFields);
  }

  // Keep only the provider fields that the summary contract defines. In
  // particular, visuals are streamed from the route and arbitrary provider
  // keys must never cross this boundary into the cache or renderer.
  const normalized: Record<string, unknown> = {
    signature,
    signatureSub,
    finalVerdict,
  };
  if (typeof value.weaknessDiagnostic === "string" && value.weaknessDiagnostic.trim()) {
    normalized.weaknessDiagnostic = value.weaknessDiagnostic.trim();
  }
  normalized.debateIssues = normalizedIssues;
  normalized.actionItems = normalizedActionItems;
  return normalized;
}

/**
 * Parse and serialize a canonical final JSON string.  `null` means the input
 * was not an object JSON payload or had an empty finalVerdict and must follow
 * the route's existing error path instead of being sent/cached as success.
 */
export function normalizeAiSummaryFinalJson(input: string): string | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    const normalized = normalizeAiSummaryDebatePayload(parsed);
    return normalized ? JSON.stringify(normalized) : null;
  } catch {
    return null;
  }
}
