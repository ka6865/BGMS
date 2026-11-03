import { COACHING_JUDGMENT_WITHHELD } from "./aiCoachingQuality";
import { hasUnsupportedSummaryInference } from "./aiSummaryJudgment";

// 요약 정책(aiSummaryJudgment)이 다루지 않는 스쿼드 전용 표현이다.
// 스쿼드 지표에는 사격 능력·두뇌·손가락·집중력·판단력·멘탈 값이 없으므로 근거가 있을 수 없다.
const SQUAD_UNSUPPORTED_ABILITY_PATTERNS = [
  /뇌(?!절)/u,
  /두뇌/u,
  /손가락/u,
  /에임|조준|반동|헤드샷|샷\s*발/u,
  /명중\s*(?:률|력|정확)/u,
  /사격\s*(?:실력|능력|감각|정확도)/u,
  /집중력|판단력|멘탈|정신력/u,
];

// 딜·킬·어시스트·기절 비중은 합이 100%인 분배라 개인의 못한 점이나 조언 근거가 될 수 없다.
const SQUAD_SHARE_BLAME_PATTERN = /(?:딜|피해량|킬|어시스트|녹다운|기절)\s*비중/u;

const SENTENCE_SPLIT = /(?<=[.!?。！？])\s+|\n+/u;

// 자유 서술 필드에만 쓴다. 숫자 근거와 JSON 구조는 건드리지 않는다.
const SQUAD_PROSE_FIELDS = ["summary", "strength", "weakness", "coaching", "overallOpinion"] as const;
const SQUAD_MEMBER_PROSE_FIELDS = ["praise", "fault", "advice"] as const;

export type SquadWithheldKey = "generic" | "member" | "grade" | "rescueNoOpportunity" | "rescueLow";

// 다정한맛과 기본 보류 문구. 매운맛이 아니면 항상 이 문구를 쓴다.
const MILD_WITHHELD_COPY: Record<SquadWithheldKey, string> = {
  generic: COACHING_JUDGMENT_WITHHELD,
  member: "개인 행동을 단정할 근거가 부족해 해당 평가는 보류합니다.",
  grade: "미측정 지표가 있어 종합 등급은 보류합니다.",
  rescueNoOpportunity: "연막 구출 기회가 관측되지 않아 해당 평가는 보류합니다.",
  rescueLow: "연막 구출 기록이 부족해 해당 평가는 보류합니다.",
};

// 매운맛 넘김 문장. 건조한 보류 문장 대신 캐릭터 말투로 짧게 넘긴다.
// 수치·측정 지표 이름·능력 단정이 없어서 후처리 가드를 다시 통과하고, 두 번 적용해도 바뀌지 않는다.
export const SQUAD_SPICY_PASS_LINES = [
  "이건 기록이 없어서 오늘은 봐드립니다.",
  "증거 불충분, 이번 판은 무죄 방면.",
  "측정된 게 없으니 이번엔 조용히 넘어갑니다.",
  "기록이 안 남았으니 오늘은 면죄부 발급입니다.",
  "데이터가 입을 다물었으니 여기선 패스.",
  "근거 없이 놀리면 저만 손해라 이번엔 패스합니다.",
] as const;

const SPICY_WITHHELD_COPY: Record<Exclude<SquadWithheldKey, "generic" | "member">, string> = {
  grade: "종합 등급은 증거가 부족해 이번엔 면제입니다.",
  rescueNoOpportunity: "연막 구출 기회가 안 잡혀서 오늘은 봐드립니다.",
  rescueLow: "연막 구출 기록이 모자라 이번 판은 봐드립니다.",
};

// 측정 지표 이름별 보류 문구. 생존 케어는 평가 지표 목록 밖이지만 같은 형식을 쓴다.
const SQUAD_METRIC_LABELS = ["대열 유지", "백업 속도", "연막 구출", "아군 소생", "엄호·집중사격", "전멸 기여", "생존 케어"] as const;

/** 지표 이름이 든 보류 문구다. 매운맛은 같은 뜻을 넘김 말투로 바꾼다. */
export function squadMetricWithheldCopy(coachingStyle: string | undefined, label: string): string {
  return coachingStyle === "spicy"
    ? `${label} 기록이 없어서 오늘은 봐드립니다.`
    : `${label} 평가는 근거가 부족해 보류합니다.`;
}

/**
 * 보류 문구를 고른다. 매운맛의 일반·멤버 문구는 시드의 해시로 넘김 문장 중 하나를 고른다.
 * 같은 입력이면 같은 문장이 나온다.
 */
export function squadWithheldCopy(coachingStyle: string | undefined, key: SquadWithheldKey, seed = ""): string {
  if (coachingStyle !== "spicy") return MILD_WITHHELD_COPY[key];
  if (key === "generic" || key === "member") {
    return SQUAD_SPICY_PASS_LINES[stableIndex(`${key}|${seed}`, SQUAD_SPICY_PASS_LINES.length)];
  }
  return SPICY_WITHHELD_COPY[key];
}

