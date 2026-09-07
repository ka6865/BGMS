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

export function applySquadEvidencePolicy<T>(result: T, stats: Record<string, unknown>, grade: string | null, scores?: Record<string, unknown>): T {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid squad coaching result");
  const missing = metrics.filter(({ key }) => !isObserved(stats, key)
    || (key === "avgCoverRate" && scores !== undefined && !isObserved(scores, "focusFire")));
  const clean = (text: unknown): unknown => {
    if (typeof text !== "string") return text;
    // Split at sentence ends, not decimal points (e.g. 5.36 seconds).
    const sentences = text.split(/(?<=[.!?。])\s+|\n+/);
    return [...new Set(sentences.map((sentence) => {
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
    output.memberFeedbacks = data.memberFeedbacks.map((member) => ({
      ...member, praise: clean(member.praise), fault: clean(member.fault), advice: clean(member.advice),
    }));
  }
  return output as T;
}
