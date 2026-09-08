import { COACHING_JUDGMENT_WITHHELD, isNegatedCoachingDirectiveTail } from './aiCoachingQuality';

// Summary cards contain outcomes and response intervals, not movement speed,
// mental ability or engagement angles. These bounded rules cover observed
// provider regressions; they are not a general natural-language fact checker.
const UNSUPPORTED_INFERENCES = [
  /(?:피해량|화력)\s*분포(?:가|는)?\s*안정적으로\s*유지(?:되고|되었)/u,
  /집중력(?:을|이)?\s*(?:잘\s*)?유지하고\s*있/u,
  /(?:꾸준히|일관되게|매\s*경기)\s*(?:높은|안정적인)\s*(?:피해량|화력)(?:을|를)?\s*(?:기록했|기록한|유지했|보여주었)/u,
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
];

export function hasUnsupportedSummaryInference(text: string): boolean {
  return UNSUPPORTED_INFERENCES.some(pattern => {
    for (const match of text.matchAll(new RegExp(pattern.source, 'gu'))) {
      const tail = text.slice((match.index ?? 0) + match[0].length);
      if (/^(?:하)?다고\s*(?:단정|판단|평가)할\s*수\s*없/u.test(tail)
        || /^(?:[은는이가을를]\s*)?(?:의미|뜻)하지\s*않/u.test(tail)) continue;
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

const ADVICE_RULES = [
  {
    pattern: /(?:혼자|단독으로|독립적인|독립적으로)[^.!?\n]{0,20}(?:교전|전투|싸움)[^.!?\n]{0,25}(?:늘리(?:세요|십시오)|늘려야|만들어야|만드(?:세요|십시오)|시도하(?:세요|십시오)|시도해야)/u,
    replacement: '다음 교전 전에 상대 위치와 빠져나올 경로를 확인해 보세요. 팀 모드라면 팀원이 함께 대응할 수 있는지도 확인하세요.',
    allowsCondition: false,
  },
  {
    pattern: /(?:교전|전투|공격|사격)(?:\s*참여)?\s*(?:빈도|횟수|기회)(?:를|을)?[^.!?\n]{0,20}(?:높여|늘리(?:세요|십시오)|늘려야|넓히(?:세요|십시오)|넓혀야)/u,
    replacement: '다음 교전이 끝난 뒤 피해를 주기 어려웠던 구간을 돌아보세요. 팀 모드라면 팀원과 같은 적에게 함께 대응할 수 있었는지도 확인하세요.',
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
      if (rule.allowsCondition && /(?:팀원|상대|적|엄폐|퇴로|시야)[^.!?\n]{0,30}(?:확인한\s*뒤|확인되면|확보되면|가능할\s*때|가능하다면)/u.test(before)) continue;
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
