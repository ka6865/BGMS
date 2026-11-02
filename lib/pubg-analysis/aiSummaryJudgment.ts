import { COACHING_JUDGMENT_WITHHELD, isNegatedCoachingDirectiveTail } from './aiCoachingQuality';

// Summary cards contain outcomes and response intervals, not movement speed,
// mental ability or engagement angles. These bounded rules cover observed
// provider regressions; they are not a general natural-language fact checker.
const UNSUPPORTED_INFERENCES = [
  /(?:피해량|화력)\s*분포(?:가|는)?\s*안정적으로\s*유지(?:되고|되었)/u,
  /집중력(?:을|이)?\s*(?:잘\s*)?유지하고\s*있/u,
  /(?:꾸준히|일관되게|매\s*경기)\s*(?:높은|안정적인)\s*(?:피해량|화력)(?:을|를)?\s*(?:기록했|기록한|기록하며|기록하고\s*있|유지했|보여주었)/u,
  /꾸준한\s*화력\s*지원으로[^.!?\n]{0,20}교전\s*효율을\s*높이는\s*모습/u,
  /딜링\s*능력(?:을|를)?\s*꾸준히\s*발휘하고\s*있/u,
  /꾸준한\s*딜링\s*기록이\s*확인되므로/u,
  /꾸준히\s*피해량을\s*누적하고\s*있/u,
  /꾸준하게\s*적에게\s*유효한\s*피해를\s*누적하며\s*팀에\s*기여하고\s*있/u,
  /(?:관측된\s*)?교전\s*상황에서\s*꾸준히\s*교전에\s*임한\s*기록이\s*확인되/u,
  /아군\s*교전\s*상황에서\s*침착하게\s*대응하여\s*성과를\s*만들어냈/u,
  /연막과\s*피해형\s*투척을\s*목적에\s*맞게\s*나누어\s*사용하고\s*있/u,
  /관측된\s*피해량\s*분포를\s*바탕으로[^.!?\n]{0,24}다음\s*교전을\s*준비할\s*수\s*있/u,
  /(?:피해량|화력)[^.!?\n]{0,28}(?:분배|분포)[^.!?\n]{0,24}(?:능력|역량|확인|입증|보여|기록)/u,
  /(?:관측된\s*)?피해량\s*기록[^.!?\n]{0,28}화력\s*분포/u,
  /(?:후반까지\s*)?(?:안정적으로\s*)?생존[^.!?\n]{0,36}(?:팀[^.!?\n]{0,8}(?:운영|기여|승리)|교전\s*기여)/u,
  /안정적으로\s*생존[^.!?\n]{0,30}(?:운영하는\s*모습|운영했|운영하고\s*있)/u,
  /(?:빠른|뛰어난|우수한|탁월한)\s*반응\s*속도/u,
  /침착하게\s*(?:대응|반응|대처)하고\s*있/u,
  /(?:교전|전투)[^.!?\n]{0,28}(?:적극적으로\s*참여|참여한\s*흔적|임한\s*기록)/u,
  /(?:골고루|고루)\s*(?:사용|활용)(?:되|했|하|한)/u,
  /꾸준한\s*(?:딜링|화력|피해량)\s*(?:능력)?[^.!?\n]{0,16}(?:증명|입증)/u,
  /꾸준한\s*(?:전투|교전)\s*기여도(?:로|를)[^.!?\n]{0,20}(?:보여주었|증명했|입증했)/u,
  /(?:구출\s*연막|연막\s*구출)\s*(?:활용|사용)\s*빈도(?:가|는)?\s*낮/u,
  /(?:평균\s*)?고립\s*지수[^.!?\n]{0,16}기준에\s*부합/u,
  /보유량\s*(?:에\s*비해|대비)/u,
  /(?:빠른|느린|높은|낮은|뛰어난|우수한|탁월한|부족한|양호한|안정적인)\s*(?:이동\s*속도|기동성|기동력|집중력|판단력)/u,
  /(?:이동\s*속도|기동성|기동력|집중력|판단력)(?:은|는|이|가|을|를)?[^.!?\n]{0,25}(?:양호|우수|탁월|훌륭|부족|입증|돋보|보여|더\s*필요)/u,
  /기동력\s*중심의/u,
  /(?:교전|전투)[^.!?\n]{0,20}주도권[^.!?\n]{0,12}(?:쥐|확보했|장악했|입증)/u,
  /(?:더\s*)?주도적인\s*각을\s*만들어내야/u,
  // 측정하지 않은 집중력을 개선 대상으로 단정하거나 개선을 지시하는 문장. 집중력 유지 조언과 한계 진술은 막지 않는다.
  /집중력(?:을|이)?\s*(?:보완|개선|향상|강화|끌어올리|끌어올려|높여|높이|높일)(?!(?:[^.!?\n]{0,30}(?:측정되지|측정할\s*수\s*없|판단할\s*수\s*없|판단하기\s*어렵|평가할\s*수\s*없|알\s*수\s*없|관측되지|확인되지))|[^.!?\n]{0,8}(?:필요(?:는|가|도)?\s*없|필요하지\s*않|않))/u,
  // 요약 카드에 없는 사격 지표. 명중·적중 비율, 조준, 반동, 탄약은 요약 근거로 전달하지 않는다.
  /(?:명중률|적중률|명중\s*정확도|사격\s*정확도|에임|조준\s*(?:능력|실력|정확도|속도)|반동\s*(?:제어|조절|관리)|탄약|탄창|장전|헤드샷)/u,
];

