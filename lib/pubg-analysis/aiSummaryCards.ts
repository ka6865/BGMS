import { AI_SUMMARY_HIGHER_IS_BETTER } from "./aiSummaryDebate";
import { hasUnsupportedSummaryInference, sanitizeSummaryInferenceText, hasUnsupportedSummaryAdvice, sanitizeSummaryAdviceText } from "./aiSummaryJudgment";
import { COACHING_JUDGMENT_WITHHELD, requiresRescueOpportunityEvidence } from "./aiCoachingQuality";

/**
 * Server-owned card composition for the v2 AI summary contract.
 *
 * This module intentionally has no framework, database, or provider imports.
 * The route builds the evidence catalog, the provider supplies prose and
 * references, and both the route and browser boundary can validate the same
 * assembled card shape.
 */

export const AI_SUMMARY_CARD_VERSION = 2 as const;

export type SummaryTopicId =
  | "firepower"
  | "initiative"
  | "duel"
  | "trade_backup"
  | "utility"
  | "positioning"
  | "survival";

export type SummaryDataStatus = "comparable" | "user_only" | "unavailable";
export type SummaryAnalysisStatus = "pending" | "ready" | "unavailable";

export interface SummaryEvidence {
  id: string;
  metricId: string;
  label: string;
  userValue: string | null;
  benchmarkValue: string | null;
  /** Unrounded values in the same units as display values; absent on older cards. */
  userNumericValue?: number | null;
  benchmarkNumericValue?: number | null;
  benchmarkLabel: string;
  unit: string;
  status: SummaryDataStatus;
  unavailableReason?: string;
  sampleCount: number | null;
  /** Matches with complete observations for this metric; absent on older cards. */
  userMatchCount?: number;
  numerator?: number | null;
  denominator?: number | null;
}

// The public contract intentionally names this input type separately from the
// server-owned output, even though its fields are the same minus id/status.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SummaryEvidenceInput extends Omit<SummaryEvidence, "id" | "status"> {}

export interface SummaryEvidenceContext {
  contextId: string;
  gameMode: string;
  matchType: string;
  tier: string | null;
  userMatchCount: number;
  benchmarkSampleCount: number | null;
  filterVersion: number;
  populationVersion: number;
}

export interface SummaryCard {
  topicId: SummaryTopicId;
  topic: string;
  question: string;
  evidenceIds: string[];
  evidence: SummaryEvidence[];
  context: SummaryEvidenceContext;
  dataStatus: SummaryDataStatus;
  analysisStatus: SummaryAnalysisStatus;
  analysisReason?: string;
  kindOpinion: string;
  spicyOpinion: string;
  reason: string;
  evaluation: string;
  winner: "kind" | "spicy" | "draw" | null;
}

export const SUMMARY_TOPIC_DEFINITIONS: Readonly<Record<SummaryTopicId, {
  topic: string;
  metricIds: readonly string[];
  defaultQuestion: string;
}>> = {
  firepower: { topic: "화력", metricIds: ["damage_average"], defaultQuestion: "화력에 대한 두 코치의 평가는?" },
  initiative: { topic: "교전 주도권", metricIds: ["initiative_rate", "pressure_index", "reaction_latency", "counter_failure_rate"], defaultQuestion: "교전 주도권에 대한 두 코치의 평가는?" },
  duel: { topic: "1:1 결정력", metricIds: ["duel_win_rate", "solo_kill_share"], defaultQuestion: "1:1 결정력에 대한 두 코치의 평가는?" },
  trade_backup: { topic: "복수 성공률 및 백업", metricIds: ["trade_success_rate", "backup_latency"], defaultQuestion: "복수 성공률 및 백업에 대한 두 코치의 평가는?" },
  utility: { topic: "유틸리티 활용", metricIds: ["utility_throws", "utility_smokes", "utility_lethal_throws", "smoke_rescue_attempts", "smoke_opportunity_rate"], defaultQuestion: "유틸리티 활용에 대한 두 코치의 평가는?" },
  positioning: { topic: "포지셔닝", metricIds: ["isolation_average"], defaultQuestion: "포지셔닝에 대한 두 코치의 평가는?" },
  survival: { topic: "생존 운영", metricIds: ["death_phase"], defaultQuestion: "생존 운영에 대한 두 코치의 평가는?" },
};

type MetricDefinition = {
  topicId: SummaryTopicId;
  unit: string;
};

/**
 * These IDs deliberately match the canonical keys already used by the v1
 * label matcher.  The card contract never resolves a provider label to one of
 * these keys; this table only validates server-owned catalog records.
 */
const METRIC_DEFINITIONS: Readonly<Record<string, MetricDefinition>> = {
  damage_average: { topicId: "firepower", unit: "" },
  initiative_rate: { topicId: "initiative", unit: "%" },
  pressure_index: { topicId: "initiative", unit: "" },
  reaction_latency: { topicId: "initiative", unit: "s" },
  counter_failure_rate: { topicId: "initiative", unit: "%" },
  duel_win_rate: { topicId: "duel", unit: "%" },
  solo_kill_share: { topicId: "duel", unit: "%" },
  trade_success_rate: { topicId: "trade_backup", unit: "%" },
  backup_latency: { topicId: "trade_backup", unit: "s" },
  utility_throws: { topicId: "utility", unit: "회" },
  utility_smokes: { topicId: "utility", unit: "회" },
  utility_lethal_throws: { topicId: "utility", unit: "회" },
  smoke_rescue_attempts: { topicId: "utility", unit: "회" },
  smoke_opportunity_rate: { topicId: "utility", unit: "%" },
  isolation_average: { topicId: "positioning", unit: "" },
  death_phase: { topicId: "survival", unit: "" },
};

const TOPIC_ID_BY_LABEL: Readonly<Record<string, SummaryTopicId>> = Object.fromEntries(
  Object.entries(SUMMARY_TOPIC_DEFINITIONS).map(([topicId, definition]) => [definition.topic, topicId as SummaryTopicId]),
) as Record<string, SummaryTopicId>;

const COMPARISON_QUESTION_SUFFIX = "은 비슷한 조건 평균과 비교해 어떤가?";
const UNAVAILABLE_COPY = "AI 해석을 표시할 수 없습니다.";
const UNAVAILABLE_REASON = "비교 근거가 없어 AI 해석을 제공할 수 없습니다.";
const MISSING_DATA_REASON = "비교에 필요한 데이터가 없습니다.";
const DIVISION_BY_ZERO_REASON = "분모가 없어 측정할 수 없습니다.";
const SAFE_SIGNATURE = "AI 전술 분석";
const SAFE_SIGNATURE_SUB = "검증된 경기 지표를 바탕으로 분석합니다.";
const SAFE_VERDICT = "검증된 경기 지표를 바탕으로 분석합니다.";

