import { requiresRescueOpportunityEvidence } from './aiCoachingQuality';
import { isSquadWithheldCopy, squadMetricWithheldCopy, squadWithheldCopy } from './squadAiPolicy';
import { isSquadReviveRateEvaluable, isSquadTradeLatencyEvaluable } from './squadEvidenceSamples';
import { squadMemberFaultFeedback, type SquadMemberRecords } from './squadMemberRecords';
import { selectSquadMemberPunchlines, squadSpicyMemberPraise } from './squadPunchlines';

// Keep absent observations out of coaching, including results read from cache.
const metrics = [
  { key: "avgIsolation", label: "대열 유지", pattern: /고립|대열|이탈|isolation/i },
  { key: "avgTradeLatency", label: "백업 속도", pattern: /백업|트레이드|복수.*(?:속도|시간)|trade.?latency|backup/i },
  { key: "totalSmokeRescues", label: "연막 구출", pattern: /연막|smoke/i },
  { key: "totalRevives", label: "아군 소생", pattern: /소생|부활|revive/i },
  { key: "avgCoverRate", label: "엄호·집중사격", pattern: /엄호|커버|집중\s*(?:사격|화력)|동시\s*교전|화력\s*(?:집중|지원)|(?:지원|협동|교차)\s*사격|사격\s*지원|크로스\s*파이어|cover|focus.?fire|crossfire|supporting.?fire/i },
  { key: "totalTeamWipes", label: "전멸 기여", pattern: /전멸|team.?wipe/i },
] as const;

