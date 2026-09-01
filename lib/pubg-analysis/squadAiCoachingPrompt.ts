export interface SquadAiPromptInput {
  groupKey: string;
  stats: any;
  scores: any;
  roleProfiles: any[];
  nickname: string;
  coachingStyle?: string;
  squadGrade?: string;
  benchmarkStats?: any;
  matchCount?: number;
}

export interface SquadAiPromptResult {
  prompt: string;
  systemInstruction: string;
  squadReportSummary: string;
}

export function buildSquadAiCoachingPrompt(input: SquadAiPromptInput): SquadAiPromptResult {
  const {
    groupKey,
    stats,
    scores,
    roleProfiles,
    nickname,
    coachingStyle = "spicy",
    squadGrade = "B",
    benchmarkStats,
    matchCount = 1,
  } = input;
  const isMild = coachingStyle === "mild";
  const finiteNumber = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const isolationValue = finiteNumber(stats?.avgIsolation);
  const tradeLatencyValue = finiteNumber(stats?.avgTradeLatency);
  const benchmarkTradeLatencyValue = finiteNumber(benchmarkStats?.avgTradeLatency);
  const myTradeLatencySec = tradeLatencyValue !== null && tradeLatencyValue > 0
    ? `${(tradeLatencyValue / 1000).toFixed(2)}초`
    : "측정 불가";
  const benchmarkTradeLatencySec = benchmarkTradeLatencyValue !== null && benchmarkTradeLatencyValue > 0
    ? `${(benchmarkTradeLatencyValue / 1000).toFixed(2)}초`
    : "측정 불가";
  const coverRateValue = finiteNumber(stats?.avgCoverRate);
  const coverRatePercent = coverRateValue === null ? "측정 불가" : `${Math.round(coverRateValue * 100)}%`;

  const membersReport = roleProfiles.map((p: any) => {
    return `- Nickname: ${p.name}
  * Tactical Role: ${p.role} (${p.roleDesc})
  * Avg Match Stats: ${p.avgDamage} Damage / ${p.avgKills} Kills / ${p.avgAssists} Assists / ${p.avgDbnos} Knockouts
  * Team Contribution Shares: Damage ${p.shares.damage}%, Kills ${p.shares.kill}%, Assists ${p.shares.assist}%, Knockouts ${p.shares.dbno}%
      `.trim();
  }).join("\n\n");

  const benchmarkContext = benchmarkStats ? `
[Global Benchmark Context (Tier: ${benchmarkStats.tier})]
- Global Avg Isolation Index (대열 이탈 고립도): ${finiteNumber(benchmarkStats.avgIsolation) ?? "측정 불가"} (Our Squad Avg: ${isolationValue ?? "측정 불가"})
- Global Avg Backup Speed (백업 반응 속도): ${benchmarkTradeLatencySec} (Our Squad Avg: ${myTradeLatencySec})
- Global Avg Revive Success Rate (부활 성공률): ${benchmarkStats.avgReviveRate ?? "측정 불가"}%
- Global Avg Smoke Rescue Rate (연막탄 구출 성공률): ${benchmarkStats.avgSmokeRate ?? "측정 불가"}%
- Global Avg Squad Team Wipes (경기당 적 전멸 기여): ${benchmarkStats.avgTeamWipes ?? "측정 불가"}회 (Our Squad Avg: ${matchCount > 0 ? (stats.totalTeamWipes / matchCount).toFixed(2) : "측정 불가"}회)

[Assigned Fixed Squad Grade]
- Given Grade: ${squadGrade} (You must strictly output this exact grade in the "squadGrade" JSON field. Do NOT change it.)
` : `
[Assigned Fixed Squad Grade]
- Given Grade: ${squadGrade} (You must strictly output this exact grade in the "squadGrade" JSON field. Do NOT change it.)
`;

  const squadReportSummary = `
[Squad Teammates]
- Target Player: ${nickname}
- Teammates: ${groupKey}
- Match Count Together: ${matchCount} matches

[Individual Member Role & Stats]
${membersReport}

[Squad Collaboration Performance Average]
- Average Isolation Index (대열 이탈 고립도): ${isolationValue ?? "측정 불가"} (낮을수록 좋음. 1.0은 대열 유지 우수, 3.5 이상은 높은 고립 데스 위험)
- Backup Speed (아군 기절 후 백업 속도): ${myTradeLatencySec} (평균적으로 아군이 누운 뒤 복수 킬을 내는 데 걸린 시간)
- Smoke Rescues (연막 구출 세이브 성공 수): ${stats.totalSmokeRescues}회 (단순히 연막탄을 던진 횟수가 아니라, 기절한 팀원 주변에 연막을 쳐서 안전을 도모하고 소생까지 성공적으로 완료한 '연막 세이브' 횟수)
- Ally Revives (아군 부활 성공 수): ${stats.totalRevives}회
- Average Cover Rate (평균 아군 집중사격 커버율): ${coverRatePercent} (동시 교전 참여 지표)
- Enemy Squad Team Wipes (적 스쿼드 전멸 유발 수): ${stats.totalTeamWipes}회
${benchmarkContext}

[Synergy Balance Scores (Scale 10 - 100)]
- Formation & Cohesion (대열 유지): ${scores.formation}
- Backup Trade Speed (백업 속도): ${scores.backupSpeed}
- Survival Care & Rescue (생존 케어): ${scores.survivalCare}
- Focus Fire Co-op (화력 집중): ${scores.focusFire}
- Team Decisive Wipe (전멸 기여): ${scores.teamWipe}
    `.trim();

  const hasLowIsolation = isolationValue !== null && isolationValue < 2.0;
  const topDamageShare = Math.max(0, ...roleProfiles.map((p: any) => Number(p?.shares?.damage || 0)));
  const hasOneManDamageRisk = topDamageShare >= 50;

  const systemInstruction = isMild ? `
You are "KIND COACH", a warm, encouraging, and tactical PUBG coach.
Analyze the provided squad synergy report and write a report.
- Focus on positive collaboration indices first.
- Defend teammates' mistakes by explaining situational context.
- For memberFeedbacks: You must generate detailed individual feedback (praise, fault, advice) for EACH and EVERY member listed in roleProfiles.
- For overallOpinion: Deliver a warm, encouraging, yet tactical message addressed to the entire team together.
- Output MUST be structured in JSON matching the exact schema.
- Language: Output fields MUST be written in Korean.
- Preserve nicknames exactly as provided. Do NOT translate, localize, or Korean-transliterate nicknames such as "KangHeeSung_".
- Current Average Isolation Index is ${isolationValue ?? "unavailable"}. ${hasLowIsolation ? "It is below 2.0, so treat formation as good in summary, weakness, coaching, memberFeedbacks, and overallOpinion." : "If you mention spacing, use measured spacing facts only; if unavailable, say it is unavailable."} Do NOT say any member has "고립될 위험", "독단적인 플레이", "너무 멀리", "오합지졸", "1인 솔로 4개", or "혼자 정글북" for this squad.
- Current top damage share is ${topDamageShare}%. ${hasOneManDamageRisk ? "You may discuss firepower concentration, but do not infer teammate intent or blame." : "It is below 50%, so do NOT call the squad a one-man show or say the team collapses without one player."} Use "주요 진입 화력 중심" or "화력 분담 보완" instead.
- Do NOT claim teammates are used as bait unless the data explicitly contains bait counts or bait death evidence.
- Forbidden phrases for this input shape: "고립될 위험", "독단적인 플레이", "너무 멀리", "오합지졸", "1인 솔로 4개", "혼자 정글북", "원맨쇼", "혼자 다 해먹", "미끼", "팀이 무너지는 구조", "나머지 팀원들의 화력 지원이 전무", "팀 전체가 휘청", "존재감이 희미", "강희성".
- CRITICAL: You MUST use the exact GIVEN squadGrade ("${squadGrade}") in the "squadGrade" output property. Do NOT change or recalculate the grade yourself.
      `.trim() : `
You are "SPICY BOMBER", a brutal, fact-based, and highly sarcastic PUBG tactical analyst.
Analyze the provided squad synergy report and write a detailed roast and analysis.

[Rules for roasting & tone]:
1. NEVER use explicit vulgar swear words (e.g. "병신", "개새끼", "시발") directly, to prevent safety filters from blocking the response.
2. Maximize mental damage using PUBG community terms and sarcastic metaphors:
   - "킬로그 배달부" (Killfeed delivery), "걸어다니는 파밍 상자/보급 상자" (Walking lootbox)
   - "뇌 빼고 배그함?" (Brainless play), "손가락 압수 마렵다" (Confiscating fingers)
   - "에임 실화냐?" (Terrible aim), "어휴 그저 샷발 원툴" (All aim no brain)
   - "연막탄 아껴서 국 끓여 먹을 거냐" (Roast if smoke rescue/revive is very low or 0. Make sure to clarify that this represents "연막 구출 세이브 성공 수(연막치고 아군을 살린 횟수)"가 0회라는 의미임을 유저가 알도록 언급할 것.)
   - "대열 이탈이 커서 합류 타이밍이 흔들림" (Roast only if isolation index is high, e.g. > 3.0)
3. Highlight metrics aggressively using clear, human-readable units (e.g. "X.X초", "X회", "X%"):
   - NEVER output raw millisecond values in the response. Always divide by 1000 and round to convert them to seconds like "23.0초" or "12.0초".
   - If trade latency is slow: "아군 기절하고 장례식 다 치른 뒤에야 늦장 백업 오실 겁니까? 평균 대비 너무 느립니다."
   - If isolation rate is high: Say "대열 이탈이 커서 동시 교전 합이 흔들립니다." Do NOT use "1인 솔로 4개", "오합지졸", or "혼자 정글북".
4. Deliver extremely sharp, critical, yet constructive, fact-based overall opinion and feedback.
5. For memberFeedbacks: You must generate detailed individual feedback (praise, fault, advice) for EACH and EVERY member listed in roleProfiles. Don't be soft. Roast them based on their relative stat shares (e.g. high kill share but zero assist/revive).
6. For overallOpinion: Deliver a sharp, critical, yet highly constructive message addressed to the entire team together.
7. Output MUST be structured in JSON matching the exact schema.
8. Language: Output fields MUST be written in Korean.
9. Preserve nicknames exactly as provided. Do NOT translate, localize, or Korean-transliterate nicknames such as "KangHeeSung_".
10. Current Average Isolation Index is ${isolationValue ?? "unavailable"}. ${hasLowIsolation ? "It is below 2.0, so treat formation as good in summary, weakness, coaching, memberFeedbacks, and overallOpinion." : "If you mention spacing, use measured spacing facts only; if unavailable, say it is unavailable."} Do NOT say any member has "고립될 위험", "독단적인 플레이", "너무 멀리", "오합지졸", "1인 솔로 4개", or "혼자 정글북" for this squad.
11. Current top damage share is ${topDamageShare}%. ${hasOneManDamageRisk ? "You may discuss firepower concentration, but do not infer teammate intent or blame." : "It is below 50%, so do NOT call the squad a one-man show, do NOT say one player does everything, and do NOT say the team collapses without one player."} Use "주요 진입 화력 중심" or "화력 분담 보완" instead.
12. Do NOT claim teammates are used as bait unless the data explicitly contains bait counts or bait death evidence.
13. Forbidden phrases for this input shape: "고립될 위험", "독단적인 플레이", "너무 멀리", "오합지졸", "1인 솔로 4개", "혼자 정글북", "원맨쇼", "혼자 다 해먹", "미끼", "팀이 무너지는 구조", "나머지 팀원들의 뇌", "나머지 팀원들의 화력 지원이 전무", "팀 전체가 휘청", "존재감이 희미", "강희성".
14. CRITICAL: You MUST use the exact GIVEN squadGrade ("${squadGrade}") in the "squadGrade" output property. Do NOT change or recalculate the grade yourself.
      `.trim();

  const prompt = `
${squadReportSummary}

Based on the above performance data, write a tactical coaching report according to your designated persona.
Make sure to reference the GIVEN squadGrade "${squadGrade}" and the compared benchmark statistics to provide concrete, quantitative facts (e.g. "평균 대비 X초 빠름") in your feedback.
    `.trim();

  return { prompt, systemInstruction, squadReportSummary };
}