const DISPLAY_VALUE_PATTERN = /^\s*([+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+))\s*(%|ms|밀리초|s|secs?|초|m|미터|회|횟수)?\s*$/iu;
const NEUTRAL_TEXTS = new Set([
  COACHING_JUDGMENT_WITHHELD,
  "검증된 경기 지표를 바탕으로 분석합니다.",
  "검증된 경기 지표를 바탕으로 분석합니다",
  UNAVAILABLE_COPY,
  MISSING_DATA_REASON,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnKey<T extends object>(value: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isSummaryTopicId(value: unknown): value is SummaryTopicId {
  return typeof value === "string" && hasOwnKey(SUMMARY_TOPIC_DEFINITIONS, value);
}

function metricDefinitionForId(metricId: string): MetricDefinition | undefined {
  return hasOwnKey(METRIC_DEFINITIONS, metricId) ? METRIC_DEFINITIONS[metricId] : undefined;
}

function topicDefinitionForId(topicId: unknown): (typeof SUMMARY_TOPIC_DEFINITIONS)[SummaryTopicId] | undefined {
  return isSummaryTopicId(topicId) ? SUMMARY_TOPIC_DEFINITIONS[topicId] : undefined;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value.trim() : null;
}

function finiteNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  const number = finiteNonNegativeNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function cloneContext(context: SummaryEvidenceContext): SummaryEvidenceContext {
  return {
    contextId: context.contextId,
    gameMode: context.gameMode,
    matchType: context.matchType,
    tier: context.tier,
    userMatchCount: context.userMatchCount,
    benchmarkSampleCount: context.benchmarkSampleCount,
    filterVersion: context.filterVersion,
    populationVersion: context.populationVersion,
  };
}

function validateContext(value: unknown): SummaryEvidenceContext | null {
  if (!isRecord(value)) return null;
  const contextId = nonEmptyString(value.contextId);
  const gameMode = nonEmptyString(value.gameMode);
  const matchType = nonEmptyString(value.matchType);
  const userMatchCount = finiteNonNegativeInteger(value.userMatchCount);
  const filterVersion = finiteNonNegativeInteger(value.filterVersion);
  const populationVersion = finiteNonNegativeInteger(value.populationVersion);
  if (!contextId || !gameMode || !matchType || userMatchCount === null || filterVersion === null || populationVersion === null) {
    return null;
  }

  const tier = value.tier === null ? null : nonEmptyString(value.tier);
  if (value.tier !== null && !tier) return null;
  const benchmarkSampleCount = value.benchmarkSampleCount === null
    ? null
    : finiteNonNegativeInteger(value.benchmarkSampleCount);
  if (value.benchmarkSampleCount !== null && benchmarkSampleCount === null) return null;

  return {
    contextId,
    gameMode,
    matchType,
    tier,
    userMatchCount,
    benchmarkSampleCount,
    filterVersion,
    populationVersion,
  };
}

function parseDisplayValue(value: string, expectedUnit: string): number | null {
  const match = value.match(DISPLAY_VALUE_PATTERN);
  if (!match) return null;
  const number = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(number) || number < 0) return null;
  const rawUnit = (match[2] || "").toLocaleLowerCase();
  const normalizedUnit = rawUnit === "밀리초" ? "ms"
    : rawUnit === "secs" || rawUnit === "sec" || rawUnit === "초" ? "s"
      : rawUnit === "미터" ? "m"
        : rawUnit === "횟수" ? "회"
          : rawUnit;
  if (normalizedUnit !== expectedUnit) return null;
  if (expectedUnit === "%" && number > 100) return null;
  return number;
}

function rawValueMatchesDisplay(raw: number | null, display: string | null, unit: string): boolean {
  if (raw === null) return display === null;
  if (display === null) return false;
  const displayed = parseDisplayValue(display, unit);
  return displayed !== null && displayed === Number(raw.toFixed(unit === "%" ? 1 : 2));
}

function normalizeEvidenceInput(
  input: SummaryEvidenceInput,
  contextId: string,
): SummaryEvidence | null {
  if (!isRecord(input)) return null;
  const metricId = nonEmptyString(input.metricId);
  const metric = metricId ? metricDefinitionForId(metricId) : undefined;
  const label = nonEmptyString(input.label);
  const benchmarkLabel = optionalString(input.benchmarkLabel);
  const unit = typeof input.unit === "string" ? input.unit.trim() : null;
  if (!metricId || !metric || !label || benchmarkLabel === null || unit === null || unit !== metric.unit) return null;

  const sampleCount = input.sampleCount === null
    ? null
    : finiteNonNegativeInteger(input.sampleCount);
  if (input.sampleCount !== null && sampleCount === null) return null;

  const rawUserValue = input.userValue === null ? null : nonEmptyString(input.userValue);
  const rawBenchmarkValue = input.benchmarkValue === null ? null : nonEmptyString(input.benchmarkValue);
  if (input.userValue !== null && !rawUserValue) return null;
  if (input.benchmarkValue !== null && !rawBenchmarkValue) return null;

  const numerator = input.numerator === null || input.numerator === undefined
    ? null
    : finiteNonNegativeNumber(input.numerator);
  const denominator = input.denominator === null || input.denominator === undefined
    ? null
    : finiteNumber(input.denominator);
  if ((input.numerator !== null && input.numerator !== undefined && numerator === null)
    || (input.denominator !== null && input.denominator !== undefined && denominator === null)) {
    return null;
  }

  for (const key of ["userNumericValue", "benchmarkNumericValue"] as const) {
    const raw = input[key];
    if (raw !== undefined && raw !== null && (typeof raw !== "number" || finiteNonNegativeNumber(raw) === null || (unit === "%" && raw > 100))) return null;
  }
  const userMatchCount = input.userMatchCount === undefined ? undefined : finiteNonNegativeInteger(input.userMatchCount);
  if (userMatchCount === null) return null;
  const id = `${contextId}:${metricId}`;
  const base: SummaryEvidence = {
    id,
    metricId,
    label,
    userValue: rawUserValue,
    benchmarkValue: rawBenchmarkValue,
    benchmarkLabel: benchmarkLabel || "",
    unit,
    status: "unavailable",
    sampleCount,
    ...(userMatchCount !== undefined ? { userMatchCount } : {}),
    ...(input.unavailableReason ? { unavailableReason: String(input.unavailableReason).trim() } : {}),
    ...(input.userNumericValue !== undefined ? { userNumericValue: input.userNumericValue } : {}),
    ...(input.benchmarkNumericValue !== undefined ? { benchmarkNumericValue: input.benchmarkNumericValue } : {}),
    ...(numerator !== null ? { numerator } : {}),
    ...(denominator !== null ? { denominator } : {}),
  };

  // A zero denominator means there was no opportunity to observe a rate. It
  // must never become a fabricated 0% row, even if the caller sent "0%".
  if (denominator !== null && denominator <= 0) {
    return {
      ...base,
      userValue: null,
      benchmarkValue: null,
      ...(base.userNumericValue !== undefined ? { userNumericValue: null } : {}),
      ...(base.benchmarkNumericValue !== undefined ? { benchmarkNumericValue: null } : {}),
      status: "unavailable",
      unavailableReason: base.unavailableReason || DIVISION_BY_ZERO_REASON,
    };
  }

  if (rawUserValue !== null && parseDisplayValue(rawUserValue, metric.unit) === null) {
    return {
      ...base,
      userValue: null,
      benchmarkValue: null,
      ...(base.userNumericValue !== undefined ? { userNumericValue: null } : {}),
      ...(base.benchmarkNumericValue !== undefined ? { benchmarkNumericValue: null } : {}),
      status: "unavailable",
      unavailableReason: base.unavailableReason || MISSING_DATA_REASON,
    };
  }
  if (rawBenchmarkValue !== null && parseDisplayValue(rawBenchmarkValue, metric.unit) === null) {
    return {
      ...base,
      userValue: null,
      benchmarkValue: null,
      ...(base.userNumericValue !== undefined ? { userNumericValue: null } : {}),
      ...(base.benchmarkNumericValue !== undefined ? { benchmarkNumericValue: null } : {}),
      status: "unavailable",
      unavailableReason: base.unavailableReason || MISSING_DATA_REASON,
    };
  }

  if (rawUserValue === null) {
    return {
      ...base,
      benchmarkValue: null,
      ...(base.benchmarkNumericValue !== undefined ? { benchmarkNumericValue: null } : {}),
      status: "unavailable",
      unavailableReason: base.unavailableReason || MISSING_DATA_REASON,
    };
  }
  if (rawBenchmarkValue === null) {
    return { ...base, status: "user_only" };
  }
  if (sampleCount === null || sampleCount <= 0) {
    // A missing benchmark cohort does not erase an observed user metric. Keep
    // the card user-only and drop the untrustworthy comparison value.
    return {
      ...base,
      benchmarkValue: null,
      ...(base.benchmarkNumericValue !== undefined ? { benchmarkNumericValue: null } : {}),
      status: "user_only",
    };
  }
  return { ...base, status: "comparable" };
}

function topicIdForName(value: unknown): SummaryTopicId | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (!hasOwnKey(TOPIC_ID_BY_LABEL, label)) return null;
  const topicId = TOPIC_ID_BY_LABEL[label];
  return isSummaryTopicId(topicId) ? topicId : null;
}

function topicQuestion(topicId: SummaryTopicId, dataStatus: SummaryDataStatus): string {
  const definition = topicDefinitionForId(topicId);
  if (!definition) return "";
  return dataStatus === "comparable" && topicId !== "utility"
    ? `${definition.topic}${COMPARISON_QUESTION_SUFFIX}`
    : definition.defaultQuestion;
}

function cloneEvidence(evidence: SummaryEvidence): SummaryEvidence {
  return {
    ...evidence,
    ...(evidence.unavailableReason ? { unavailableReason: evidence.unavailableReason } : {}),
  };
}

function isObservedEvidence(evidence: SummaryEvidence): boolean {
  return evidence.userValue !== null && evidence.status !== "unavailable";
}

function dataStatusForEvidence(evidence: readonly SummaryEvidence[]): SummaryDataStatus {
  if (evidence.some((item) => item.status === "comparable")) return "comparable";
  if (evidence.some(isObservedEvidence)) return "user_only";
  return "unavailable";
}

function evidenceReason(evidence: readonly SummaryEvidence[]): string {
  return evidence.find((item) => item.unavailableReason)?.unavailableReason || MISSING_DATA_REASON;
}

function cloneCard(card: SummaryCard): SummaryCard {
  return {
    ...card,
    evidenceIds: [...card.evidenceIds],
    evidence: card.evidence.map(cloneEvidence),
    context: cloneContext(card.context),
  };
}

function unavailableCard(card: SummaryCard, reason: string): SummaryCard {
  return {
    ...cloneCard(card),
    analysisStatus: "unavailable",
    analysisReason: reason || UNAVAILABLE_REASON,
    kindOpinion: UNAVAILABLE_COPY,
    spicyOpinion: UNAVAILABLE_COPY,
    reason: UNAVAILABLE_COPY,
    evaluation: UNAVAILABLE_COPY,
    winner: null,
  };
}

function validateCardCatalog(cards: readonly SummaryCard[]): SummaryCard[] | null {
  if (!Array.isArray(cards) || cards.length !== 3) return null;
  const seenTopics = new Set<SummaryTopicId>();
  const cloned = cards.map((card) => {
    if (!isRecord(card)) return null;
    const topicId = isSummaryTopicId(card.topicId) ? card.topicId : null;
    if (!topicId || seenTopics.has(topicId)) return null;
    seenTopics.add(topicId);
    const topic = nonEmptyString(card.topic);
    const question = nonEmptyString(card.question);
    const context = validateContext(card.context);
    const evidence = Array.isArray(card.evidence) ? card.evidence : null;
    const evidenceIds = Array.isArray(card.evidenceIds) ? card.evidenceIds : null;
    if (!topic || !question || !context || !evidence || !evidenceIds) return null;
    const copiedEvidence: SummaryEvidence[] = [];
    const evidenceIdSet = new Set<string>();
    for (const rawEvidence of evidence) {
      const normalizedEvidence = validateSummaryEvidence(rawEvidence, topicId, context);
      if (!normalizedEvidence || evidenceIdSet.has(normalizedEvidence.id)) return null;
      evidenceIdSet.add(normalizedEvidence.id);
      copiedEvidence.push(normalizedEvidence);
    }
    const observedIds = copiedEvidence.filter(isObservedEvidence).map((item) => item.id);
    if (evidenceIds.some((id) => typeof id !== "string")
      || new Set(evidenceIds).size !== evidenceIds.length
      || evidenceIds.length !== observedIds.length
      || evidenceIds.some((id) => !observedIds.includes(id))) return null;
    const derivedDataStatus = dataStatusForEvidence(copiedEvidence);
    if (card.dataStatus !== derivedDataStatus) return null;
    const analysisStatus = card.analysisStatus;
    if (analysisStatus !== "pending" && analysisStatus !== "ready" && analysisStatus !== "unavailable") return null;
    const winner = card.winner === null || card.winner === "kind" || card.winner === "spicy" || card.winner === "draw"
      ? card.winner
      : undefined;
    if (winner === undefined || hasUnsupportedMixedWinner(winner, copiedEvidence)) return null;
    if (winner !== null && (derivedDataStatus !== "comparable" || analysisStatus !== "ready")) return null;
    if (derivedDataStatus === "unavailable" && analysisStatus !== "unavailable") return null;
    if (analysisStatus !== "ready" && winner !== null) return null;
    const kindOpinion = typeof card.kindOpinion === "string" ? card.kindOpinion : null;
    const spicyOpinion = typeof card.spicyOpinion === "string" ? card.spicyOpinion : null;
    const reason = typeof card.reason === "string" ? card.reason : null;
    const evaluation = typeof card.evaluation === "string" ? card.evaluation : null;
    if (kindOpinion === null || spicyOpinion === null || reason === null || evaluation === null) return null;
    if (analysisStatus === "ready") {
      if ([kindOpinion, spicyOpinion, reason, evaluation].some((text) => !nonEmptyString(text))) return null;
      if (isNeutralText(kindOpinion) || isNeutralText(spicyOpinion)) return null;
      if ([kindOpinion, spicyOpinion, reason, evaluation].some((text) => hasUnsupportedSummaryInference(text) || hasUnsupportedSummaryAdvice(text) || hasUnsupportedCardConclusion(text, { topicId, context, evidence: copiedEvidence }))) return null;
    }
    const expectedTopic = topicDefinitionForId(topicId)?.topic;
    if (!expectedTopic) return null;
    if (topic !== expectedTopic || question !== topicQuestion(topicId, derivedDataStatus)) return null;
    const analysisReason = card.analysisReason === undefined ? undefined : nonEmptyString(card.analysisReason);
    if (card.analysisReason !== undefined && !analysisReason) return null;
    return {
      topicId,
      topic,
      question,
      evidenceIds: [...evidenceIds],
      evidence: copiedEvidence,
      context,
      dataStatus: derivedDataStatus,
      analysisStatus,
      ...(analysisReason ? { analysisReason } : {}),
      kindOpinion,
      spicyOpinion,
      reason,
      evaluation,
      winner,
    } satisfies SummaryCard;
  });
  if (cloned.some((card): card is null => card === null)) return null;
  const resolved = cloned as SummaryCard[];
  const contextKey = JSON.stringify(resolved[0].context);
  if (resolved.some((card) => JSON.stringify(card.context) !== contextKey)) return null;
  return resolved;
}

function validateSummaryEvidence(
  value: unknown,
  topicId: SummaryTopicId,
  context: SummaryEvidenceContext,
): SummaryEvidence | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const metricId = nonEmptyString(value.metricId);
  const metric = metricId ? metricDefinitionForId(metricId) : undefined;
  const label = nonEmptyString(value.label);
  const benchmarkLabel = typeof value.benchmarkLabel === "string" ? value.benchmarkLabel.trim() : null;
  const unit = typeof value.unit === "string" ? value.unit.trim() : null;
  const status = value.status;
  const sampleCount = value.sampleCount === null ? null : finiteNonNegativeInteger(value.sampleCount);
  const userValue = value.userValue === null ? null : nonEmptyString(value.userValue);
  const benchmarkValue = value.benchmarkValue === null ? null : nonEmptyString(value.benchmarkValue);
  if (!id || !metricId || !metric || metric.topicId !== topicId || !label || benchmarkLabel === null || unit !== metric.unit
    || (value.sampleCount !== null && sampleCount === null)
    || (value.userValue !== null && !userValue)
    || (value.benchmarkValue !== null && !benchmarkValue)
    || !["comparable", "user_only", "unavailable"].includes(String(status))) return null;
  if (id !== `${context.contextId}:${metricId}`) return null;
  for (const key of ["userNumericValue", "benchmarkNumericValue"] as const) {
    const raw = value[key];
    if (raw !== undefined && raw !== null && (typeof raw !== "number" || finiteNonNegativeNumber(raw) === null || (unit === "%" && raw > 100))) return null;
  }
  if (value.userNumericValue !== undefined
    && !rawValueMatchesDisplay(value.userNumericValue as number | null, userValue, unit)) return null;
  if (value.benchmarkNumericValue !== undefined
    && !rawValueMatchesDisplay(value.benchmarkNumericValue as number | null, benchmarkValue, unit)) return null;
  const userMatchCount = value.userMatchCount === undefined ? undefined : finiteNonNegativeInteger(value.userMatchCount);
  if (userMatchCount === null || (userMatchCount !== undefined && userMatchCount > context.userMatchCount)
    || (userMatchCount === 0 && userValue !== null)) return null;
  const numerator = value.numerator === null || value.numerator === undefined ? null : finiteNonNegativeNumber(value.numerator);
  const denominator = value.denominator === null || value.denominator === undefined ? null : finiteNumber(value.denominator);
  if ((value.numerator !== null && value.numerator !== undefined && numerator === null)
    || (value.denominator !== null && value.denominator !== undefined && denominator === null)) return null;
  if (unit === "%" && typeof value.userNumericValue === "number"
    && (numerator !== null || denominator !== null)
    && (numerator === null || denominator === null || denominator <= 0
      || Math.abs(value.userNumericValue - Math.min(100, numerator / denominator * 100)) > 1e-9)) {
    return null;
  }
  if (userValue !== null && parseDisplayValue(userValue, metric.unit) === null) return null;
  if (benchmarkValue !== null && parseDisplayValue(benchmarkValue, metric.unit) === null) return null;
  const derivedStatus: SummaryDataStatus = denominator !== null && denominator <= 0
    ? "unavailable"
    : userValue === null
      ? "unavailable"
      : benchmarkValue === null
        ? "user_only"
        : "comparable";
  if (status !== derivedStatus) return null;
  if (derivedStatus === "unavailable" && userValue !== null) return null;
  if (derivedStatus === "comparable" && (sampleCount === null || sampleCount <= 0)) return null;
  if (derivedStatus === "user_only" && benchmarkValue !== null) return null;
  const unavailableReason = value.unavailableReason === undefined ? undefined : nonEmptyString(value.unavailableReason);
  if (value.unavailableReason !== undefined && !unavailableReason) return null;
  return {
    id,
    metricId,
    label,
    userValue,
    benchmarkValue,
    benchmarkLabel,
    unit,
    status: derivedStatus,
    ...(unavailableReason ? { unavailableReason } : {}),
    sampleCount,
    ...(userMatchCount !== undefined ? { userMatchCount } : {}),
    ...(value.userNumericValue !== undefined ? { userNumericValue: value.userNumericValue as number | null } : {}),
    ...(value.benchmarkNumericValue !== undefined ? { benchmarkNumericValue: value.benchmarkNumericValue as number | null } : {}),
    ...(numerator !== null ? { numerator } : {}),
    ...(denominator !== null ? { denominator } : {}),
  };
}