export function hasUnsupportedSummaryInference(text: string): boolean {
  return UNSUPPORTED_INFERENCES.some(pattern => {
    for (const match of text.matchAll(new RegExp(pattern.source, 'gu'))) {
      const tail = text.slice((match.index ?? 0) + match[0].length);
      const continuation = tail.trimStart();
      if (/^(?:하)?다고\s*(?:단정|판단|평가)할\s*수\s*없/u.test(continuation)
        || /^(?:[은는이가을를]\s*)?(?:(?:(?:확인|입증)되었다고\s*)?(?:단정|판단|평가)할\s*수\s*없|(?:확인|입증|관측)되지\s*않|(?:의미|뜻)하지\s*않|아니|없|않|못)/u.test(continuation)
        || /^(?:하는지|했는지|는지|ㄴ지|은지|을지|ㄹ지|여부(?:를)?)[^.!?\n]{0,24}(?:확인|점검|살펴)/u.test(continuation)) continue;
      return true;
    }
    return false;
  });
}

export function sanitizeSummaryInferenceText(text: string): string {
  if (!hasUnsupportedSummaryInference(text)) return text;
  // Split only prose fields, never serialized JSON or numeric evidence.
  const sentences = text.split(/(?<=[.!?。！？])\s+|\n+/u);
  const retained = sentences.filter(sentence => !hasUnsupportedSummaryInference(sentence)).join(' ').trim();
  return retained || COACHING_JUDGMENT_WITHHELD;
}

// 행동 제안의 중립 점검 문장. 근거가 빠진 제안을 대신하는 문장으로도 쓴다.
const NEXT_ENGAGEMENT_CHECK = '다음 교전 전에 상대 위치와 빠져나올 경로를 확인해 보세요. 팀 모드라면 팀원이 함께 대응할 수 있는지도 확인하세요.';
const THROW_USAGE_CHECK = '다음 교전에서 투척을 쓸 수 있었던 상황이 있었는지 확인해 보세요.';

