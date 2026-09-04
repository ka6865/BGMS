export interface AiCoachingQualitySignals {
  hasRawMilliseconds: boolean;
  hasUndefinedOrNaN: boolean;
  hasUnsupportedBackupBlame: boolean;
  hasUnsupportedTeamIntent: boolean;
  hasUnsupportedTeamDismissal: boolean;
  hasNicknameTransliteration: boolean;
  hasLowIsolationMisread: boolean;
  hasMissingDataLeak: boolean;
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
  { signalName: "hasUnsupportedBackupBlame", pattern: /느린 백업|느린 방관|방관|성공이라기엔/ },
  { signalName: "hasUnsupportedTeamIntent", pattern: /팀원을 방패|팀원을 들러리|팀원을 방치|미끼|혼자 다 해먹|혼자서 모든 것을 해결|팀원들의 지원이 부족하다는 방증|팀 민폐|오만/ },
  { signalName: "hasUnsupportedTeamDismissal", pattern: /팀 지원 지표가 바닥|나머지 팀원.{0,20}(전무|급격히 떨어질|무너)|팀 전체가 휘청|존재감이 희미/ },
  { signalName: "hasNicknameTransliteration", pattern: /강희성/ },
  { signalName: "hasLowIsolationMisread", pattern: /오합지졸|1인 솔로 4개|혼자 정글북|너무 멀리|독단적인 플레이(?!가 아닌)|독단 플레이(?!가 아닌)|고립될 위험/ },
  { signalName: "hasMissingDataLeak", pattern: /측정 불가.*비난|데이터 부족.*단정/ },
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

export function sanitizeAiCoachingLanguageText(text: string): string {
  return text
    .replace(/독단적인 플레이가 아닌/g, "대열을 유지하며 만든")
    .replace(/독단 플레이가 아닌/g, "대열을 유지하며 만든")
    .replace(/느린 백업/g, "백업 지연 위험")
    .replace(/느린 방관/g, "후속 복구 지연")
    .replace(/방관/g, "후속 복구 부족")
    .replace(/성공이라기엔/g, "성공 복구였지만")
    .replace(/혼자 다 해먹는/g, "강한 화력을 보여주는")
    .replace(/혼자 다 해먹/g, "강한 화력을 보여줌")
    .replace(/팀원들의 지원이 부족하다는 방증이며, 혼자서 모든 것을 해결하려는 부담이 큽니다\./g, "화력 비중이 높아 교전 주도는 선명하지만, 화력 분담을 더 고르게 만들 필요가 있습니다.")
    .replace(/팀원들의 지원이 부족하다는 방증/g, "화력 분담 보완이 필요한 신호")
    .replace(/혼자서 모든 것을 해결하려는 부담/g, "교전 부담이 한쪽에 몰리는 구조")
    .replace(/팀 민폐/g, "팀 지표 보완 필요")
    .replace(/전술적 오만/g, "전술적 보완점")
    .replace(/팀 지원 지표가 바닥/g, "팀 지원 지표 보완이 필요")
    .replace(/나머지 팀원들의 화력 지원이 전무/g, "다른 팀원들의 화력 지원 보완이 필요")
    .replace(/나머지 팀원들의 화력 지원이 다소 부족하여, 주력 화력이 쓰러질 경우 스쿼드 전체의 교전 능력이 급격히 떨어질 우려가 있습니다\./g, "화력 분담이 더 고르게 이루어지면 주력 화력이 흔들리는 상황에서도 스쿼드 전체 교전 안정성이 높아질 수 있습니다.")
    .replace(/팀 전체가 휘청거릴 수 있으니/g, "팀 교전 안정성이 흔들릴 수 있으니")
    .replace(/존재감이 희미합니다/g, "교전 기여를 더 선명하게 만들 필요가 있습니다")
    .replace(/위험한 독단 플레이/g, "팀 보조가 필요한 전진 플레이")
    .replace(/독단적인 플레이/g, "팀 보조가 필요한 플레이")
    .replace(/팀원을 방패로 세운/g, "팀 교전 분담이 부족했던")
    .replace(/팀원을 들러리로 세운/g, "팀 교전 분담이 부족했던")
    .replace(/팀원을 방치/g, "팀 지원 지표 보완이 필요")
    .replace(/미끼로 삼/g, "위험한 위치 교환이 발생")
    .replace(/오합지졸/g, "대열 정비가 필요한 스쿼드")
    .replace(/1인 솔로 4개/g, "개별 교전이 잦은 스쿼드")
    .replace(/혼자 정글북/g, "대열 이탈이 큰 운영");
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
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeAiCoachingLanguage(item)])
    ) as T;
  }

  return value;
}