// Necessary evidence for "strengths and weaknesses together": a card whose
// known comparisons are all strictly favourable cannot establish a weakness.
// Equal, unknown-direction and genuinely mixed evidence remain model-reviewed.
function hasUnsupportedMixedWinner(winner: SummaryCard["winner"], evidence: readonly SummaryEvidence[]): boolean {
  if (winner !== "draw") return false;
  const comparisons = evidence.filter((row) => row.status === "comparable");
  return comparisons.length > 0 && comparisons.every((row) => {
    const higherIsBetter = AI_SUMMARY_HIGHER_IS_BETTER[row.metricId];
    if (higherIsBetter === undefined || row.userValue === null || row.benchmarkValue === null) return false;
    if (isDisplayedEqual(row)) return false;
    const user = evidenceNumericValue(row, "user");
    const benchmark = evidenceNumericValue(row, "benchmark");
    return user !== null && benchmark !== null && (higherIsBetter ? user - benchmark > 1e-9 : benchmark - user > 1e-9);
  });
}

function isNeutralText(value: string): boolean {
  let remaining = value.trim();
  for (const neutral of NEUTRAL_TEXTS) remaining = remaining.split(neutral).join("");
  return !remaining.trim();
}

// 고립 지수는 유리·불리 방향을 정하지 않으므로 서버 문장 검사(validateBenchmarkDirection)가
// 다루지 않는다. 비교 평균보다 "높다/낮다"고 쓴 문장만 실제 수치와 맞는지 확인한다.
function hasContradictedIsolationClaim(text: string, row: SummaryEvidence): boolean {
  const user = evidenceNumericValue(row, "user");
  const benchmark = evidenceNumericValue(row, "benchmark");
  if (user === null || benchmark === null) return false;
  const equal = Math.abs(user - benchmark) <= 1e-9 || isDisplayedEqual(row);
  for (const sentence of text.split(/(?<=[.!?。！？])\s+|\n+/u)) {
    if (!/고립\s*지수/u.test(sentence) || !/(?:비교\s*평균|평균보다|평균\s*대비|동일\s*티어)/u.test(sentence)) continue;
    const claimsHigher = /(?:높(?:습니다|다|아|고|게|은)|상회|초과)/u.test(sentence);
    const claimsLower = /(?:낮(?:습니다|다|아|고|게|은)|하회|미만)/u.test(sentence);
    if (claimsHigher === claimsLower) continue;
    if (equal || (claimsHigher ? user <= benchmark : user >= benchmark)) return true;
  }
  return false;
}