const ADVICE_RULES = [
  {
    pattern: /(?:혼자|단독으로|독립적인|독립적으로)[^.!?\n]{0,20}(?:교전|전투|싸움)[^.!?\n]{0,25}(?:늘리(?:세요|십시오)|늘려야|만들어야|만드(?:세요|십시오)|시도하(?:세요|십시오)|시도해야)/u,
    replacement: NEXT_ENGAGEMENT_CHECK,
    allowsCondition: false,
  },
  {
    pattern: /(?:교전|전투|공격|사격)(?:\s*참여)?\s*(?:빈도|횟수|기회)(?:를|을)?[^.!?\n]{0,20}(?:높여|늘리(?:세요|십시오)|늘리거나\s*교전\s*거리\s*조절을\s*검토(?:하십시오|하세요|해야)|늘려야|넓히(?:세요|십시오)|넓혀야)/u,
    replacement: '다음 교전이 끝난 뒤 피해를 주기 어려웠던 구간을 돌아보세요. 팀 모드라면 팀원과 같은 적에게 함께 대응할 수 있었는지도 확인하세요.',
    allowsCondition: true,
  },
  {
    pattern: /(?:구출|구조)\s*(?:상황에서\s*)?(?:연막\s*)?(?:활용|사용|시도)\s*(?:빈도|횟수)(?:를|을)?[^.!?\n]{0,24}(?:높이|늘리(?:세요|십시오)|늘려|늘려야|높여야)/u,
    replacement: '다음 아군 기절 상황에서 연막을 사용할 수 있었는지와 사용 시점을 점검하세요.',
    allowsCondition: true,
  },
  {
    pattern: /연막[^.!?\n]{0,24}구출\s*연계[^.!?\n]{0,24}(?:더\s*)?(?:적극적으로\s*)?시도(?:하(?:세요|십시오|여야)|해야)/u,
    replacement: '다음 아군 기절 상황에서 연막을 사용할 수 있었는지와 구출 시점을 점검하세요.',
    allowsCondition: true,
  },
  {
    pattern: /생존\s*시간[^.!?\n]{0,20}교전\s*기여도[^.!?\n]{0,30}(?:높이(?:세요|십시오|도록)|높여야|분발하(?:세요|십시오))/u,
    replacement: '다음 교전 후 피해를 주기 어려웠던 구간과 팀원과 함께 대응할 수 있었는지 점검하세요.',
    allowsCondition: true,
  },
  {
    pattern: /(?:교전\s*당\s*)?(?:피해량|피해)(?:을|를)?\s*높이기\s*위한[^.!?\n]{0,30}(?:사격|공격)\s*(?:기회|빈도)[^.!?\n]{0,12}(?:만들|늘리|넓히)(?:어야|세요|십시오)/u,
    replacement: '다음 교전 후 피해를 주기 어려웠던 구간과 사격 기회가 있었는지 점검하세요.',
    allowsCondition: true,
  },
  {
    // 협공 비중·타이밍 맞춘 집중 타격은 요약 카드가 관측한 조율 기록이 아니다.
    pattern: /협공[^.!?\n]{0,20}(?:비중|교전)[^.!?\n]{0,12}(?:확대|늘리|늘려|높이|높여)|아군과[^.!?\n]{0,12}타이밍을?\s*맞춘[^.!?\n]{0,24}(?:시도|공격)(?:하세요|하십시오|해\s*보세요|해야)/u,
    replacement: NEXT_ENGAGEMENT_CHECK,
    allowsCondition: true,
  },
  {
    // 투척·수류탄·유틸리티 사용량이나 명중률을 늘리라는 권고. 접두사 없는 표현도 잡고, 권고 어미가 붙은 문장에서만 동작한다.
    // 부정된 지시("늘리지 마세요")와 사실 서술("사용하지 않아 피해를 높이지 못했다")은 막지 않는다.
    pattern: /(?:투척|수류탄|유틸리티)[^.!?\n]{0,16}(?:늘리|늘려|늘릴|높이|높여|높일|키우|키워|키울|증가)(?!\s*지\s*(?:마|않|말))[^.!?\n]{0,12}(?:세요|십시오|해야|여야|야\s*(?:합니다|한다|해요)|것이\s*(?:좋|필요)|필요합니다|좋습니다)|(?:투척|수류탄|유틸리티)[^.!?\n]{0,16}(?:더\s*)?(?:많이|자주)\s*(?:던지|던져|쓰|써|사용|활용)(?![^.!?\n]{0,4}지\s*(?:마|않|말))[^.!?\n]{0,12}(?:세요|십시오|해야|여야|야\s*(?:합니다|한다|해요)|것이\s*(?:좋|필요)|필요합니다|좋습니다)/u,
    // 투척 사용량 증가는 표본과 무관하게 근거가 없다. 요약은 사용 여부만 확인 질문으로 바꾼다.
    replacement: THROW_USAGE_CHECK,
    allowsCondition: true,
  },
] as const;

