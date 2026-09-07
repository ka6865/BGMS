export interface AiCoachingQualitySignals {
  hasRawMilliseconds: boolean;
  hasUndefinedOrNaN: boolean;
  hasUnsupportedBackupBlame: boolean;
  hasUnsupportedTeamIntent: boolean;
  hasUnsupportedTeamDismissal: boolean;
  hasNicknameTransliteration: boolean;
  hasLowIsolationMisread: boolean;
  hasMissingDataLeak: boolean;
  hasUnsupportedUtilityIntent: boolean;
  hasRecoveryLanguage: boolean;
  hasUtilitySeparationLanguage: boolean;
}

export type AiCoachingQualitySignalName = keyof AiCoachingQualitySignals;

export interface AiCoachingQualityFinding {
  signalName: AiCoachingQualitySignalName;
  match: string;
  snippet: string;
  index: number;
}

const AI_COACHING_QUALITY_RULES: Array<{ signalName: AiCoachingQualitySignalName; pattern: RegExp }> = [
  { signalName: "hasRawMilliseconds", pattern: /\d{4,}ms/ },
  { signalName: "hasUndefinedOrNaN", pattern: /undefined|NaN/ },
  { signalName: "hasUnsupportedBackupBlame", pattern: /느린 백업|느린 방관|방관|성공이라기엔|교전 종료 후 소생.{0,50}치명적/ },
  { signalName: "hasUnsupportedTeamIntent", pattern: /팀원을 방패|팀원을 들러리|팀원을 방치|미끼|혼자 다 해먹|혼자서 모든 것을 해결|팀원들의 지원이 부족하다는 방증|팀 민폐|오만|팀원 등쳐먹|이기적 독식|팀원.{0,12}들러리/ },
  { signalName: "hasUnsupportedTeamDismissal", pattern: /팀 지원 지표가 바닥|나머지 팀원.{0,20}(전무|급격히 떨어질|무너)|팀 전체가 휘청|존재감이 희미/ },
  { signalName: "hasNicknameTransliteration", pattern: /강희성/ },
  { signalName: "hasLowIsolationMisread", pattern: /오합지졸|1인 솔로 4개|혼자 정글북|너무 멀리|독단적인 플레이(?!가 아닌)|독단 플레이(?!가 아닌)|고립될 위험/ },
  { signalName: "hasMissingDataLeak", pattern: /측정 불가.*비난|데이터 부족.*단정/ },
  { signalName: "hasUnsupportedUtilityIntent", pattern: /연막.{0,40}(?:아껴서|아꼈|안\s*썼|쓰지\s*않았|국\s*끓)/ },
  { signalName: "hasRecoveryLanguage", pattern: /복구|소생|백업/ },
  { signalName: "hasUtilitySeparationLanguage", pattern: /피해형 투척|연막/ },
];

const BLOCKING_AI_COACHING_SIGNAL_NAMES = new Set<AiCoachingQualitySignalName>([
  "hasRawMilliseconds",
  "hasUndefinedOrNaN",
  "hasUnsupportedBackupBlame",
  "hasUnsupportedTeamIntent",
  "hasUnsupportedTeamDismissal",
  "hasNicknameTransliteration",
  "hasLowIsolationMisread",
  "hasMissingDataLeak",
  "hasUnsupportedUtilityIntent",
]);

function testQualityRule(text: string, signalName: AiCoachingQualitySignalName): boolean {
  const rule = AI_COACHING_QUALITY_RULES.find((item) => item.signalName === signalName);
  return rule ? rule.pattern.test(text) : false;
}

function createSnippet(text: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - 28);
  const end = Math.min(text.length, index + matchLength + 28);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

export function collectAiCoachingQualitySignals(text: string): AiCoachingQualitySignals {
  return {
    hasRawMilliseconds: testQualityRule(text, "hasRawMilliseconds"),
    hasUndefinedOrNaN: testQualityRule(text, "hasUndefinedOrNaN"),
    hasUnsupportedBackupBlame: testQualityRule(text, "hasUnsupportedBackupBlame"),
    hasUnsupportedTeamIntent: testQualityRule(text, "hasUnsupportedTeamIntent"),
    hasUnsupportedTeamDismissal: testQualityRule(text, "hasUnsupportedTeamDismissal"),
    hasNicknameTransliteration: testQualityRule(text, "hasNicknameTransliteration"),
    hasLowIsolationMisread: testQualityRule(text, "hasLowIsolationMisread"),
    hasMissingDataLeak: testQualityRule(text, "hasMissingDataLeak"),
    hasUnsupportedUtilityIntent: testQualityRule(text, "hasUnsupportedUtilityIntent"),
    hasRecoveryLanguage: testQualityRule(text, "hasRecoveryLanguage"),
    hasUtilitySeparationLanguage: testQualityRule(text, "hasUtilitySeparationLanguage"),
  };
}

