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

const SENTENCE_SPLIT = /(?<=[.!?。！？])\s+|\n+/u;

// 자유 서술 필드에만 쓴다. 숫자 근거와 JSON 구조는 건드리지 않는다.
const SQUAD_PROSE_FIELDS = ["summary", "strength", "weakness", "coaching", "overallOpinion"] as const;
const SQUAD_MEMBER_PROSE_FIELDS = ["praise", "fault", "advice"] as const;

function isUnsupportedSquadSentence(sentence: string): boolean {
  return hasUnsupportedSummaryInference(sentence)
    || SQUAD_UNSUPPORTED_ABILITY_PATTERNS.some(pattern => pattern.test(sentence));
}

/**
 * 근거 없는 능력 단정이 든 문장만 뺀다. 모두 빠지면 중립 문장 하나로 바꾼다.
 * 문제가 없으면 입력을 그대로 돌려주므로 여러 번 적용해도 결과가 같다(멱등).
 */
export function sanitizeSquadAbilityText(text: string): string {
  const sentences = text.split(SENTENCE_SPLIT);
  if (!sentences.some(isUnsupportedSquadSentence)) return text;
  const retained = sentences.filter(sentence => !isUnsupportedSquadSentence(sentence)).join(" ").trim();
  return retained || COACHING_JUDGMENT_WITHHELD;
}

/**
 * 스쿼드 AI 응답의 자유 서술 필드에 능력 단정 정책을 적용한다.
 * 팀원 이름과 등급 같은 구조 필드는 바꾸지 않는다. 생성 결과와 캐시 읽기 양쪽에 같은 함수를 적용한다.
 */
export function sanitizeSquadAbilityClaims<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = { ...record };
  for (const field of SQUAD_PROSE_FIELDS) {
    const text = record[field];
    if (typeof text === "string") output[field] = sanitizeSquadAbilityText(text);
  }
  if (Array.isArray(record.memberFeedbacks)) {
    output.memberFeedbacks = record.memberFeedbacks.map((member: unknown) => {
      if (!member || typeof member !== "object" || Array.isArray(member)) return member;
      const memberRecord = member as Record<string, unknown>;
      const cleaned: Record<string, unknown> = { ...memberRecord };
      for (const field of SQUAD_MEMBER_PROSE_FIELDS) {
        const text = memberRecord[field];
        if (typeof text === "string") cleaned[field] = sanitizeSquadAbilityText(text);
      }
      return cleaned;
    });
  }
  return output as T;
}
