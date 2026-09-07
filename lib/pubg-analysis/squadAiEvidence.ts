import { requiresRescueOpportunityEvidence } from './aiCoachingQuality';

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

export function applySquadEvidencePolicy<T>(result: T, stats: Record<string, unknown>, grade: string | null, scores?: Record<string, unknown>, roleProfiles: Array<{ name: string; shares?: Record<string, number | null> }> = []): T {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid squad coaching result");
  const missing = metrics.filter(({ key }) => !isObserved(stats, key)
    || (key === "avgCoverRate" && scores !== undefined && !isObserved(scores, "focusFire")));
  const clean = (text: unknown): unknown => {
    if (typeof text !== "string") return text;
    // Split at sentence ends, not decimal points (e.g. 5.36 seconds).
    const sentences = text.split(/(?<=[.!?。])\s+|\n+/);
    return [...new Set(sentences.map((sentence) => {
      if (requiresRescueOpportunityEvidence(sentence)
        && (!isObserved(stats, "totalTeammateKnocks") || stats.totalTeammateKnocks === 0 || !isObserved(stats, "totalSmokeRescues"))) {
        return stats.totalTeammateKnocks === 0
          ? "연막 구출 기회가 관측되지 않아 해당 평가는 보류합니다."
          : "연막 구출 기록이 부족해 해당 평가는 보류합니다.";
      }
      if (/연막.{0,35}(?:아껴|아꼈|안\s*쓰|쓰지\s*않|국\s*끓)/.test(sentence)) return "연막 구출 성공 횟수만으로 연막 사용 여부나 구출 의도를 판단할 수 없습니다.";
      const unavailable = missing.find(({ pattern }) => pattern.test(sentence));
      if (unavailable) return `${unavailable.label} 평가는 근거가 부족해 보류합니다.`;
      // Observed counts remain useful even when the knock denominator/score
      // is missing. Withhold rates and ability judgments, not the real totals.
      if (scores !== undefined && !isObserved(scores, "survivalCare")
        && /생존\s*케어|(?:소생|부활|연막|구출|복구).{0,20}(?:성공률|확률|비율|률|퍼센트|%|능력|우수|부족|잘하|못하|훌륭|평균\s*대비)/i.test(sentence)) {
        return "생존 케어 평가는 근거가 부족해 보류합니다.";
      }
      if (!grade && /(?:종합|스쿼드|협동|전체|시너지)\s*(?:등급|평가|점수)|총점|[SABCD][+-]?\s*(?:등급|Grade|급)|\b[SABCD][+-]?(?:입니다|라고\s*평가)/i.test(sentence)) {
        return "미측정 지표가 있어 종합 등급은 보류합니다.";
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
      if (/고립|대열|이탈|백업|엄호|커버|연막|소생|부활|후방|위치\s*선정|소극|적극|몸\s*사리|숨어|(?:연계|협공|시너지).{0,20}(?:부족|아쉬|떨어)|혼자\s*앞서|킬을?\s*주워/.test(text)) {
        return "개인 행동을 단정할 근거가 부족해 해당 평가는 보류합니다.";
      }
      return clean(text);
    };
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
      return { ...member, praise: checkShare(member.praise), fault: checkShare(member.fault), advice: checkShare(member.advice) };
    });
  }
  return output as T;
}