function hasUnsupportedCardConclusion(text: string, card: Pick<SummaryCard, "topicId" | "context" | "evidence">): boolean {
  // A card's match population is server-owned, just like its metric values.
  const populations = Array.from(text.matchAll(/최근\s*(\d+)\s*(?:개\s*)?(?:판|경기)/gu));
  if (populations.some((match) => Number(match[1]) !== card.context.userMatchCount)) return true;
  if (card.topicId === "positioning") {
    const comparable = card.evidence.find((row) => row.metricId === "isolation_average" && row.status === "comparable");
    if (comparable && hasContradictedIsolationClaim(text, comparable)) return true;
  }
  if (card.topicId === "positioning"
    && !card.evidence.some((row) => row.metricId === "isolation_average" && row.status === "comparable")) {
    for (const sentence of text.split(/(?<=[.!?。！？])\s+|\n+/u)) {
      const conclusions = sentence.matchAll(/고립\s*지수(?:은|는|이|가)?\s*(?:다소\s*)?(?:높(?:게|아|은|습니다|다)|낮(?:게|아|은|습니다|다))|(?:높은|낮은)\s*고립\s*지수|대열[^.!?\n]{0,20}안정적으로\s*유지(?:하고|했|되)|안정적인\s*대열[^.!?\n]{0,25}(?:형성|유지)[^.!?\n]{0,25}(?:노력|엿보|있습니다)/gu);
      for (const conclusion of conclusions) {
        const tail = sentence.slice(conclusion.index + conclusion[0].length);
        if (/^(?:고|는|다고|다는)?\s*(?:(?:단정|판단|평가)할\s*수(?:는)?\s*없(?:습니다|다|어요|음)|(?:(?:단정|판단|평가)할\s*)?비교\s*근거(?:가|는)?\s*없(?:습니다|다|어요|음))[.!?。！？]?\s*$/u.test(tail)) continue;
        return true;
      }
    }
  }
  if (card.topicId !== "utility") return false;
  if (requiresRescueOpportunityEvidence(text)
    && !card.evidence.some((row) => row.metricId === "smoke_opportunity_rate" && row.userValue !== null && row.status !== "unavailable")) return true;
  // Counts establish use, not intent or an adequate frequency. Do not let
  // an old provider/template infer cover purpose or "few offensive throws"
  // from these observations, even when the referenced IDs are valid.
  return /(?:대부분|거의\s*(?:모두|전부)).*(?:연막|생존|엄폐)|(?:공격형|피해형)\s*투척(?:\s*시도)?(?:은|는|이|가)?\s*(?:매우\s*)?(?:적었|적습니다|부족했)|(?:생존|엄폐)(?:\s*(?:및|·|\/)?\s*(?:생존|엄폐))?용으로\s*(?:적극\s*)?(?:활용했|사용했)|보유량에\s*비해/u.test(text);
}

function sanitizeRequiredText(
  value: string,
  sanitizeText: (value: string) => string,
): { value: string; changed: boolean; empty: boolean } {
  try {
    const sanitized = sanitizeSummaryInferenceText(sanitizeSummaryAdviceText(sanitizeText(value)));
    if (typeof sanitized !== "string") return { value: "", changed: true, empty: true };
    const trimmed = sanitized.trim();
    return { value: trimmed, changed: trimmed !== value.trim(), empty: !trimmed };
  } catch {
    return { value: "", changed: true, empty: true };
  }
}

function safeActionItems(
  value: unknown,
  sanitizeText: (value: string) => string,
  hasUnsupportedMode: (value: unknown) => boolean,
): {
  items: Array<{ icon: string; title: string; desc: string }>;
  rejected: boolean;
} | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rejected = { value: false };
  const items: Array<{ icon: string; title: string; desc: string }> = [];
  for (const rawItem of value) {
    if (!isRecord(rawItem)) {
      rejected.value = true;
      continue;
    }
    const icon = nonEmptyString(rawItem.icon);
    const title = nonEmptyString(rawItem.title);
    const desc = nonEmptyString(rawItem.desc);
    if (!icon || !title || !desc) {
      rejected.value = true;
      continue;
    }
    let itemRejected = isNeutralText(title) || isNeutralText(desc);
    try {
      // Check the provider's original action text as well as the sanitized
      // copy. A sanitizer must not make a foreign-mode action cacheable just
      // because it removed the marker before this validation.
      if (hasUnsupportedMode(title) || hasUnsupportedMode(desc)) itemRejected = true;
    } catch {
      itemRejected = true;
    }
    const sanitizedTitle = sanitizeRequiredText(title, sanitizeText);
    const sanitizedDesc = sanitizeRequiredText(desc, sanitizeText);
    if (sanitizedTitle.empty || sanitizedDesc.empty
      || isNeutralText(sanitizedTitle.value) || isNeutralText(sanitizedDesc.value)) {
      itemRejected = true;
    }
    try {
      if (hasUnsupportedMode(sanitizedTitle.value) || hasUnsupportedMode(sanitizedDesc.value)) itemRejected = true;
    } catch {
      itemRejected = true;
    }
    if (itemRejected) {
      rejected.value = true;
      continue;
    }
    items.push({
      icon,
      title: sanitizedTitle.value,
      desc: sanitizedDesc.value,
    });
  }
  return { items, rejected: rejected.value };
}