function unsupportedAdviceRule(sentence: string) {
  return ADVICE_RULES.find(rule => {
    for (const match of sentence.matchAll(new RegExp(rule.pattern.source, 'gu'))) {
      const tail = sentence.slice(match.index + match[0].length);
      if (isNegatedCoachingDirectiveTail(tail)) continue;
      // A concrete precondition differs from optimizing an aggregate count.
      const before = sentence.slice(0, match.index);
      if (rule.allowsCondition && /(?:팀원|아군|상대|적|엄폐|퇴로|시야)[^.!?\n]{0,30}(?:확인한\s*뒤|확인되면|확보되면|가능할\s*때|가능하다면)/u.test(before)) continue;
      return true;
    }
    return false;
  });
}

export function hasUnsupportedSummaryAdvice(text: string): boolean {
  return text.split(/(?<=[.!?。！？])\s+|\n+/u).some(sentence => Boolean(unsupportedAdviceRule(sentence)));
}

export function sanitizeSummaryAdviceText(text: string): string {
  if (!hasUnsupportedSummaryAdvice(text)) return text;
  return [...new Set(text.split(/(?<=[.!?。！？])\s+|\n+/u)
    .map(sentence => unsupportedAdviceRule(sentence)?.replacement ?? sentence))].join(' ').trim();
}

// 이전 형식(v1) 요약의 판단 문자열. v2 카드와 같은 정책을 쓰고, 필드 이름만 레거시 JSON에 맞춘다.
const LEGACY_DEBATE_JUDGMENT_FIELDS = ['kindOpinion', 'spicyOpinion', 'reason', 'evaluation'] as const;
const LEGACY_ACTION_JUDGMENT_FIELDS = ['title', 'desc'] as const;

function sanitizeSummaryJudgmentProse(text: string): string {
  return sanitizeSummaryInferenceText(sanitizeSummaryAdviceText(text));
}

// 제목은 짧은 라벨이라 조언 문장으로 바꾸지 않고, 정책에 걸리면 중립 라벨로 바꾼다.
const LEGACY_NEUTRAL_ACTION_TITLE = '다음 교전 점검';

function sanitizeLegacyRecordFields(record: unknown, fields: readonly string[]): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => {
    if (!fields.includes(key) || typeof value !== 'string') return [key, value];
    const sanitized = sanitizeSummaryJudgmentProse(value);
    if (key !== 'title') return [key, sanitized];
    return [key, sanitized === value ? value : LEGACY_NEUTRAL_ACTION_TITLE];
  }));
}

/**
 * v1 요약 최종 JSON의 판단 문자열(finalVerdict, debateIssues 의견·근거, actionItems 제목·설명)에 정책을 적용한다.
 * 근거가 빠진 행동 제안은 항목째 뺀다. 모두 빠지면 중립 점검 항목 1개로 채운다.
 * 빈 목록을 저장하면 다음 캐시 읽기의 정규화가 거부해 매번 미스가 나므로 빈 목록은 만들지 않는다. 두 번 적용해도 결과가 같다.
 */
export function sanitizeLegacySummaryJudgment(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = { ...record };
  if (typeof record.finalVerdict === 'string') result.finalVerdict = sanitizeSummaryJudgmentProse(record.finalVerdict);
  if (Array.isArray(record.debateIssues)) {
    result.debateIssues = record.debateIssues.map(issue => sanitizeLegacyRecordFields(issue, LEGACY_DEBATE_JUDGMENT_FIELDS));
  }
  if (Array.isArray(record.actionItems)) {
    const kept = record.actionItems
      .map(item => sanitizeLegacyRecordFields(item, LEGACY_ACTION_JUDGMENT_FIELDS))
      .filter(item => !(item && typeof item === 'object' && (item as Record<string, unknown>).desc === COACHING_JUDGMENT_WITHHELD));
    result.actionItems = kept.length === 0 && record.actionItems.length > 0
      ? [{ icon: 'target', title: LEGACY_NEUTRAL_ACTION_TITLE, desc: NEXT_ENGAGEMENT_CHECK }]
      : kept;
  }
  return result;
}