export function isBlockingAiCoachingSignal(signalName: AiCoachingQualitySignalName): boolean {
  return BLOCKING_AI_COACHING_SIGNAL_NAMES.has(signalName);
}

export function findAiCoachingQualityFindings(text: string, options: { blockingOnly?: boolean } = {}): AiCoachingQualityFinding[] {
  const findings: AiCoachingQualityFinding[] = [];
  AI_COACHING_QUALITY_RULES.forEach((rule) => {
    if (options.blockingOnly && !isBlockingAiCoachingSignal(rule.signalName)) return;
    const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const pattern = new RegExp(rule.pattern.source, flags);
    for (const match of text.matchAll(pattern)) {
      const matchedText = match[0];
      const index = match.index ?? 0;
      findings.push({
        signalName: rule.signalName,
        match: matchedText,
        snippet: createSnippet(text, index, matchedText.length),
        index,
      });
    }
  });
  return findings.sort((a, b) => a.index - b.index || a.signalName.localeCompare(b.signalName));
}

export function hasBlockingAiCoachingQualityIssue(signals: AiCoachingQualitySignals): boolean {
  return Object.entries(signals).some(([key, value]) => isBlockingAiCoachingSignal(key as AiCoachingQualitySignalName) && value);
}

export const COACHING_JUDGMENT_WITHHELD = "해당 평가는 행동 근거가 부족해 보류합니다.";

// Counts alone do not establish a rescue rate or rescue ability. Keep this
// narrow: an observed count or a conditional practice instruction is allowed.
export function requiresRescueOpportunityEvidence(text: string): boolean {
  return /연막.{0,30}(?:구출|구조).{0,20}(?:능력.{0,10}(?:부족|보완|낮|못)|(?:성공률|구출률|률).{0,10}(?:\d+(?:\.\d+)?\s*%|부족|낮))/u.test(text);
}

const UNSUPPORTED_JUDGMENT_SIGNALS: AiCoachingQualitySignalName[] = [
  "hasUnsupportedBackupBlame", "hasUnsupportedTeamIntent",
  "hasUnsupportedTeamDismissal", "hasUnsupportedUtilityIntent", "hasLowIsolationMisread",
];

// Identity and server-owned evidence are not provider prose. In particular,
// a nickname containing a flagged word must survive cache normalization.
const NON_PROSE_KEYS = new Set([
  "id", "name", "nickname", "playerId", "player_id", "topicId", "metricId",
  "contextId", "evidenceIds", "evidence", "context", "userStats", "benchmarkStats",
]);

export function sanitizeAiCoachingLanguageText(text: string): string {
  // Some callers pass the entire JSON response, others a single prose field.
  // Never sentence-split serialized JSON: it can erase fields or corrupt IDs.
  if (/^\s*[\[{]/u.test(text)) {
    try {
      const parsed: unknown = JSON.parse(text);
      return JSON.stringify(sanitizeAiCoachingLanguage(parsed));
    } catch {
      // Malformed JSON is still rejected by the caller's schema boundary.
      // Do not turn malformed structured content into valid-looking prose.
      return text;
    }
  }
  const sentences = text.split(/(?<=[.!?。！？])\s+|\n+/u);
  let changed = false;
  const cleaned = sentences.map((sentence) => {
    if (UNSUPPORTED_JUDGMENT_SIGNALS.some((signal) => testQualityRule(sentence, signal))) {
      changed = true;
      return COACHING_JUDGMENT_WITHHELD;
    }
    return sentence;
  });
  return changed ? cleaned.filter((sentence, index) => sentence !== COACHING_JUDGMENT_WITHHELD
    || cleaned[index - 1] !== sentence).join(" ") : text;
}

export function sanitizeAiCoachingLanguage<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeAiCoachingLanguageText(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAiCoachingLanguage(item)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, NON_PROSE_KEYS.has(key) ? item : sanitizeAiCoachingLanguage(item)])
    ) as T;
  }

  return value;
}