export function buildSummaryCards(input: {
  topics: readonly string[];
  evidence: readonly SummaryEvidenceInput[];
  context: SummaryEvidenceContext;
}): SummaryCard[] {
  if (!input || !Array.isArray(input.topics) || input.topics.length !== 3 || !Array.isArray(input.evidence)) {
    return [];
  }
  const context = validateContext(input.context);
  if (!context) return [];

  const topicIds = input.topics.map(topicIdForName);
  if (topicIds.some((topicId): topicId is null => topicId === null)) return [];
  const resolvedTopicIds = topicIds as SummaryTopicId[];
  if (new Set(resolvedTopicIds).size !== resolvedTopicIds.length) return [];

  const evidenceByMetric = new Map<string, SummaryEvidence>();
  for (const rawEvidence of input.evidence) {
    const normalized = normalizeEvidenceInput(rawEvidence, context.contextId);
    if (!normalized || (normalized.userMatchCount !== undefined && normalized.userMatchCount > context.userMatchCount)
      || (normalized.userMatchCount === 0 && normalized.userValue !== null)) continue;
    // An ID is scoped to a single metric/context. Keep the first server record
    // and never merge duplicate or denominator-ambiguous rows.
    if (!evidenceByMetric.has(normalized.metricId)) evidenceByMetric.set(normalized.metricId, normalized);
  }

  return resolvedTopicIds.map((topicId) => {
    // `topicIdForName` has already accepted this ID through the own-property
    // guard, so this typed lookup cannot resolve an inherited key.
    const definition = SUMMARY_TOPIC_DEFINITIONS[topicId];
    const topicEvidence = definition.metricIds
      .map((metricId) => evidenceByMetric.get(metricId))
      .filter((item): item is SummaryEvidence => Boolean(item))
      .map(cloneEvidence);
    const dataStatus = dataStatusForEvidence(topicEvidence);
    const observedIds = topicEvidence.filter(isObservedEvidence).map((item) => item.id);
    const analysisStatus: SummaryAnalysisStatus = dataStatus === "unavailable" ? "unavailable" : "pending";
    return {
      topicId,
      topic: definition.topic,
      question: topicQuestion(topicId, dataStatus),
      evidenceIds: observedIds,
      evidence: topicEvidence,
      context: cloneContext(context),
      dataStatus,
      analysisStatus,
      ...(dataStatus === "unavailable" ? { analysisReason: evidenceReason(topicEvidence) } : {}),
      kindOpinion: "",
      spicyOpinion: "",
      reason: "",
      evaluation: "",
      winner: null,
    } satisfies SummaryCard;
  });
}

function evidenceNumericValue(row: SummaryEvidence, side: "user" | "benchmark"): number | null {
  const raw = side === "user" ? row.userNumericValue : row.benchmarkNumericValue;
  if (raw !== undefined) return raw;
  if (side === "user" && row.unit === "%" && row.numerator != null && row.denominator != null && row.denominator > 0) {
    return Math.min(100, row.numerator / row.denominator * 100);
  }
  const display = side === "user" ? row.userValue : row.benchmarkValue;
  return display === null ? null : parseDisplayValue(display, row.unit);
}

export function buildSummaryCardComparisonText(card: SummaryCard): string {
  return card.evidence.flatMap((row) => {
    if (row.status !== "comparable" || row.userValue === null || row.benchmarkValue === null || !row.sampleCount) return [];
    const user = evidenceNumericValue(row, "user");
    const benchmark = evidenceNumericValue(row, "benchmark");
    if (user === null || benchmark === null) return [];
    const lastCharacter = row.label.charCodeAt(row.label.length - 1);
    const particle = lastCharacter >= 0xac00 && lastCharacter <= 0xd7a3 && (lastCharacter - 0xac00) % 28 === 0 ? "는" : "은";
    if (isDisplayedEqual(row) && Math.abs(user - benchmark) > 1e-9) {
      return [`${row.label}${particle} 표시 기준으로 비교 평균과 같습니다.`];
    }
    const equal = Math.abs(user - benchmark) <= 1e-9;
    const relation = row.unit === "s" ? user < benchmark ? "빠릅니다" : "느립니다" : user > benchmark ? "높습니다" : "낮습니다";
    return [`${row.label}${particle} 비교 평균${equal ? "과 같습니다" : `보다 ${relation}`}.`];
  }).join(" ");
}

function observationScope(card: SummaryCard): string {
  const comparable = card.evidence.filter(row => row.status === "comparable");
  const rows = comparable.length ? comparable : card.evidence.filter(isObservedEvidence);
  const counts = new Set(rows.map(row => row.userMatchCount ?? card.context.userMatchCount));
  const scope = counts.size === 1 ? `${[...counts][0]}경기`
    : rows.map(row => `${row.label} ${row.userMatchCount ?? card.context.userMatchCount}경기`).join(", ");
  const rates = rows.filter(row => row.unit === "%" && row.numerator != null && row.denominator != null && row.denominator > 0)
    .map(row => `${row.label} ${row.denominator}건 중 ${row.numerator}건`);
  return [scope, ...rates].filter(Boolean).join("; ");
}

function cardCheck(topicId: SummaryTopicId): string {
  const checks: Record<SummaryTopicId, string> = {
    firepower: "다음 교전이 끝난 뒤 피해를 주기 어려웠던 구간과 상대 위치를 확인한 시점을 돌아보세요.",
    initiative: "다음 교전 전 상대 위치와 빠져나올 경로를 확인하고, 교전 후 첫 대응 시점을 돌아보세요.",
    duel: "다음 교전이 끝난 뒤 상대 위치를 확인한 시점과 사격을 시작한 시점을 돌아보세요.",
    trade_backup: "아군이 교전할 때 함께 대응할 수 있는지 확인하고, 교전 후 합류가 어려웠던 구간을 돌아보세요.",
    utility: "아군이 기절했을 때 구출 접근이 가능했는지, 연막으로 가릴 수 있는 구간이 있었는지 확인하세요.",
    positioning: "다음 교전 전에 팀원 위치와 함께 대응할 수 있는지 확인하세요.",
    survival: "다음 경기 종료 후 마지막 교전의 진입 시점과 빠져나올 경로를 돌아보세요.",
  };
  return checks[topicId];
}

// 비교 가능한 지표 중 비교 평균보다 불리한 방향이면 true, 유리하면 false, 판단할 수 없으면 null.
function isUnfavorable(row: SummaryEvidence): boolean | null {
  const higherIsBetter = AI_SUMMARY_HIGHER_IS_BETTER[row.metricId];
  if (row.status !== "comparable" || higherIsBetter === undefined) return null;
  const user = evidenceNumericValue(row, "user");
  const benchmark = evidenceNumericValue(row, "benchmark");
  if (user === null || benchmark === null || Math.abs(user - benchmark) <= 1e-9 || isDisplayedEqual(row)) return null;
  return higherIsBetter ? user < benchmark : user > benchmark;
}

/** 사용자 값과 비교 평균이 화면 표시 기준으로 같은지. 표시값을 해석할 수 없으면 false. */
function isDisplayedEqual(row: SummaryEvidence): boolean {
  if (row.userValue === null || row.benchmarkValue === null) return false;
  const displayedUser = parseDisplayValue(row.userValue, row.unit);
  return displayedUser !== null && displayedUser === parseDisplayValue(row.benchmarkValue, row.unit);
}

/** 수치와 차이를 함께 쓴 서버 근거 문장. 비교 자료가 없는 관측값은 관측값만 쓴다. */
export function buildSummaryCardFactText(card: SummaryCard): string {
  return card.evidence.flatMap((row) => {
    if (row.userValue === null) return [];
    const counts = row.unit === "%" && row.numerator != null && row.denominator != null && row.denominator > 0 ? `(${row.denominator}건 중 ${row.numerator}건)` : "";
    if (row.status !== "comparable" || row.benchmarkValue === null) return [`${row.label}: ${row.userValue}${counts}, 비교 자료 없음.`];
    const user = evidenceNumericValue(row, "user");
    const benchmark = evidenceNumericValue(row, "benchmark");
    if (user === null || benchmark === null) return [];
    if (Math.abs(user - benchmark) <= 1e-9) return [`${row.label}: ${row.userValue}${counts}, 비교 평균 ${row.benchmarkValue}과 같습니다.`];
    // 화면에 같은 값으로 보이면 내부 정밀도의 작은 차이로 높고 낮음을 말하지 않는다.
    if (isDisplayedEqual(row)) return [`${row.label}: ${row.userValue}${counts}, 표시 기준으로 비교 평균과 같습니다.`];
    const relation = row.unit === "s" ? user < benchmark ? "빠릅니다" : "느립니다" : user > benchmark ? "높습니다" : "낮습니다";
    const gap = row.unit === "%" ? `${Math.abs(user - benchmark).toFixed(1)}%p`
      : benchmark > 0 ? `약 ${Math.round(Math.abs(user - benchmark) / benchmark * 100)}%` : "";
    return [`${row.label}: ${row.userValue}${counts}, 비교 평균 ${row.benchmarkValue}보다 ${gap ? `${gap} ` : ""}${relation}.`];
  }).join(" ");
}

