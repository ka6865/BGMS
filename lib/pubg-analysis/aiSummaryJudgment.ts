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

const ADVICE_RULES = [
  {
    pattern: /(?:혼자|단독으로|독립적인|독립적으로)[^.!?\n]{0,20}(?:교전|전투|싸움)[^.!?\n]{0,25}(?:늘리(?:세요|십시오)|늘려야|만들어야|만드(?:세요|십시오)|시도하(?:세요|십시오)|시도해야)/u,
    replacement: '다음 교전 전에 상대 위치와 빠져나올 경로를 확인해 보세요. 팀 모드라면 팀원이 함께 대응할 수 있는지도 확인하세요.',
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