function isObserved(stats: Record<string, unknown>, key: string): boolean {
  const value = stats[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && (key !== "avgCoverRate" || value <= 1);
}

export function hasSquadObservations(stats: Record<string, unknown>): boolean {
  return metrics.some(({ key }) => isObserved(stats, key));
}

export interface SquadEvidencePolicyOptions {
  // "spicy"만 넘김 문장으로 바꾼다. 그 밖의 값은 기존 보류 문구를 쓴다.
  coachingStyle?: string;
  // 전체 팀 평균 소생률을 문장 속 퍼센트와 대조할 때 쓴다. 없으면 우리 팀 소생률만 인정한다.
  benchmarkStats?: Record<string, unknown> | null;
}

// 생존 케어 점수가 없을 때 막는 말: 능력 평가와 근거 없는 구조 비율. 측정된 소생률 문장은 아래에서 따로 살린다.
const RESCUE_ABILITY_PATTERN = /생존\s*케어|(?:소생|부활|연막|구출|복구).{0,20}(?:능력|우수|부족|잘하|못하|훌륭|평균\s*대비)/i;
const RESCUE_RATE_PATTERN = /(?:소생|부활|연막|구출|복구).{0,20}(?:성공률|확률|비율|률|퍼센트|%)/i;

function oneDecimal(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/** 문장 속 퍼센트가 모두 측정된 소생률(우리 팀·전체 팀 평균)과 같으면 true다. 소생 표본이 기준 미만이면 항상 false다. */
function citesOnlyMeasuredReviveRate(sentence: string, stats: Record<string, unknown>, benchmarkStats: Record<string, unknown> | null | undefined): boolean {
  if (!isSquadReviveRateEvaluable(stats)) return false;
  const knocks = Number(stats.totalTeammateKnocks);
  const revives = Number(stats.totalRevives);
  const allowed = new Set<string>();
  if (Number.isFinite(knocks) && knocks > 0 && Number.isFinite(revives)) allowed.add(oneDecimal((revives / knocks) * 100));
  const benchmark = Number(benchmarkStats?.avgReviveRate);
  if (benchmarkStats?.avgReviveRate !== null && benchmarkStats?.avgReviveRate !== undefined && Number.isFinite(benchmark)) allowed.add(oneDecimal(benchmark));
  const percents = Array.from(sentence.matchAll(/(\d+(?:\.\d+)?)\s*%/g), (match) => oneDecimal(Number.parseFloat(match[1])));
  return percents.length > 0 && percents.every((percent) => allowed.has(percent));
}

/** 모델 원본과 정책 적용 결과를 비교해 바뀐 칸 이름만 돌려준다. 문장 내용은 담지 않아 로그에 남겨도 된다. */
export function listReplacedSquadFields(raw: unknown, processed: unknown): string[] {
  const before = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const after = (processed && typeof processed === "object" ? processed : {}) as Record<string, any>;
  const changed: string[] = [];
  for (const field of ["summary", "strength", "weakness", "coaching", "overallOpinion"]) {
    if (typeof before[field] === "string" && before[field] !== after[field]) changed.push(field);
  }
  if (Array.isArray(before.memberFeedbacks)) {
    before.memberFeedbacks.forEach((member: any, index: number) => {
      for (const field of ["praise", "fault", "advice"]) {
        if (typeof member?.[field] === "string" && member[field] !== after.memberFeedbacks?.[index]?.[field]) changed.push(`memberFeedbacks[${index}].${field}`);
      }
    });
  }
  return changed;
}

export function applySquadEvidencePolicy<T>(result: T, stats: Record<string, unknown>, grade: string | null, scores?: Record<string, unknown>, roleProfiles: Array<{ name: string; shares?: Record<string, number | null>; totalKills?: number | null; records?: SquadMemberRecords | null }> = [], options: SquadEvidencePolicyOptions = {}): T {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid squad coaching result");
  const coachingStyle = options.coachingStyle;
  // 백업 속도는 복수 표본이 기준 미만이면 관측되지 않은 것으로 보고, 해당 문장을 보류한다.
  const tradeLatencyEvaluable = isSquadTradeLatencyEvaluable(stats);
  const missing = metrics.filter(({ key }) => !isObserved(stats, key)
    || (key === "avgTradeLatency" && !tradeLatencyEvaluable)
    || (key === "avgCoverRate" && scores !== undefined && !isObserved(scores, "focusFire")));
  const clean = (text: unknown): unknown => {
    if (typeof text !== "string") return text;
    // Split at sentence ends, not decimal points (e.g. 5.36 seconds).
    const sentences = text.split(/(?<=[.!?。])\s+|\n+/);
    return [...new Set(sentences.map((sentence) => {
      // 이미 보류 문구인 문장은 다시 판정하지 않아 캐시를 여러 번 읽어도 결과가 같다.
      if (isSquadWithheldCopy(sentence)) return sentence;
      if (requiresRescueOpportunityEvidence(sentence)
        && (!isObserved(stats, "totalTeammateKnocks") || stats.totalTeammateKnocks === 0 || !isObserved(stats, "totalSmokeRescues"))) {
        return stats.totalTeammateKnocks === 0
          ? squadWithheldCopy(coachingStyle, "rescueNoOpportunity")
          : squadWithheldCopy(coachingStyle, "rescueLow");
      }
      if (/연막.{0,35}(?:아껴|아꼈|안\s*쓰|쓰지\s*않|국\s*끓)/.test(sentence)) return "연막 구출 성공 횟수만으로 연막 사용 여부나 구출 의도를 판단할 수 없습니다.";
      const unavailable = missing.find(({ pattern }) => pattern.test(sentence));
      if (unavailable) return squadMetricWithheldCopy(coachingStyle, unavailable.label);
      // Observed counts remain useful even when the knock denominator/score
      // is missing. Withhold rates and ability judgments, not the real totals.
      // 소생 점수가 있으면 능력 표현과 점수(N점) 문장은 허용한다. 퍼센트는 점수와 헷갈리기 쉬워 항상 측정된 소생률과 대조한다.
      const reviveScoreObserved = scores !== undefined && isObserved(scores, "survivalCare");
      if (scores !== undefined
        && ((!reviveScoreObserved && RESCUE_ABILITY_PATTERN.test(sentence))
          || (RESCUE_RATE_PATTERN.test(sentence) && (!reviveScoreObserved || /%/.test(sentence))
            && !citesOnlyMeasuredReviveRate(sentence, stats, options.benchmarkStats)))) {
        return squadMetricWithheldCopy(coachingStyle, "생존 케어");
      }
      if (!grade && /(?:종합|스쿼드|협동|전체|시너지)\s*(?:등급|평가|점수)|총점|[SABCD][+-]?\s*(?:등급|Grade|급)|\b[SABCD][+-]?(?:입니다|라고\s*평가)/i.test(sentence)) {
        return squadWithheldCopy(coachingStyle, "grade");
      }
      return sentence;
    }))].join(" ");
  };
  const data = result as Record<string, unknown>;
  const output: Record<string, unknown> = { ...data, squadGrade: grade };
  for (const field of ["summary", "strength", "weakness", "coaching", "overallOpinion"]) {
    output[field] = clean(data[field]);
  }
  if (Array.isArray(data.memberFeedbacks)) {
    const cleanMember = (text: unknown) => {
      if (typeof text !== "string") return text;
      // Apply metric cleanup before the member guard, so generated withholding
      // copy cannot change classification on the next cache read.
      const cleaned = clean(text);
      if (typeof cleaned !== "string") return cleaned;
      if (/고립|대열|이탈|백업|엄호|커버|연막|소생|부활|후방|위치\s*선정|소극|적극|몸\s*사리|숨어|(?:연계|협공|시너지).{0,20}(?:부족|아쉬|떨어)|혼자\s*앞서|킬을?\s*주워/.test(cleaned)) {
        return squadWithheldCopy(coachingStyle, "member", cleaned);
      }
      return cleaned;
    };
    // 개인 기록을 가진 roleProfiles면 못한 점과 조언은 모델 문장 대신 서버가 고정 기준으로 쓴 문장으로 확정한다.
    // 모델이 없는 기준을 만들거나 비꼬는 말투를 지우는 일을 막고, 후보가 없는 팀원은 빈 칸으로 둔다.
    const recordsAware = roleProfiles.length > 0 && roleProfiles.every(profile => profile.records !== undefined);
    const fixedFeedback = recordsAware ? squadMemberFaultFeedback(roleProfiles, coachingStyle === "spicy" ? "spicy" : "mild") : null;
    // 매운맛 칭찬도 같은 이유로 서버가 쓴다. 모델이 한마디를 빼면 네 명 모두 똑같은 평범한 칭찬이 된다.
    const spicyPraise = coachingStyle === "spicy"
      ? new Map(selectSquadMemberPunchlines({ roleProfiles }).flatMap(punchline => {
        const praise = squadSpicyMemberPraise(punchline);
        return praise ? [[punchline.name, praise] as const] : [];
      }))
      : null;
    output.memberFeedbacks = data.memberFeedbacks.map((member) => {
      const profile = roleProfiles.find(profile => profile.name.toLowerCase() === String(member.name).toLowerCase());
      const checkShare = (value: unknown) => {
        const cleaned = cleanMember(value);
        if (typeof cleaned !== "string" || !profile) return cleaned;
        const keys: Record<string, string> = { 킬: "kill", 기절: "dbno", 녹다운: "dbno", 어시스트: "assist", 딜량: "damage", 데미지: "damage", 대미지: "damage", 피해량: "damage" };
        const reconcile = (whole: string, metric: string, count: string) => {
          const actual = profile.shares?.[keys[metric]];
          if (typeof actual !== "number" || !Number.isFinite(actual)) return `${metric} 비중 측정 불가`;
          return Number(count) === actual ? whole : `${metric} 비중 ${actual}%`;
        };
        return cleaned
          .replace(/(\d+(?:\.\d+)?)%\s*(?:의\s*)?(?:높은\s*)?(킬|기절|녹다운|어시스트|딜량|데미지|대미지|피해량)\s*(?:지분|비중|기여도)/g, (whole, count, metric) => reconcile(whole, metric, count))
          .replace(/(킬|기절|녹다운|어시스트|딜량|데미지|대미지|피해량)\s*(?:지분|비중|기여도)\s*(\d+(?:\.\d+)?)%/g, reconcile);
      };
      const fixed = profile ? fixedFeedback?.get(profile.name) : undefined;
      const praise = profile && spicyPraise?.get(profile.name) ? spicyPraise.get(profile.name) : checkShare(member.praise);
      if (fixed) return { ...member, praise, fault: fixed.fault, advice: fixed.advice };
      return { ...member, praise, fault: checkShare(member.fault), advice: checkShare(member.advice) };
    });
  }
  return output as T;
}