// 이 정책이 만들 수 있는 모든 보류 문구다. 이미 보류 문구인 문장은 다시 치환하지 않아 멱등을 지킨다.
const KNOWN_WITHHELD_COPY = new Set<string>([
  ...Object.values(MILD_WITHHELD_COPY),
  ...Object.values(SPICY_WITHHELD_COPY),
  ...SQUAD_SPICY_PASS_LINES,
  ...SQUAD_METRIC_LABELS.flatMap(label => [squadMetricWithheldCopy("mild", label), squadMetricWithheldCopy("spicy", label)]),
]);

export function isSquadWithheldCopy(sentence: string): boolean {
  return KNOWN_WITHHELD_COPY.has(sentence.trim());
}

/**
 * 화면에 보여줄 내용이 있는지 본다. 비어 있거나 보류·넘김 문장뿐이면 false다.
 * 근거가 없어 넘긴 칸을 팀원마다 반복해서 보여주지 않으려고 화면 쪽이 쓴다.
 */
export function hasSquadFeedbackContent(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return text
    .split(SENTENCE_SPLIT)
    .map(sentence => sentence.trim())
    .some(sentence => sentence !== "" && !isSquadWithheldCopy(sentence));
}

function stableIndex(seed: string, size: number): number {
  // FNV-1a 32비트 해시. 같은 문자열이면 항상 같은 인덱스를 준다.
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash ^ seed.charCodeAt(index)) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % size;
}

function isUnsupportedSquadSentence(sentence: string, blameField = false): boolean {
  return hasUnsupportedSummaryInference(sentence)
    || SQUAD_UNSUPPORTED_ABILITY_PATTERNS.some(pattern => pattern.test(sentence))
    || (blameField && SQUAD_SHARE_BLAME_PATTERN.test(sentence));
}

// 일반 보류 문장(COACHING_JUDGMENT_WITHHELD)을 매운맛 넘김 문장으로 바꾼다. 다정한맛은 그대로 둔다.
function localizeGenericWithheld(text: string, coachingStyle: string | undefined, seed: string): string {
  if (coachingStyle !== "spicy" || !text.includes(COACHING_JUDGMENT_WITHHELD)) return text;
  const parts = text.split(COACHING_JUDGMENT_WITHHELD);
  let output = parts[0];
  for (let index = 1; index < parts.length; index += 1) {
    output += squadWithheldCopy(coachingStyle, "generic", `${seed}#${index}`) + parts[index];
  }
  return output;
}

/**
 * 근거 없는 능력 단정이 든 문장만 뺀다. 모두 빠지면 보류 문장 하나로 바꾼다.
 * 매운맛은 보류 문장을 넘김 문장으로 바꾼다. 문제가 없으면 입력을 그대로 돌려주므로 여러 번 적용해도 결과가 같다(멱등).
 */
export function sanitizeSquadAbilityText(text: string, coachingStyle?: string, blameField = false): string {
  const sentences = text.split(SENTENCE_SPLIT);
  const unsupported = (sentence: string) => isUnsupportedSquadSentence(sentence, blameField);
  if (!sentences.some(unsupported)) return localizeGenericWithheld(text, coachingStyle, text);
  const retained = sentences.filter(sentence => !unsupported(sentence)).join(" ").trim();
  return localizeGenericWithheld(retained || COACHING_JUDGMENT_WITHHELD, coachingStyle, text);
}

/**
 * 스쿼드 AI 응답의 자유 서술 필드에 능력 단정 정책을 적용한다.
 * 팀원 이름과 등급 같은 구조 필드는 바꾸지 않는다. 생성 결과와 캐시 읽기 양쪽에 같은 함수를 적용한다.
 */
export function sanitizeSquadAbilityClaims<T>(value: T, coachingStyle?: string): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = { ...record };
  for (const field of SQUAD_PROSE_FIELDS) {
    const text = record[field];
    if (typeof text === "string") output[field] = sanitizeSquadAbilityText(text, coachingStyle);
  }
  if (Array.isArray(record.memberFeedbacks)) {
    output.memberFeedbacks = record.memberFeedbacks.map((member: unknown) => {
      if (!member || typeof member !== "object" || Array.isArray(member)) return member;
      const memberRecord = member as Record<string, unknown>;
      const cleaned: Record<string, unknown> = { ...memberRecord };
      for (const field of SQUAD_MEMBER_PROSE_FIELDS) {
        const text = memberRecord[field];
        if (typeof text === "string") cleaned[field] = sanitizeSquadAbilityText(text, coachingStyle, field !== "praise");
      }
      return cleaned;
    });
  }
  return output as T;
}
