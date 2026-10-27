import { isEarlyElimination } from "./benchmarkScore";
import { hasComparableBenchmarkMetric, type NormalizedBenchmark } from './benchmarkAdapter';
import { COUNTER_LATENCY_PENALTY_MS } from './constants';
import { firstReplyLatencyMs } from './firstReply';
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
  const stats = match?.stats || {}, trade = match?.tradeStats || {};
  const duels = finite(match?.duelStats?.totalDuels), initiativeSamples = finite(match?.initiativeSampleCount);
  const firstReply = firstReplyLatencyMs(match);
  const contributionParts = ([
    [stats.kills, '처치'], [stats.assists, '어시스트'], [stats.DBNOs, '기절'], [trade.revCount, '소생'], [trade.enemyTeamWipes, '적 팀 전멸 기여'],
  ] as Array<[unknown, string]>).flatMap(([count, label]) => (finite(count) ?? 0) > 0 ? [`${label} ${count}회`] : []);
  const damage = finite(stats.processedDamageDealt) ?? finite(stats.damageDealt);
  if (damage !== null && damage > 0) contributionParts.push(`${finite(stats.processedDamageDealt) === null ? '피해' : '유효 피해'} ${display(damage)}`);
  const duelWins = finite(match?.duelStats?.wins);
  if (duelWins !== null && duelWins > 0) contributionParts.push(`1:1 교전 승리 ${duelWins}회`);
  const contributionFacts = contributionParts.length ? `이번 경기에서 ${contributionParts.join(', ')}를 기록했습니다.` : null;
  const earlyElimination = isEarlyElimination({ survivalTime: finite(stats.timeSurvived), deathPhase: finite(match?.deathPhase), myDeathCount: typeof stats.deathType === 'string' ? (stats.deathType === 'alive' ? 0 : 1) : null });
  const negativeJudgment = /부족|미흡|저조|아쉽|아쉬|약점|한계|무너|형편없|느리|느린|개선이 필요|보완이 필요|개선의 여지|높여야|끌어올려야|채워야/u;
  const negatedJudgment = /(?:부족|아쉬)(?:함|움)?(?:이|은|도)?\s*없|부족하지\s*않|아쉽지\s*않|느리지\s*않/u;
  const metricBenchmarks: Array<[RegExp, keyof NormalizedBenchmark]> = [
    [/(?:대응|반응)\s*(?:사격)?\s*속도/u, 'avgFirstReplyLatency'],
    [/백업\s*속도/u, 'avgTradeLatency'], [/고립/u, 'avgIsolationIndex'],
    [/(?:피해량|딜량|화력)/u, 'avgDamage'], [/복수/u, 'avgTradeRate'],
  ];
  const clean = (value: string, key: string): string => {
    if (key === 'title' && /(?:복구|합류|지원)\s*(?:소요\s*)?시간\s*(?:단축|개선)/u.test(value)) return '아군 상태 확인';
    // Rewrite only matched sentences; untouched values keep their original line breaks.
    const sentences = value.split(/(?<=[.!?。！？])\s+|\n+/u);
    const rewritten: Array<string | null> = sentences.map(sentence => {
      if (['signatureSub', 'briefFeedback', 'finalVerdict'].includes(key) && earlyElimination === false && /조기\s*(?:탈락|사망)(?:했|하였|입니다|했습니다|으로|의|하여|해)/u.test(sentence)) {
        return `생존 시간은 ${stats.timeSurvived}초입니다. 조기 탈락 기준에 해당하지 않습니다.`;
      }
      // 측정하지 않은 능력(집중력)은 꾸밈말이면 빼고, 주장 자체면 문장을 뺀다.
      // 교전 결과로 집중력을 증명했다는 주장은 아래에서 실제 교전 수로 바꾼다.
      if (/집중력/u.test(sentence) && !/(?:높은|뛰어난|우수한|탁월한)\s*집중력(?:을|이)?\s*(?:보여|입증|증명)/u.test(sentence)
        && !/집중력[^.!?\n]{0,12}(?:의미하지\s*않|판단할\s*수\s*없|알\s*수\s*없|측정하지)/u.test(sentence)) {
        // 꾸밈말(…집중력으로/집중력 있는)만 지운다. 서술어를 이루는 표현은 문장째 뺀다.
        const stripped = sentence.replace(/(?:(?:멋진|뛰어난|높은|탁월한|놀라운|대단한|침착한)\s*)?집중력(?:을\s*바탕으로|으로|\s*있는|\s*있게)\s+/gu, '');
        return /집중력/u.test(stripped) ? null : stripped;
      }
      if (/무책임|무능|민폐|한심|성의\s*없|게으른|이기적/u.test(sentence)) {
        return key === 'signature' ? '경기 기록 점검' : null;
      }
      if (contributionFacts && /(?:아무런|어떠한|아무)\s*(?:유효(?:한)?\s*)?(?:자산|기여|성과|도움|것)|기여(?:를|도)?\s*(?:남기지|하지)\s*못|기여가\s*(?:없|전무)|(?:화력|교전\s*성과|기여|성과)(?:는|가|이|도)?\s*(?:전무|없)|무의미한|남긴\s*것이\s*없/u.test(sentence)) {
        return key === 'signature' ? '경기 기록 점검' : contributionFacts;
      }
      if (isolation !== null && isolation < 2 && /고립/u.test(sentence) && /결여|부족|위험|문제|미흡|불리|겹쳐|탓|약점/u.test(sentence)) {
        return `고립 지수 ${display(isolation)}로 아군과 가까운 대열을 유지했습니다.`;
      }
      if (/무리한\s*(?:진입|돌격|돌진)|성급한\s*진입/u.test(sentence)) {
        return key === 'desc' ? '다음 교전 전에는 엄폐물과 아군 위치를 먼저 확인해 보세요.' : null;
      }
      if (duels !== null && duels < 3 && /1\s*(?::|대)\s*1/u.test(sentence) && negativeJudgment.test(sentence) && !negatedJudgment.test(sentence)) {
        return key === 'desc' || key === 'title' ? null : `1:1 교전은 ${duels}회라 결정력을 평가하기에는 표본이 적습니다.`;
      }
      if (initiativeSamples !== null && initiativeSamples < 3 && /선제/u.test(sentence) && negativeJudgment.test(sentence) && !negatedJudgment.test(sentence)) {
        return key === 'desc' || key === 'title' ? null : `선제 시도는 ${initiativeSamples}회라 주도권을 평가하기에는 표본이 적습니다.`;
      }
      if (/(?:대응|반응)\s*(?:사격)?\s*속도/u.test(sentence) && negativeJudgment.test(sentence) && !negatedJudgment.test(sentence)
        && !hasComparableBenchmarkMetric(match?.eliteBenchmark, 'avgFirstReplyLatency')
        && !/3초\s*(?:안|내)/u.test(sentence)) {
        return firstReply === null ? null : `기습당한 교전에서 첫 반격까지 평균 ${(firstReply / 1000).toFixed(2)}초가 걸렸습니다. 비교 자료가 없어 빠르기 평가는 보류합니다.`;
      }
      if ((key === 'desc' || key === 'title') && lethal !== null && lethal > 0 && lethal < 3 && /투척/u.test(sentence) && /명중|적중|정밀|정확/u.test(sentence)) {
        return key === 'title' ? '투척 결과 확인' : `피해형 투척은 ${lethal}회라 명중률을 판단하기 어렵습니다. 다음 경기에서는 투척 후 피해가 들어갔는지 확인해 보세요.`;
      }
      if (['signatureSub', 'briefFeedback', 'finalVerdict'].includes(key) && /최전선|전방에서|선두에서|앞장서/u.test(sentence)) {
        return '관측 기록만으로 전방 위치나 교전 의도를 단정할 수 없습니다.';
      }
      if (finite(match?.tradeStats?.reactionLatencyMs) === COUNTER_LATENCY_PENALTY_MS && (finite(match?.duelStats?.reversalAttempts) ?? 0) > 0
        && /(?:대응|반응)\s*(?:사격)?\s*속도/u.test(sentence) && /3(?:\.0+)?\s*(?:초|s)/u.test(sentence)
        && !/미관측|관측되지|패널티|측정.{0,8}불가/u.test(sentence)) {
        return `기습당한 교전 ${finite(match?.duelStats?.reversalAttempts)}회에서 3초 안에 첫 반격을 하지 못했습니다.`;
      }
      if (!/(?:소생|부활)\s*(?:소요\s*)?시간/u.test(sentence) && /(?:복구|합류|지원|구출)[^.!?\n]{0,35}(?:소요되는\s*)?시간[^.!?\n]{0,30}(?:줄여|단축|개선|보완)/u.test(sentence)
        && !isNegatedCoachingDirectiveTail(sentence.slice(sentence.search(/줄여|단축|개선|보완/u) + 2))) {
        return '다음 교전에서는 아군의 상태를 확인하고 지원 가능한 상황인지 점검하세요.';
      }
      if (/선제[^.!?\n]{0,30}성공률/u.test(sentence) && /(?:첫|최초)[^.!?\n]{0,15}(?:명중률|정확도)/u.test(sentence)) {
        return '다음 교전에서는 선제 공격 이후 교전 결과를 확인해 보세요.';
      }
      if (/(?:대응|반응)\s*(?:사격)?\s*속도/u.test(sentence) && /상위\s*(?:권|수준|\d+\s*%)/u.test(sentence)) {
        return firstReply === null ? null
          : `기습당한 교전에서 첫 반격까지 평균 ${(firstReply / 1000).toFixed(2)}초가 걸렸습니다. 백분위는 확인할 수 없습니다.`;
      }
      // 비교 자료가 없는 지표의 상대 평가 문장만 뺀다. 같은 값의 다른 사실 문장은 남긴다.
      if (comparison.test(sentence)) {
        const referenced = metricBenchmarks.filter(([pattern]) => pattern.test(sentence));
        if (!referenced.length || referenced.some(([, metric]) => !hasComparableBenchmarkMetric(match?.eliteBenchmark, metric))) return null;
      }
      if (['signatureSub', 'briefFeedback', 'finalVerdict'].includes(key) && total !== null && total > 0 && total < 3 && (lethal === null || lethal < 3)
        && /유틸리티|투척/u.test(sentence) && negativeJudgment.test(sentence) && !negatedJudgment.test(sentence)) {
        const prefix = sentence.match(/^(.+?했)으나[,，]?\s/u)?.[1];
        return `${prefix ? `${prefix}습니다. ` : ''}투척은 총 ${total}회라 활용 능력을 평가하기에는 표본이 적습니다.`;
      }
      if (['signatureSub', 'briefFeedback', 'finalVerdict'].includes(key) && lethal !== null && lethal > 0 && lethal < 3
        && /유틸리티|투척/u.test(sentence) && /저조|무너|부족|형편없|아쉬|아쉽|보완이 필요|개선이 필요|개선의 여지|끌어올려야|높여야|채워야/u.test(sentence)
        && !/(?:부족|아쉬)(?:함|움)?(?:이|은|도)?\s*없|부족하지\s*않|아쉽지\s*않/u.test(sentence)) {
        const prefix = sentence.match(/^(.+?했)으나[,，]?\s/u)?.[1];
        return `${prefix ? `${prefix}습니다. ` : ''}피해형 투척은 ${lethal}회로 표본이 적어 전반적인 활용 능력 평가는 보류합니다.`;
      }
      return sentence;
    });
    if (rewritten.some((sentence, index) => sentence !== sentences[index])) {
      const kept = rewritten.filter((sentence): sentence is string => Boolean(sentence && sentence.trim()));
      // 모두 빠지면 필드를 비우지 않고 근거 있는 사실이나 보류 문장으로 채운다.
      value = kept.length ? [...new Set(kept)].join(' ')
        : key === 'signature' ? '경기 기록 점검'
          : key === 'title' ? '다음 경기 점검'
            : key === 'desc' ? ''
              : contributionFacts ?? '같은 조건의 비교 자료가 없어 상대 평가는 보류합니다.';
    }
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
    if (key === 'signature') value = value.replace(/(?:침착한|냉철한)\s*/gu, '').trim() || '경기 기록 점검';
    // 진입 위치·순서는 측정하지 않으므로 칭호에도 쓰지 않는다.
    if (key === 'signature' && /최전선|전방에서|선두에서|앞장서|돌격|선봉|돌진|전선|돌파|돌입|진입/u.test(value)) return '화력 기여형 플레이어';
    if (/숨어\s*다니|후방|아군\s*곁을\s*맴돌|몸을\s*사리/u.test(value)) {
      if (key === 'signature') return '화력 기여형 플레이어';
      return '관측 기록만으로 교전 의도나 대기 위치를 단정할 수 없습니다. 다음 교전에서는 아군과 함께 대응할 기회를 확인해 보세요.';
    }
    if (lethal === 0 && /유틸리티|투척/.test(value) && /보조.{0,15}(?:못|부족)|능력.{0,15}못/.test(value)) return throwFacts;
    if (/배지.{0,15}(?:없|전무)/.test(value) && /부족|실속|아쉬/.test(value)) return '배지 획득 여부만으로 경기 기여도를 평가하지 않습니다. 관측된 전투 기록을 함께 확인해 보세요.';
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
    if (Array.isArray(value)) {
      const items = value.map(item => visit(item, key));
      // 근거가 모두 빠진 행동 제안은 상투 문장으로 채우지 않고 항목째 뺀다.
      return key === 'actionItems' ? items.filter(item => !(item && typeof item === 'object' && (item as Record<string, unknown>).desc === '')) : items;
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, name)]));
    return value;
  };
  try { return JSON.stringify(visit(JSON.parse(text))); } catch { return clean(text, 'briefFeedback'); }
}
