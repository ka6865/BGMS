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
  benchmarkLabel: string;
  unit: string;
  status: SummaryDataStatus;
  unavailableReason?: string;
  sampleCount: number | null;
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
  winner: "kind" | "spicy" | null;
}

export const SUMMARY_TOPIC_DEFINITIONS: Readonly<Record<SummaryTopicId, {
  topic: string;
  metricIds: readonly string[];
  defaultQuestion: string;
}>> = {
  firepower: { topic: "화력", metricIds: ["damage_average"], defaultQuestion: "화력에 대한 두 코치의 평가는?" },
  initiative: { topic: "교전 주도권", metricIds: ["initiative_rate", "pressure_index", "reaction_latency"], defaultQuestion: "교전 주도권에 대한 두 코치의 평가는?" },
  duel: { topic: "1:1 결정력", metricIds: ["duel_win_rate", "solo_kill_share"], defaultQuestion: "1:1 결정력에 대한 두 코치의 평가는?" },
  trade_backup: { topic: "복수 성공률 및 백업", metricIds: ["trade_success_rate", "backup_latency"], defaultQuestion: "복수 성공률 및 백업에 대한 두 코치의 평가는?" },
  utility: { topic: "유틸리티 활용", metricIds: ["utility_throws", "smoke_opportunity_rate"], defaultQuestion: "유틸리티 활용에 대한 두 코치의 평가는?" },
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
  duel_win_rate: { topicId: "duel", unit: "%" },
  solo_kill_share: { topicId: "duel", unit: "%" },
  trade_success_rate: { topicId: "trade_backup", unit: "%" },
  backup_latency: { topicId: "trade_backup", unit: "s" },
  utility_throws: { topicId: "utility", unit: "회" },
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
    ...(input.unavailableReason ? { unavailableReason: String(input.unavailableReason).trim() } : {}),
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
      status: "unavailable",
      unavailableReason: base.unavailableReason || DIVISION_BY_ZERO_REASON,
    };
  }

  if (rawUserValue !== null && parseDisplayValue(rawUserValue, metric.unit) === null) {
    return {
      ...base,
      userValue: null,
      benchmarkValue: null,
      status: "unavailable",
      unavailableReason: base.unavailableReason || MISSING_DATA_REASON,
    };
  }
  if (rawBenchmarkValue !== null && parseDisplayValue(rawBenchmarkValue, metric.unit) === null) {
    return {
      ...base,
      userValue: null,
      benchmarkValue: null,
      status: "unavailable",
      unavailableReason: base.unavailableReason || MISSING_DATA_REASON,
    };
  }

  if (rawUserValue === null) {
    return {
      ...base,
      benchmarkValue: null,
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
  return dataStatus === "comparable"
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
    const winner = card.winner === null || card.winner === "kind" || card.winner === "spicy"
      ? card.winner
      : undefined;
    if (winner === undefined) return null;
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
      if (isNeutralText(kindOpinion) && isNeutralText(spicyOpinion)) return null;
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
  const numerator = value.numerator === null || value.numerator === undefined ? null : finiteNonNegativeNumber(value.numerator);
  const denominator = value.denominator === null || value.denominator === undefined ? null : finiteNumber(value.denominator);
  if ((value.numerator !== null && value.numerator !== undefined && numerator === null)
    || (value.denominator !== null && value.denominator !== undefined && denominator === null)) return null;
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
    ...(numerator !== null ? { numerator } : {}),
    ...(denominator !== null ? { denominator } : {}),
  };
}

function isNeutralText(value: string): boolean {
  return !value.trim() || NEUTRAL_TEXTS.has(value.trim());
}