// 가장 불리한 비교 지표에 맞춘 다음 경기 점검. 지표가 없으면 주제별 점검을 쓴다.
const METRIC_CHECKS: Readonly<Record<string, string>> = {
  damage_average: "다음 교전이 끝난 뒤 피해를 주기 어려웠던 거리와 상대 위치를 돌아보세요.",
  initiative_rate: "다음 교전 전에는 먼저 사격할 수 있는 각도와 상대 위치를 확인해 보세요.",
  pressure_index: "다음 교전에서는 피해를 준 뒤 같은 상대를 계속 압박할 수 있었는지 돌아보세요.",
  reaction_latency: "다음 경기에서 기습당했을 때 반격 소요 시간을 돌아보세요.",
  counter_failure_rate: "다음 경기에서 기습당한 직후 3초 안에 반격하거나 엄폐할 수 있었는지 확인해 보세요.",
  duel_win_rate: "다음 1:1 교전이 끝난 뒤 먼저 피해를 준 쪽과 엄폐 위치를 돌아보세요.",
  trade_success_rate: "아군이 기절했을 때 기절시킨 적을 견제할 수 있는 위치였는지 확인해 보세요.",
  backup_latency: "아군이 기절한 뒤 복수 처치까지 걸린 구간을 다음 경기 후 돌아보세요.",
  smoke_opportunity_rate: "아군이 기절했을 때 연막으로 가릴 수 있는 구간이 있었는지 확인해 보세요.",
  isolation_average: "다음 교전 전에 팀원과 함께 대응할 수 있는 거리인지 확인해 보세요.",
  death_phase: "다음 경기 종료 후 마지막 교전의 위치와 자기장 단계를 돌아보세요.",
};

function weakestMetric(card: SummaryCard): SummaryEvidence | null {
  const weak = card.evidence.filter(row => isUnfavorable(row) === true && METRIC_CHECKS[row.metricId]);
  if (!weak.length) return null;
  const gap = (row: SummaryEvidence) => {
    const user = evidenceNumericValue(row, "user") ?? 0, benchmark = evidenceNumericValue(row, "benchmark") ?? 0;
    return row.unit === "%" ? Math.abs(user - benchmark) : benchmark > 0 ? Math.abs(user - benchmark) / benchmark * 100 : 0;
  };
  return weak.reduce((a, b) => gap(b) > gap(a) ? b : a);
}

function metricCheck(card: SummaryCard): string {
  const weak = weakestMetric(card);
  return weak ? METRIC_CHECKS[weak.metricId] : cardCheck(card.topicId);
}

// 행동 제안 문장이 다루는 카드 주제. 상대 위치·경로처럼 여러 주제에 흔한 말은 넣지 않는다.
const ACTION_TOPIC_PATTERNS: Readonly<Record<SummaryTopicId, RegExp>> = {
  firepower: /화력|딜량|피해량|교전각|사격각/u,
  initiative: /선제|주도권|먼저\s*사격/u,
  duel: /1\s*[:：]\s*1|일대일|교전\s*승률/u,
  trade_backup: /복수|백업|합류/u,
  utility: /투척|연막|수류탄|유틸/u,
  positioning: /(?:아군|팀원)(?:과|와)?(?:의)?\s*(?:위치|거리)|대열|고립|포지션|이동\s*경로/u,
  survival: /생존|자기장|사망\s*페이즈/u,
};

function actionItemTopics(text: string): SummaryTopicId[] {
  return (Object.keys(ACTION_TOPIC_PATTERNS) as SummaryTopicId[]).filter((topicId) => ACTION_TOPIC_PATTERNS[topicId].test(text));
}

// 행동 제안을 둘 근거가 있는 주제인지. 비교 카드는 평균보다 불리한 지표가 있을 때만, 사용 기록 카드는 점검 대상이다.
// 이번 요약에 없는 주제는 판단하지 않고 유지한다.
function isActionableTopic(readyCards: readonly SummaryCard[], topicId: SummaryTopicId): boolean {
  const card = readyCards.find((candidate) => candidate.topicId === topicId);
  if (!card) return true;
  return card.dataStatus !== "comparable" || card.evidence.some((row) => isUnfavorable(row) === true);
}

// 약점을 전제한 제안 표현. 보완점이 없는 카드에는 쓰지 않는다.
const WEAKNESS_PREMISE = /보완|개선|부족|약점|향상|강화|끌어올|높(?:이(?:세요|기|고|려|도록|는|십시오)|일|여야|여\s)|늘(?:리|릴|려)|줄(?:이|일|여)|더\s*(?:적극|많이|빠르|자주)/u;
const MAINTENANCE_CHECK = "다음 경기에서도 같은 기록이 이어지는지 확인해 보세요.";

// 비교 평균보다 유리한 지표 중 차이가 가장 큰 지표(비율은 %p, 그 밖은 상대 차이).
function strongestMetric(cards: readonly SummaryCard[]): SummaryEvidence | null {
  const strong = cards.flatMap(card => card.evidence.filter(row => isUnfavorable(row) === false));
  if (!strong.length) return null;
  const gap = (row: SummaryEvidence) => {
    const user = evidenceNumericValue(row, "user") ?? 0, benchmark = evidenceNumericValue(row, "benchmark") ?? 0;
    return row.unit === "%" ? Math.abs(user - benchmark) : benchmark > 0 ? Math.abs(user - benchmark) / benchmark * 100 : 0;
  };
  return strong.reduce((a, b) => gap(b) > gap(a) ? b : a);
}

function serverWinner(card: SummaryCard): SummaryCard["winner"] {
  const directions = card.evidence.map(isUnfavorable).filter((value): value is boolean => value !== null);
  if (!directions.length) return null;
  if (directions.every(value => !value)) return "kind";
  if (directions.every(value => value)) return "spicy";
  return "draw";
}

const STRONG_PRAISE = /우수|훌륭|뛰어|탁월|안정적|확보|돋보|압도|완벽|잘\s/u;
// 칭호는 숫자·인성·진입 위치·측정하지 않은 능력(흐름 읽기, 판단, 지휘 등)을 담을 수 없다.
const UNSUPPORTED_SIGNATURE = /\d|무책임|무능|민폐|한심|이기적|집중력|판단력|멘탈|습관|성향|돌격|선봉|돌진|최전선|전선|돌파|돌입|진입|흐름|읽는|판단|지휘|리더|두뇌|전략가|감각|냉철|침착/u;

function conditionalCheckText(text: string): string {
  // 관측 결과나 원인 단정을 섞지 않고, 다음 상황에서 확인할 행동만 채택한다.
  return text.split(/(?<=[.!?。！？])\s+|\n+/u).filter(sentence =>
    !/비교\s*평균|(?:늦어|느려|낮아|높아|부족해|때문에)|(?:확보|조성|보장)하여/u.test(sentence)
    && !/(?:즉시|바로|무조건|반드시)[^.!?\n]{0,25}(?:던|투척|사격|진입|돌진|합류|구출)/u.test(sentence)
    && !/(?:던|투척|사격|진입|돌진|합류|구출)[^.!?\n]{0,20}(?:한\s*뒤|한\s*후|하고\s*나서|하여|해서)/u.test(sentence)
    && /다음|팀\s*모드라면|(?:교전|경기|진입|사격).{0,12}(?:전|후|때|상황)|(?:아군|팀원).{0,25}(?:때|경우|하면|상황)/u.test(sentence)
    && /(?:(?:확인|점검)(?:해\s*보(?:세요|십시오)|하세요|하십시오)|(?:돌아|살펴)보(?:세요|십시오))[.!?。！？]?$/u.test(sentence.trim())
  ).join(" ").trim();
}

function cardEvaluation(card: SummaryCard): string {
  return `관측 범위: ${observationScope(card)}. ${card.dataStatus === "comparable"
    ? "평균·비율만으로 원인이나 경기별 일관성을 판단할 수는 없습니다."
    : "사용 기록은 확인되지만 같은 조건의 비교 자료가 없어 강점이나 약점을 판단하지 않습니다."}`;
}

function groundedVerdict(cards: SummaryCard[]): string {
  // 강점과 보완점을 수치와 함께 나눠 쓴다. 비교 자료가 없는 지표는 판단하지 않는다.
  const ready = cards.filter(card => card.analysisStatus === "ready");
  const describe = (direction: boolean | null) => ready.flatMap(card => card.evidence
    .filter(row => row.status === "comparable" && isUnfavorable(row) === direction)
    .map(row => buildSummaryCardFactText({ ...card, evidence: [row] }).replace(/\.$/u, "")));
  const strengths = describe(false), weaknesses = describe(true), neutral = describe(null);
  const withheld = cards.filter(card => card.analysisStatus !== "ready").map(card => card.topic);
  return [
    strengths.length ? `강점: ${strengths.join("; ")}.` : "",
    weaknesses.length ? `보완: ${weaknesses.join("; ")}.` : "",
    neutral.length ? `비교: ${neutral.join("; ")}.` : "",
    !strengths.length && !weaknesses.length && !neutral.length ? "같은 조건의 비교 자료가 충분하지 않아 강점이나 약점을 판단하지 않습니다." : "",
    withheld.length ? `${withheld.join(", ")}: 해석을 보류했습니다.` : "",
    "평균·비율만으로 원인이나 경기별 일관성을 판단하지 않습니다. 아래 행동 제안은 다음 경기의 점검 과제입니다.",
  ].filter(Boolean).join(" ");
}

