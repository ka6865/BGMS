import { hasObservedBenchmarkMetric, type NormalizedBenchmark } from './benchmarkAdapter';
import { requiresRescueOpportunityEvidence, isNegatedCoachingDirectiveTail } from './aiCoachingQuality';

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const display = (value: number) => Number(value.toFixed(1));

/** Reconcile known factual failure patterns against the canonical match on fresh/cache reads.
 * This is a bounded evidence policy, not a general verifier of arbitrary natural language.
 */
export function applyMatchAiEvidencePolicy(text: string, match: any): string {
  const utility = match?.combatPressure?.utilityStats || {};
  const total = finite(utility.throwCount), lethal = finite(utility.lethalThrowCount);
  const hits = utility.accuracyStatus === 'missing' ? null : finite(utility.hitCount);
  const accuracy = hits !== null && lethal !== null && lethal > 0 ? display(hits / lethal * 100) : null;
  const isolation = finite(match?.isolationData?.isolationIndex);
  const throwFacts = `총 투척 ${total === null ? '측정 불가' : `${total}회`}, 피해형 투척 ${lethal === null ? '측정 불가' : `${lethal}회`}, 피해 적중 ${hits === null ? '측정 불가' : `${hits}회`}입니다. 피해형 투척 적중률은 ${accuracy === null ? '측정 불가' : `${accuracy}%`}입니다.`;
  const comparison = /(?:상위권|동일\s*티어|비교\s*평균|엘리트)[^.!?。！？]{0,40}(?:비해|보다|기준|수준|평균|부족|낮|높|느|뒤처)/u;
  const metricBenchmarks: Array<[RegExp, keyof NormalizedBenchmark]> = [
    [/(?:대응|반응)\s*(?:사격)?\s*속도/u, 'avgCounterLatency'],
    [/백업\s*속도/u, 'avgTradeLatency'], [/고립/u, 'avgIsolationIndex'],
    [/(?:피해량|딜량|화력)/u, 'avgDamage'], [/복수/u, 'avgTradeRate'],
  ];
  const clean = (value: string, key: string): string => {
    // Duel outcomes do not measure concentration. Keep adjacent factual prose
    // and use canonical counts instead of retaining the provider's inference.
    const concentrationClaim = /(?:높은|뛰어난|우수한|탁월한)\s*집중력(?:을|이)?\s*(?:보여|입증|증명)/u;
    if (concentrationClaim.test(value)) {
      const wins = finite(match?.duelStats?.wins), duels = finite(match?.duelStats?.totalDuels);
      const facts = wins !== null && duels !== null && duels > 0 && wins <= duels
        ? `관측된 1:1 교전 ${duels}회 중 ${wins}회 승리했습니다.`
        : '교전 결과만으로 집중력을 판단할 수 없습니다.';
      value = value.split(/(?<=[.!?。！？])\s+|\n+/u)
        .map(sentence => concentrationClaim.test(sentence) ? facts : sentence).join(' ');
    }
    // tradeLatencyMs ends at the revenge kill; revCount supplies no revive
    // duration. Do not turn that interval into a revive-speed coaching target.
    if (key === 'desc') {
      value = value.split(/(?<=[.!?。！？])\s+|\n+/u).map(sentence => {
        const directives = sentence.matchAll(/(?:소생|부활)\s*(?:소요\s*)?시간[^.!?\n]{0,30}?(?:줄여|단축)/gu);
        for (const directive of directives) {
          if (!isNegatedCoachingDirectiveTail(sentence.slice(directive.index + directive[0].length))) {
            return '다음 교전에서는 적 제압 후 아군의 상태를 확인하고 소생 가능한 상황인지 점검하세요.';
          }
        }
        return sentence;
      }).join(' ');
    }
    if (requiresRescueOpportunityEvidence(value)) {
      const opportunities = finite(match?.tradeStats?.teammateKnocks);
      const successes = finite(match?.tradeStats?.smokeRescues);
      if (opportunities === null || opportunities === 0 || successes === null) {
        return opportunities === 0
          ? '연막 구출 기회가 관측되지 않아 해당 평가는 보류합니다.'
          : '연막 구출 기록이 부족해 해당 평가는 보류합니다.';
      }
    }
    if (isolation !== null && isolation < 2 && /고립형|고독한|고립(?:이|도|\s*위험)?.{0,8}(?:심|높)|대열\s*이탈/u.test(value)) {
      return key === 'signature' ? '대열 유지형 플레이어' : `평균 고립 지수는 ${display(isolation)}입니다. 실제 교전 위치와 함께 확인해 보세요.`;
    }
    if (/숨어\s*다니|후방|아군\s*곁을\s*맴돌|몸을\s*사리/u.test(value)) {
      if (key === 'signature') return '화력 기여형 플레이어';
      return '관측 기록만으로 교전 의도나 대기 위치를 단정할 수 없습니다. 다음 교전에서는 아군과 함께 대응할 기회를 확인해 보세요.';
    }
    if (lethal === 0 && /유틸리티|투척/.test(value) && /보조.{0,15}(?:못|부족)|능력.{0,15}못/.test(value)) return throwFacts;
    if (/배지.{0,15}(?:없|전무)/.test(value) && /부족|실속|아쉬/.test(value)) return '배지 획득 여부만으로 경기 기여도를 평가하지 않습니다. 관측된 전투 기록을 함께 확인해 보세요.';
    if (comparison.test(value)) {
      const referenced = metricBenchmarks.filter(([pattern]) => pattern.test(value));
      if (!referenced.length || referenced.some(([, metric]) => !hasObservedBenchmarkMetric(match?.eliteBenchmark, metric))) {
        return '같은 조건의 비교 자료가 없어 상대 평가는 보류합니다.';
      }
    }
    // Restrict count repair to factual fields; action-item numeric targets are recommendations.
    if (['signatureSub', 'briefFeedback', 'finalVerdict'].includes(key)) {
      const lethalClaim = value.match(/피해형\s*투척(?:물)?\s*(\d+(?:\.\d+)?)\s*회/u);
      const totalClaim = value.match(/총\s*투척(?:물)?\s*(\d+(?:\.\d+)?)\s*회/u);
      const accuracyClaim = value.match(/(?:투척(?:물)?\s*)?적중률\s*(\d+(?:\.\d+)?)\s*%/u);
      if ((lethalClaim && Number(lethalClaim[1]) !== lethal)
        || (totalClaim && Number(totalClaim[1]) !== total)
        || (accuracyClaim && (accuracy === null || Math.abs(Number(accuracyClaim[1]) - accuracy) > 0.1))) return throwFacts;
    }
    return value;
  };
  const visit = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') return clean(value, key);
    if (Array.isArray(value)) return value.map(item => visit(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, name)]));
    return value;
  };
  try { return JSON.stringify(visit(JSON.parse(text))); } catch { return clean(text, 'briefFeedback'); }
}