function sanitizeRequiredText(
  value: string,
  sanitizeText: (value: string) => string,
): { value: string; changed: boolean; empty: boolean } {
  try {
    const sanitized = sanitizeText(value);
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
    if (!isRecord(rawItem)) return null;
    const icon = nonEmptyString(rawItem.icon);
    const title = nonEmptyString(rawItem.title);
    const desc = nonEmptyString(rawItem.desc);
    if (!icon || !title || !desc) return null;
    if (isNeutralText(title) || isNeutralText(desc)) rejected.value = true;
    try {
      // Check the provider's original action text as well as the sanitized
      // copy. A sanitizer must not make a foreign-mode action cacheable just
      // because it removed the marker before this validation.
      if (hasUnsupportedMode(title) || hasUnsupportedMode(desc)) rejected.value = true;
    } catch {
      rejected.value = true;
    }
    const sanitizedTitle = sanitizeRequiredText(title, sanitizeText);
    const sanitizedDesc = sanitizeRequiredText(desc, sanitizeText);
    if (sanitizedTitle.empty || sanitizedDesc.empty
      || isNeutralText(sanitizedTitle.value) || isNeutralText(sanitizedDesc.value)) {
      rejected.value = true;
    }
    items.push({
      icon,
      title: sanitizedTitle.value || SAFE_SIGNATURE_SUB,
      desc: sanitizedDesc.value || SAFE_SIGNATURE_SUB,
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
    if (!normalized) continue;
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

export function normalizeSummaryCardFinal(input: unknown, cards: readonly SummaryCard[], options: {
  sanitizeText: (value: string) => string;
  hasUnsupportedMode: (value: unknown) => boolean;
}): { final: Record<string, unknown> & { schemaVersion: 2; cards: SummaryCard[] }; cacheable: boolean } | null {
  const serverCards = validateCardCatalog(cards);
  if (!serverCards || !isRecord(input) || !options || typeof options.sanitizeText !== "function" || typeof options.hasUnsupportedMode !== "function") {
    return null;
  }
  const providerSchemaVersion = input.schemaVersion;
  if (providerSchemaVersion !== undefined && providerSchemaVersion !== AI_SUMMARY_CARD_VERSION) return null;
  const signature = nonEmptyString(input.signature);
  const signatureSub = nonEmptyString(input.signatureSub);
  const finalVerdict = nonEmptyString(input.finalVerdict);
  if (!signature || !signatureSub || !finalVerdict || !Array.isArray(input.debateIssues) || input.debateIssues.length !== serverCards.length) {
    return null;
  }
  const actionItems = safeActionItems(input.actionItems, options.sanitizeText, options.hasUnsupportedMode);
  if (!actionItems) return null;

  let cacheable = !actionItems.rejected;
  const normalizedSignature = sanitizeRequiredText(signature, options.sanitizeText);
  const normalizedSignatureSub = sanitizeRequiredText(signatureSub, options.sanitizeText);
  const normalizedVerdict = sanitizeRequiredText(finalVerdict, options.sanitizeText);
  if (normalizedSignature.empty || normalizedSignatureSub.empty || normalizedVerdict.empty) cacheable = false;

  const safeSignature = normalizedSignature.value || SAFE_SIGNATURE;
  const safeSignatureSub = normalizedSignatureSub.value || SAFE_SIGNATURE_SUB;
  const safeVerdict = normalizedVerdict.value || SAFE_VERDICT;

  const providerByTopic = new Map<SummaryTopicId, Record<string, unknown>>();
  for (const rawIssue of input.debateIssues) {
    if (!isRecord(rawIssue)) return null;
    const topicId = rawIssue.topicId;
    if (!isSummaryTopicId(topicId)) return null;
    if (providerByTopic.has(topicId)) return null;
    providerByTopic.set(topicId, rawIssue);
  }
  if (providerByTopic.size !== serverCards.length || serverCards.some((card) => !providerByTopic.has(card.topicId))) return null;
  // `evidenceIds` is part of the provider schema even when a zero-observation
  // card has no references. Missing or non-array references are a malformed
  // final, whereas bad members inside an array are handled per card below.
  if (Array.from(providerByTopic.values()).some((issue) => !Array.isArray(issue.evidenceIds))) return null;

  let globalModeRejected = false;
  try {
    // A foreign-mode sentence in one card invalidates that card's
    // interpretation.  Keep unrelated cards usable; top-level prose has no
    // card owner, so it only makes the final non-cacheable.
    const topLevelProse = [signature, signatureSub, finalVerdict, ...actionItems.items.flatMap((item) => [item.title, item.desc])];
    globalModeRejected = topLevelProse.some((text) => options.hasUnsupportedMode(text));
  } catch {
    globalModeRejected = true;
  }
  if (globalModeRejected) cacheable = false;

  const normalizedCards = serverCards.map((serverCard) => {
    const issue = providerByTopic.get(serverCard.topicId);
    if (!issue) return serverCard;
    const providerWinner = issue.winner;
    const kindOpinion = nonEmptyString(issue.kindOpinion);
    const spicyOpinion = nonEmptyString(issue.spicyOpinion);
    const reason = nonEmptyString(issue.reason);
    const evaluation = nonEmptyString(issue.evaluation);
    if (!kindOpinion || !spicyOpinion || !reason || !evaluation || (providerWinner !== "kind" && providerWinner !== "spicy")) {
      cacheable = false;
      return unavailableCard(serverCard, "AI 응답의 필수 해석 필드가 유효하지 않습니다.");
    }

    const sanitized = [kindOpinion, spicyOpinion, reason, evaluation].map((text) => sanitizeRequiredText(text, options.sanitizeText));
    const proseRejected = sanitized.some((item) => item.empty);
    // An unavailable card has no observations to interpret, so the neutral
    // unavailable copy is an expected terminal state. Neutral coach opinions
    // remain invalid when the card has usable evidence.
    const bothOpinionsNeutral = serverCard.dataStatus !== "unavailable"
      && isNeutralText(sanitized[0].value)
      && isNeutralText(sanitized[1].value);
    let issueHasForeignMode = false;
    try {
      // Inspect prose only. Topic/metric IDs are structured server
      // references; a key such as `solo_kill_share` must never be mistaken
      // for a foreign SOLO queue marker by the legacy prose guard.
      issueHasForeignMode = [kindOpinion, spicyOpinion, reason, evaluation]
        .some((text) => options.hasUnsupportedMode(text));
    } catch {
      issueHasForeignMode = true;
    }

    const evidenceIds = Array.isArray(issue.evidenceIds) ? issue.evidenceIds : [];
    let referencesValid = true;
    const referenceValues = evidenceIds;
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

    const rejected = issueHasForeignMode || !referencesValid || proseRejected || bothOpinionsNeutral;
    if (rejected) {
      cacheable = false;
      return unavailableCard(serverCard, issueHasForeignMode ? "허용되지 않은 게임 모드가 포함되어 AI 해석을 보류했습니다." : UNAVAILABLE_REASON);
    }
    if (serverCard.dataStatus === "unavailable") {
      // Missing observations are an expected server state. Preserve the
      // factual card as unavailable without treating otherwise valid provider
      // prose as a cache rejection. The aggregate all-unavailable case is
      // forced non-cacheable below so it cannot be reported as AI success.
      return unavailableCard(serverCard, UNAVAILABLE_REASON);
    }

    const sanitizedTexts = sanitized.map((item) => item.value);
    const readyCard: SummaryCard = {
      ...serverCard,
      analysisStatus: "ready",
      kindOpinion: sanitizedTexts[0],
      spicyOpinion: sanitizedTexts[1],
      reason: sanitizedTexts[2],
      evaluation: sanitizedTexts[3],
      winner: serverCard.dataStatus === "comparable" ? providerWinner : null,
    };
    return readyCard;
  });

  const normalizedActionItems = actionItems.items;
  const finalCards = normalizedCards.map(cloneCard);
  if (finalCards.every((card) => card.dataStatus === "unavailable")) cacheable = false;
  const legacyIssues = finalCards.map((card) => {
    const comparableEvidence = card.evidence.filter((evidence) => evidence.status === "comparable" && evidence.userValue !== null && evidence.benchmarkValue !== null);
    return {
      topic: card.topic,
      question: card.question,
      kindOpinion: card.kindOpinion,
      spicyOpinion: card.spicyOpinion,
      winner: card.winner || "kind",
      reason: card.reason,
      evaluation: card.evaluation,
      userStats: comparableEvidence.map((evidence) => ({ label: evidence.label, value: evidence.userValue as string })),
      benchmarkStats: comparableEvidence.map((evidence) => ({ label: evidence.benchmarkLabel, value: evidence.benchmarkValue as string })),
    };
  });

  const final = {
    schemaVersion: AI_SUMMARY_CARD_VERSION,
    signature: safeSignature,
    signatureSub: safeSignatureSub,
    finalVerdict: safeVerdict,
    cards: finalCards,
    debateIssues: legacyIssues,
    actionItems: normalizedActionItems,
  } as Record<string, unknown> & { schemaVersion: 2; cards: SummaryCard[] };
  return { final, cacheable };
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