export function normalizeSummaryCardFinal(input: unknown, cards: readonly SummaryCard[], options: {
  sanitizeText: (value: string) => string;
  sanitizeCardText?: (value: string, card: SummaryCard) => string;
  hasUnsupportedMode: (value: unknown) => boolean;
  onSchemaError?: (reason: string) => void;
}): { final: Record<string, unknown> & { schemaVersion: 2; cards: SummaryCard[]; analysisStatus: "complete" | "partial" }; cacheable: boolean; usable: boolean; rejectReasons: string[] } | null {
  const malformed = (reason: string) => {
    options?.onSchemaError?.(reason);
    return null;
  };
  const serverCards = validateCardCatalog(cards);
  if (!serverCards || !isRecord(input) || !options || typeof options.sanitizeText !== "function" || typeof options.hasUnsupportedMode !== "function") {
    return malformed("invalid_root_or_catalog");
  }
  const providerSchemaVersion = input.schemaVersion;
  if (providerSchemaVersion !== undefined && providerSchemaVersion !== AI_SUMMARY_CARD_VERSION) return malformed("schema_version");
  const signature = nonEmptyString(input.signature);
  const signatureSub = nonEmptyString(input.signatureSub);
  const finalVerdict = nonEmptyString(input.finalVerdict);
  if (!signature || !signatureSub || !finalVerdict) return malformed("top_level_fields");
  if (!Array.isArray(input.debateIssues) || input.debateIssues.length !== serverCards.length) return malformed("debate_issues_count");
  const actionItems = safeActionItems(input.actionItems, options.sanitizeText, options.hasUnsupportedMode);
  if (!actionItems) return malformed("action_items");

  let cacheable = true;
  // 어떤 규칙에서 탈락했는지 운영 로그로 구분할 수 있게 사유 코드를 모은다.
  const rejectReasons: string[] = [];
  const reject = (code: string) => {
    cacheable = false;
    if (!rejectReasons.includes(code)) rejectReasons.push(code);
  };
  // 형식이 틀린 행동 제안은 해당 항목만 버린다. 남은 제안이 없으면 서버가 지표별 점검으로 채운다.
  const normalizedSignature = sanitizeRequiredText(signature, options.sanitizeText);
  const normalizedSignatureSub = sanitizeRequiredText(signatureSub, options.sanitizeText);
  const normalizedVerdict = sanitizeRequiredText(finalVerdict, options.sanitizeText);
  if (normalizedSignature.empty || normalizedSignatureSub.empty || normalizedVerdict.empty) reject("top_level_text");

  let safeSignature = normalizedSignature.value || SAFE_SIGNATURE;
  let safeSignatureSub = normalizedSignatureSub.value || SAFE_SIGNATURE_SUB;
  let safeVerdict = normalizedVerdict.value || SAFE_VERDICT;

  const providerByTopic = new Map<SummaryTopicId, Record<string, unknown>>();
  for (const rawIssue of input.debateIssues) {
    if (!isRecord(rawIssue)) return malformed("issue_object");
    const topicId = rawIssue.topicId;
    if (!isSummaryTopicId(topicId)) return malformed("topic_id");
    if (providerByTopic.has(topicId)) return malformed("duplicate_topic");
    providerByTopic.set(topicId, rawIssue);
  }
  if (providerByTopic.size !== serverCards.length || serverCards.some((card) => !providerByTopic.has(card.topicId))) return malformed("topic_set");
  // `evidenceIds` is part of the provider schema even when a zero-observation
  // card has no references. Missing or non-array references are a malformed
  // final, whereas bad members inside an array are handled per card below.
  if (Array.from(providerByTopic.values()).some((issue) => !Array.isArray(issue.evidenceIds))) return malformed("evidence_ids");

  let globalModeRejected = false;
  try {
    // A foreign-mode sentence in one card invalidates that card's
    // interpretation.  Keep unrelated cards usable; top-level prose has no
    // card owner, so it only makes the final non-cacheable.
    const topLevelProse = [signature, signatureSub, finalVerdict, safeSignature, safeSignatureSub, safeVerdict,
      ...(input.actionItems as unknown[]).flatMap((item) => isRecord(item) ? [item.title, item.desc] : [])];
    globalModeRejected = topLevelProse.some((text) => options.hasUnsupportedMode(text));
  } catch {
    globalModeRejected = true;
  }
  if (globalModeRejected) {
    reject("top_level_mode");
    safeSignature = SAFE_SIGNATURE;
    safeSignatureSub = SAFE_SIGNATURE_SUB;
    safeVerdict = SAFE_VERDICT;
  }

  let neutralCards = 0;
  const normalizedCards = serverCards.map((serverCard) => {
    const issue = providerByTopic.get(serverCard.topicId);
    if (!issue) return serverCard;
    const providerWinner = issue.winner;
    const kindOpinion = nonEmptyString(issue.kindOpinion);
    const spicyOpinion = nonEmptyString(issue.spicyOpinion);
    const reason = nonEmptyString(issue.reason);
    const evaluation = nonEmptyString(issue.evaluation);
    if (!kindOpinion || !spicyOpinion || !reason || !evaluation
      || (providerWinner !== "kind" && providerWinner !== "spicy" && providerWinner !== "draw" && providerWinner !== null)) {
      reject(`${serverCard.topicId}:fields`);
      return unavailableCard(serverCard, "AI 응답의 필수 해석 필드가 유효하지 않습니다.");
    }

    const sanitized = [kindOpinion, spicyOpinion, reason, evaluation].map((text) => sanitizeRequiredText(text,
      (value) => options.sanitizeCardText ? options.sanitizeCardText(value, serverCard) : options.sanitizeText(value)));
    // Aggregate evidence cannot support behavioural claims. Recover only these
    // removed claims with server facts; arbitrary empty/neutral opinions still fail.
    [kindOpinion, spicyOpinion, reason, evaluation].forEach((text, index) => {
      if (hasUnsupportedSummaryInference(text) && isNeutralText(sanitized[index].value) && serverCard.dataStatus !== "unavailable") {
        sanitized[index] = { value: index === 1 ? cardCheck(serverCard.topicId)
          : index === 0 ? buildSummaryCardComparisonText(serverCard) || `${serverCard.topic}의 사용 기록을 확인했습니다. ${cardCheck(serverCard.topicId)}`
            : cardEvaluation(serverCard), changed: true, empty: false };
      }
    });
    const proseRejected = sanitized.some((item) => item.empty);
    let issueHasForeignMode = false;
    try {
      // Inspect prose only. Topic/metric IDs are structured server
      // references; a key such as `solo_kill_share` must never be mistaken
      // for a foreign SOLO queue marker by the legacy prose guard.
      issueHasForeignMode = [kindOpinion, spicyOpinion, reason, evaluation, ...sanitized.map((item) => item.value)]
        .some((text) => options.hasUnsupportedMode(text));
    } catch {
      issueHasForeignMode = true;
    }

    const evidenceIds = Array.isArray(issue.evidenceIds) ? issue.evidenceIds : [];
    let referencesValid = true;
    // Repeating an allowed reference adds no evidence. Normalize provider
    // duplicates before checking ownership; unknown IDs still reject the card.
    // 같은 카드의 미관측 근거 행은 서버가 계획에 함께 보여주는 행이라 모델이 참조할 수 있다.
    // 근거로 쓸 수 없을 뿐 다른 카드나 위조 ID가 아니므로 참조 목록에서만 제외한다.
    const unobservedOwnIds = new Set(serverCard.evidence
      .filter((evidence) => !isObservedEvidence(evidence))
      .map((evidence) => evidence.id));
    const referenceValues = [...new Set(evidenceIds)].filter((id) => !unobservedOwnIds.has(id as string));
    if (referencesValid) {
      const uniqueReferences = new Set(referenceValues);
      referencesValid = referenceValues.every((id) => typeof id === "string" && id.trim() !== "")
        && uniqueReferences.size === referenceValues.length;
      const allowedIds = new Set(serverCard.evidenceIds);
      const allEvidenceById = new Map(serverCards.flatMap((card) => card.evidence.map((evidence) => [evidence.id, { card, evidence }] as const)));
      referencesValid = referencesValid && referenceValues.every((id) => {
        if (!allowedIds.has(id)) return false;
        const entry = allEvidenceById.get(id);
        return Boolean(entry && entry.card.context.contextId === serverCard.context.contextId && isObservedEvidence(entry.evidence));
      });
      if (serverCard.dataStatus === "unavailable") referencesValid = referencesValid && referenceValues.length === 0;
      else referencesValid = referencesValid && referenceValues.length > 0;
    }

    const unsupportedConclusion = [kindOpinion, spicyOpinion, reason, evaluation]
      .some((text) => hasUnsupportedCardConclusion(text, serverCard));
    // 중립 의견은 서버 근거와 지표별 점검으로 대신하므로 카드를 숨기지 않는다.
    const rejected = issueHasForeignMode || !referencesValid || proseRejected || unsupportedConclusion;
    if (rejected) {
      reject(`${serverCard.topicId}:${issueHasForeignMode ? "mode" : !referencesValid ? "evidence" : proseRejected ? "prose" : "conclusion"}`);
      return unavailableCard(serverCard, issueHasForeignMode ? "허용되지 않은 게임 모드가 포함되어 AI 해석을 보류했습니다." : unsupportedConclusion ? "경기 범위나 투척 기록으로 확인되지 않는 해석이 있어 판정을 보류했습니다." : UNAVAILABLE_REASON);
    }
    if (serverCard.dataStatus === "unavailable") {
      // Missing observations are an expected server state. Preserve the
      // factual card as unavailable without treating otherwise valid provider
      // prose as a cache rejection. The aggregate all-unavailable case is
      // forced non-cacheable below so it cannot be reported as AI success.
      return unavailableCard(serverCard, UNAVAILABLE_REASON);
    }

    const sanitizedTexts = sanitized.map((item) => item.value);
    const comparison = buildSummaryCardComparisonText(serverCard);
    // 비교 방향과 수치는 서버가 쓴다. 모델의 칭찬은 숫자·비교 없이, 불리한 지표가 없는 카드에서만 덧붙인다.
    const providerKind = sanitizedTexts[0].trim();
    const hasUnfavorable = serverCard.evidence.some(row => isUnfavorable(row) === true);
    if (isNeutralText(sanitized[0].value) && isNeutralText(sanitized[1].value)) neutralCards += 1;
    const kindUsable = providerKind && !isNeutralText(providerKind) && !sanitized[0].changed && !/\d|평균|비교/u.test(providerKind)
      && !(hasUnfavorable && STRONG_PRAISE.test(providerKind))
      && !hasUnsupportedSummaryInference(kindOpinion) && !hasUnsupportedSummaryAdvice(kindOpinion);
    // 비교가 없으면 수치는 reason에 두고, 의견에는 관측 한계만 쓴다(같은 수치 반복 방지).
    sanitizedTexts[0] = comparison
      ? [comparison, kindUsable ? providerKind : ""].filter(Boolean).join(" ")
      : kindUsable ? providerKind : "비교 자료가 없어 관측 기록만 확인했습니다.";
    sanitizedTexts[1] = conditionalCheckText(sanitizedTexts[1]);
    // 모델 점검 문장이 형식을 지키지 않으면 가장 불리한 지표에 맞춘 점검을 제공한다.
    if (!sanitizedTexts[1]) sanitizedTexts[1] = metricCheck(serverCard);
    sanitizedTexts[2] = buildSummaryCardFactText(serverCard) || comparison || sanitizedTexts[2];
    sanitizedTexts[3] = cardEvaluation(serverCard);
    const readyCard: SummaryCard = {
      ...serverCard,
      analysisStatus: "ready",
      kindOpinion: sanitizedTexts[0],
      spicyOpinion: sanitizedTexts[1],
      reason: sanitizedTexts[2],
      evaluation: sanitizedTexts[3],
      // 승패는 모델 선택이 아니라 비교 지표의 방향으로 정한다.
      winner: serverCard.dataStatus === "comparable" ? serverWinner(serverCard) : null,
    };
    return readyCard;
  });

  const readyCards = normalizedCards.filter(card => card.analysisStatus === "ready");
  // 모든 카드에서 두 의견이 중립이면 서버 문장만 남은 결과라 성공으로 캐시하지 않는다.
  if (readyCards.length > 0 && neutralCards >= readyCards.length) reject("all_neutral");
  const providerActionItems = readyCards.length === 0 ? [] : actionItems.items.flatMap((item) => {
    const desc = conditionalCheckText(item.desc);
    if (!desc || /\d/u.test(item.title)) return [];
    // 비교 결과 보완점이 없는 카드(모두 평균 이상이거나 방향이 없는 지표뿐)만 다루는 제안은
    // 약점을 전제한 표현(보완·높이기·줄이기 등)일 때만 뺀다. "유지되는지 확인"처럼 점검만 하는
    // 제안은 남긴다. 다른 카드 주제도 함께 다루면 그대로 유지한다.
    const text = `${item.title} ${desc}`;
    const topics = actionItemTopics(text);
    if (topics.length > 0 && topics.every((topicId) => !isActionableTopic(readyCards, topicId)) && WEAKNESS_PREMISE.test(text)) return [];
    return [{ ...item, desc }];
  });
  const serverActionItems = readyCards
    .map(card => weakestMetric(card))
    .filter((row): row is SummaryEvidence => row !== null)
    .map(row => ({ icon: "target", title: `${row.label} 점검`, desc: METRIC_CHECKS[row.metricId] }));
  // 보완점도 남은 모델 제안도 없으면 가장 앞선 강점 지표의 유지 확인을 하나 둔다.
  const strongest = serverActionItems.length === 0 ? strongestMetric(readyCards) : null;
  if (strongest) serverActionItems.push({ icon: "target", title: `${strongest.label} 유지 확인`, desc: MAINTENANCE_CHECK });
  const normalizedActionItems = (providerActionItems.length ? providerActionItems : serverActionItems).slice(0, 3);
  const finalCards = normalizedCards.map(cloneCard);
  // 칭호는 숫자·인성·측정하지 않은 능력 없이 짧을 때만 모델 표현을 쓴다.
  const providerSignature = normalizedSignature.value.trim();
  safeSignature = !globalModeRejected && !normalizedSignature.changed && providerSignature.length > 0 && providerSignature.length <= 16
    && !UNSUPPORTED_SIGNATURE.test(providerSignature) && !hasUnsupportedSummaryInference(providerSignature) ? providerSignature : SAFE_SIGNATURE;
  safeSignatureSub = "관측된 경기 지표와 다음 경기의 점검 과제입니다.";
  // Include every card, independent of provider winners and card-local praise.
  safeVerdict = groundedVerdict(finalCards);
  if (finalCards.every((card) => card.dataStatus === "unavailable")) reject("all_unavailable");
  const usable = finalCards.some((card) => card.analysisStatus === "ready");
  if (!usable && cacheable) reject("all_unavailable");
  if (!cacheable) {
    safeSignature = SAFE_SIGNATURE;
    safeSignatureSub = SAFE_SIGNATURE_SUB;
  }
  const legacyIssues = finalCards.map((card) => {
    const comparableEvidence = card.evidence.filter((evidence) => evidence.status === "comparable" && evidence.userValue !== null && evidence.benchmarkValue !== null);
    return {
      topic: card.topic,
      question: card.question,
      kindOpinion: card.kindOpinion,
      spicyOpinion: card.spicyOpinion,
      winner: card.winner,
      reason: card.reason,
      evaluation: card.evaluation,
      userStats: comparableEvidence.map((evidence) => ({ label: evidence.label, value: evidence.userValue as string })),
      benchmarkStats: comparableEvidence.map((evidence) => ({ label: evidence.benchmarkLabel, value: evidence.benchmarkValue as string })),
    };
  });

  const final = {
    schemaVersion: AI_SUMMARY_CARD_VERSION,
    analysisStatus: cacheable ? "complete" : "partial",
    signature: safeSignature,
    signatureSub: safeSignatureSub,
    finalVerdict: safeVerdict,
    cards: finalCards,
    debateIssues: legacyIssues,
    actionItems: normalizedActionItems,
  } as Record<string, unknown> & { schemaVersion: 2; cards: SummaryCard[]; analysisStatus: "complete" | "partial" };
  return { final, cacheable, usable, rejectReasons };
}

export function parseSummaryCards(input: unknown): SummaryCard[] | null {
  let candidate: unknown = input;
  if (isRecord(input) && Object.prototype.hasOwnProperty.call(input, "cards")) {
    if (input.schemaVersion !== undefined && input.schemaVersion !== AI_SUMMARY_CARD_VERSION) return null;
    candidate = input.cards;
  }
  if (!Array.isArray(candidate) || candidate.length === 0) return null;
  return validateCardCatalog(candidate as SummaryCard[]);
}
