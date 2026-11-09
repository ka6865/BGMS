import { formatSquadPunchlineBlock, selectSquadMemberPunchlines, selectSquadPunchlines } from "./squadPunchlines";
import { buildSquadObservationBlock } from "./squadMemberDistribution";
import {
  isSquadReviveRateEvaluable,
  isSquadTradeLatencyEvaluable,
  SQUAD_MIN_KNOCKS,
  SQUAD_MIN_TRADE_KILLS,
} from "./squadEvidenceSamples";

export interface SquadAiPromptInput {
  groupKey: string;
  stats: any;
  scores: any;
  roleProfiles: any[];
  nickname: string;
  coachingStyle?: string;
  squadGrade?: string | null;
  benchmarkStats?: any;
  matchCount?: number;
  teamMode?: "duo" | "squad";
  // 경기별 순위 요약. 우승·최고 순위 재료를 만드는 데만 쓴다.
  matchesSummary?: any[];
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
    // Missing analysis evidence must stay visibly unavailable.  A synthetic
    // B grade would look measured to the model and downstream consumers.
    squadGrade = null,
    benchmarkStats,
    matchCount = 1,
    teamMode = "squad",
    matchesSummary = [],
  } = input;
  const isMild = coachingStyle === "mild";
  const finiteNumber = (value: unknown): number | null => {
    if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const finiteNonNegative = (value: unknown): number | null => {
    const parsed = finiteNumber(value);
    return parsed === null || parsed < 0 ? null : parsed;
  };
  const formatObserved = (value: unknown, suffix = ""): string => {
    const parsed = finiteNonNegative(value);
    return parsed === null ? "측정 불가" : `${parsed}${suffix}`;
  };
  const formatPercent = (value: unknown): string => {
    const parsed = finiteNonNegative(value);
    return parsed === null || parsed > 100 ? "측정 불가" : `${parsed}%`;
  };
  const formatScore = (value: unknown): string => {
    const parsed = finiteNonNegative(value);
    return parsed === null || parsed > 100 ? "측정 불가" : String(parsed);
  };
  const formatAverageObserved = (total: unknown, count: unknown, suffix = ""): string => {
    const totalValue = finiteNonNegative(total);
    const countValue = finiteNonNegative(count);
    if (totalValue === null || countValue === null || countValue <= 0) return "측정 불가";
    return `${(totalValue / countValue).toFixed(2)}${suffix}`;
  };
  const isolationValue = finiteNonNegative(stats?.avgIsolation);
  const tradeLatencyValue = finiteNonNegative(stats?.avgTradeLatency);
  const benchmarkTradeLatencyValue = finiteNonNegative(benchmarkStats?.avgTradeLatency);
  // 표본이 기준보다 적은 백업 속도는 수치를 리포트에 넣지 않는다. 재료 선정과 같은 기준을 쓴다.
  const tradeEvaluable = isSquadTradeLatencyEvaluable(stats);
  const reviveEvaluable = isSquadReviveRateEvaluable(stats);
  const tradeKillCount = finiteNonNegative(stats?.totalTradeKills);
  const knockCount = finiteNonNegative(stats?.totalTeammateKnocks);
  const reviveCount = finiteNonNegative(stats?.totalRevives);
  const myTradeLatencySec = !tradeEvaluable
    ? `표본 부족으로 백업 속도는 평가하지 않음 (복수 ${tradeKillCount === null ? "측정 불가" : `${tradeKillCount}건`}, ${SQUAD_MIN_TRADE_KILLS}건 이상 필요)`
    : tradeLatencyValue !== null && tradeLatencyValue >= 0
      ? `${(tradeLatencyValue / 1000).toFixed(2)}초`
      : "측정 불가";
  const teamReviveRateText = reviveEvaluable && knockCount !== null && knockCount > 0 && reviveCount !== null
    ? `${Math.round((reviveCount / knockCount) * 1000) / 10}%`
    : "측정 불가";
  const benchmarkTradeLatencySec = benchmarkTradeLatencyValue !== null && benchmarkTradeLatencyValue >= 0
    ? `${(benchmarkTradeLatencyValue / 1000).toFixed(2)}초`
    : "측정 불가";
  const coverRateValue = finiteNonNegative(stats?.avgCoverRate);
  const coverRatePercent = coverRateValue === null || coverRateValue > 1
    ? "측정 불가"
    : `${Math.round(coverRateValue * 100)}%`;
  const displaySquadGrade = typeof squadGrade === "string" && squadGrade.trim()
    ? squadGrade.trim()
    : "등급 보류";
  const gradeOutput = displaySquadGrade === "등급 보류" ? "null" : JSON.stringify(displaySquadGrade);

  const membersReport = roleProfiles.map((p: any) => {
    return `- Nickname: ${typeof p?.name === "string" && p.name.trim() ? p.name : "측정 불가"}
  * Tactical Role: ${typeof p?.role === "string" && p.role.trim() ? p.role : "측정 불가"} (${typeof p?.roleDesc === "string" && p.roleDesc.trim() ? p.roleDesc : "측정 불가"})
  * Avg Match Stats: ${formatObserved(p?.avgDamage)} Damage / ${formatObserved(p?.avgKills)} Kills / ${formatObserved(p?.avgAssists)} Assists / ${formatObserved(p?.avgDbnos)} Knockouts
  * Team Contribution Shares: Damage ${formatPercent(p?.shares?.damage)}, Kills ${formatPercent(p?.shares?.kill)}, Assists ${formatPercent(p?.shares?.assist)}, Knockouts ${formatPercent(p?.shares?.dbno)}
      `.trim();
  }).join("\n\n");

  const benchmarkContext = benchmarkStats ? `
[Global Benchmark Context (${benchmarkStats.scope === "team_population" && Number.isFinite(benchmarkStats.sampleCount) ? `전체 ${teamMode === "duo" ? "듀오" : "스쿼드"} 팀 ${benchmarkStats.sampleCount}경기 평균. 티어 구분 없음` : `Tier: ${typeof benchmarkStats.tier === "string" && benchmarkStats.tier.trim() ? benchmarkStats.tier : "측정 불가"}`})]
- Global Avg Isolation Index (대열 이탈 고립도): ${formatObserved(benchmarkStats.avgIsolation)} (Our Squad Avg: ${formatObserved(isolationValue)})
${tradeEvaluable
  ? `- Global Avg Backup Speed (백업 반응 속도): ${benchmarkTradeLatencySec} (Our Squad Avg: ${myTradeLatencySec})`
  : "- Global Avg Backup Speed (백업 반응 속도): 표본 부족으로 비교하지 않음"}
${reviveEvaluable
  ? `- Global Avg Revive Success Rate (부활 성공률): ${formatPercent(benchmarkStats.avgReviveRate)} (Our Squad Revive Rate: ${teamReviveRateText}, 아군 기절 ${knockCount}회 중 ${reviveCount}회 부활)`
  : `- Global Avg Revive Success Rate (부활 성공률): 표본 부족으로 비교하지 않음 (아군 기절 ${knockCount === null ? "측정 불가" : `${knockCount}회`}, ${SQUAD_MIN_KNOCKS}회 이상 필요)`}
- Global Avg Smoke Rescue Rate (연막탄 구출 성공률): 팀 연막 구출률은 산출하지 않으므로 비교하지 않음 (연막 구출 횟수만 측정)
- Global Avg Squad Team Wipes (경기당 적 전멸 기여): ${formatObserved(benchmarkStats.avgTeamWipes, "회")} (Our Squad Avg: ${formatAverageObserved(stats?.totalTeamWipes, matchCount, "회")})

[Assigned Fixed Squad Grade]
- Given Grade: ${displaySquadGrade} (Output ${gradeOutput} in the "squadGrade" JSON field. Do NOT recalculate.)
` : `
[Assigned Fixed Squad Grade]
- Given Grade: ${displaySquadGrade} (Output ${gradeOutput} in the "squadGrade" JSON field. Do NOT recalculate.)
`;

  const squadReportSummary = `
[Squad Teammates]
- Team Mode: ${teamMode === "duo" ? "듀오(2인 팀). 팀원은 대상 플레이어 외 1명뿐이다" : "스쿼드(최대 4인 팀)"}
- Target Player: ${nickname}
- Teammates: ${groupKey}
- Matches Played Together (latest): ${matchesSummary.length > 0 ? matchesSummary.length : formatObserved(matchCount)}
- Matches Used For Stats: ${formatObserved(matchCount)}${matchesSummary.length > matchCount ? ` (the ${matchCount} of the latest ${matchesSummary.length} that have team observations; the rest lack telemetry detail)` : ""}

[Individual Member Role & Stats]
${membersReport}

[Squad Collaboration Performance Average]
- Average Isolation Index (대열 이탈 고립도): ${formatObserved(isolationValue)} (낮을수록 좋음. 1.0은 대열 유지 우수, 3.5 이상은 높은 고립 데스 위험)
- Backup Speed (아군 기절 후 백업 속도): ${myTradeLatencySec} (팀 전체에서 아군을 기절시킨 동일 적을 다른 아군이 30초 미만에 처치한 기록의 시간 합계 / 처치 수)
- Smoke Rescues (연막 구출 세이브 성공 수): ${formatObserved(stats?.totalSmokeRescues, "회")} (단순히 연막탄을 던진 횟수가 아니라, 기절 후 15초 안에 팀원이 100m 이내에서 연막을 투척하고 같은 아군 소생이 30초 안에 확인된 '연막 세이브' 횟수. 실제 연막 착탄/엄폐 효과/안전 여부는 측정하지 않음)
- Ally Revives (아군 부활 성공 수): ${formatObserved(stats?.totalRevives, "회")}
- Average Cover Rate (평균 아군 집중사격 커버율): ${coverRatePercent} (동시 교전 참여 지표)
- Enemy Squad Team Wipes (적 스쿼드 전멸 유발 수): ${formatObserved(stats?.totalTeamWipes, "회")}
${benchmarkContext}

[Synergy Balance Scores (Scale 0 - 100)]
- Revive Score (소생 점수, points out of 100, NOT a percent): ${formatScore(scores?.survivalCare)}
- Backup Trade Speed (백업 속도): ${tradeEvaluable ? formatScore(scores?.backupSpeed) : "표본 부족으로 평가하지 않음"}
- Smoke Rescue (연막 구출): ${formatScore(scores?.smokeRescue)}
- Damage Balance (딜 균형): ${formatScore(scores?.damageBalance)}
- Placement (순위 성과): ${formatScore(scores?.placement)}
(These are points converted from fixed targets, not percentages and not a ranking against other teams. Write a score as "N점", never as "N%". Cite the revive percentage only from the measured revive figures above.)
    `.trim();

  const hasLowIsolation = isolationValue !== null && isolationValue < 2.0;
  const observedDamageShares = roleProfiles
    .map((p: any) => finiteNonNegative(p?.shares?.damage))
    .filter((value): value is number => value !== null && value <= 100);
  const topDamageShare = observedDamageShares.length > 0 ? Math.max(...observedDamageShares) : null;
  const hasOneManDamageRisk = topDamageShare !== null && topDamageShare >= 50;
  const topDamageShareText = formatPercent(topDamageShare);
  const topDamageGuidance = topDamageShare === null
    ? "It is unavailable; do NOT infer firepower concentration or a one-player carry pattern."
    : hasOneManDamageRisk
      ? "You may discuss firepower concentration, but do not infer teammate intent or blame."
      : "It is below 50%, so do NOT call the squad a one-man show or say the team collapses without one player.";

  // 재료는 측정값과 표본 기준으로만 고른다. 측정이 없는 지표는 재료에서 빠진다.
  // 팀 지표는 최근 경기 중 상세 분석이 가능한(14일 보관 이내, 팀 관측 있음) 경기로 계산한다. 일부 경기가 빠졌을 때만 범위를 밝힌다. 우승·순위는 전체 경기라서 범위를 붙이지 않는다.
  const statsScopePrefix = matchCount > 0 && matchesSummary.length > matchCount ? `상세 분석 가능한 ${matchCount}경기 기준 ` : "";
  const SCOPE_FREE_METRICS = new Set(["wins", "bestRank", "squadGrade"]);
  const teamPunchlines = selectSquadPunchlines({ stats, scores, squadGrade, benchmarkStats, matchesSummary, roleProfiles })
    .map((item) => (statsScopePrefix && !SCOPE_FREE_METRICS.has(item.metric) ? { ...item, fact: `${statsScopePrefix}${item.fact}` } : item));
  const punchlineBlock = formatSquadPunchlineBlock(
    teamPunchlines,
    selectSquadMemberPunchlines({ roleProfiles }),
    { jabs: !isMild },
  );
  // 못한 점과 개인 피드백의 근거가 되는 측정 분포. 펀치라인 재료와 달리 농담용이 아니다.
  const observationBlock = buildSquadObservationBlock({
    roleProfiles,
    analyzedMatchCount: matchCount,
    totalMatchCount: matchesSummary.length,
  });

  const systemInstruction = isMild ? `
You are "KIND COACH", a warm, encouraging, and tactical PUBG coach.
Analyze the provided squad synergy report and write a report.
- Focus on positive collaboration indices first.
- Do not invent situational context or motives.
- For memberFeedbacks: include EVERY member listed in roleProfiles. Always write praise from one measured stat, as one natural Korean sentence that describes the member's recorded part (for example 딜 28%·킬 26%로 화력의 한 축을 맡았습니다) instead of reciting the numbers as a bare label list. Always output an empty string ("") for both fault and advice. The server writes a member's fault and advice from measured records, so anything you write there is discarded. Never turn a damage, kill, assist or knockout share, rank or team-lowest value, or any individual record, into blame or a cause anywhere in the report. Never write filler such as "keep it up" or "no data".
- Place each fact in the field it belongs to: positive facts in summary or strength, lopsided or low facts in weakness or coaching. Never put a positive fact in weakness, and do not repeat the same fact in several fields.
- For overallOpinion: Deliver a warm, encouraging, yet tactical message addressed to the entire team together, joining two facts into one sentence. Use a contrast (예: "~했지만 ~입니다") only when one fact is good and the other is a gap; when both facts point the same way, connect them with "~했고" or "~면서". Never paste two finished sentences together with 와/과, and never copy a sentence already written in summary or strength.
- Output MUST be structured in JSON matching the exact schema.
- Language: Output fields MUST be written in Korean.
- Preserve nicknames exactly as provided. Do NOT translate, localize, or Korean-transliterate nicknames such as "KangHeeSung_".
- Current Average Isolation Index is ${formatObserved(isolationValue)}. ${hasLowIsolation ? "It is below 2.0, so treat formation as good in summary, weakness, coaching, memberFeedbacks, and overallOpinion." : "If you mention spacing, use measured spacing facts only; if unavailable, say it is unavailable."} Do NOT say any member has "고립될 위험", "독단적인 플레이", "너무 멀리", "오합지졸", "1인 솔로 4개", or "혼자 정글북" for this squad.
- Current top damage share is ${topDamageShareText}. ${topDamageGuidance} Describe the observed damage share only. Do not replace blame with an unsupported "화력 분담 보완" judgment. Separate conditional practice advice from observed facts.
- Do NOT claim teammates are used as bait unless the data explicitly contains bait counts or bait death evidence.
- Forbidden phrases for this input shape: "고립될 위험", "독단적인 플레이", "너무 멀리", "오합지졸", "1인 솔로 4개", "혼자 정글북", "원맨쇼", "혼자 다 해먹", "미끼", "팀이 무너지는 구조", "나머지 팀원들의 화력 지원이 전무", "팀 전체가 휘청", "존재감이 희미", "강희성".
- PUNCHLINE FACTS are for praise and practice advice only. Do not tease, mock or exaggerate with them.
- CRITICAL: You MUST output ${gradeOutput} in the "squadGrade" property. Do NOT change or recalculate the grade yourself.
      `.trim() : `
You are "SPICY BOMBER", a brutal, fact-based, and highly sarcastic PUBG tactical analyst.
Analyze the provided squad synergy report and write a detailed roast and analysis.

[Rules for roasting & tone]:
1. NEVER use explicit vulgar swear words (e.g. "병신", "개새끼", "시발") directly, to prevent safety filters from blocking the response.
2. Maximize sarcasm with PUBG community terms, but tie every jab to a measured metric condition. Never mock a skill, ability, or intent that is not measured:
   - If a member's measured damage share is low (below 20%) while their kill or assist share is high, you may call them "킬로그 배달부" (Killfeed delivery) and cite only those measured shares.
   - You may tease a measured number itself (e.g. a damage share of X%) as a joke about the number, without adding any cause or motive.
   - "대열 이탈이 커서 합류 타이밍이 흔들림" (Roast only if isolation index is high, e.g. > 3.0)
3. Highlight metrics aggressively using clear, human-readable units (e.g. "X.X초", "X회", "X%"):
   - NEVER output raw millisecond values in the response. Always divide by 1000 and round to convert them to seconds like "23.0초" or "12.0초".
   - If trade latency is slow: "아군 기절하고 장례식 다 치른 뒤에야 늦장 백업 오실 겁니까? 평균 대비 너무 느립니다."
   - If isolation rate is high: Say "대열 이탈이 커서 동시 교전 합이 흔들립니다." Do NOT use "1인 솔로 4개", "오합지졸", or "혼자 정글북".
4. Deliver extremely sharp, critical, yet constructive, fact-based overall opinion and feedback.
5. For memberFeedbacks: include EVERY member listed in roleProfiles. Always write praise from one measured stat, as one natural Korean sentence that describes the member's recorded part (for example 딜 28%·킬 26%로 화력의 한 축을 맡았습니다) instead of reciting the numbers as a bare label list. Always output an empty string ("") for both fault and advice. The server writes a member's fault and advice from measured records, so anything you write there is discarded. Never turn a damage, kill, assist or knockout share, rank or team-lowest value, or any individual record, into blame or a cause anywhere in the report. Never write filler such as 'keep it up', 'no data' or a pass line in these fields. Each of praise, fault and advice must cite a different measured number or label. Use only their measured damage, kill, assist and knockout stats/shares. Differences in shares do not prove motives or unrecorded actions.
6. For overallOpinion: Deliver a sharp, critical, yet highly constructive message addressed to the entire team together.
7. Output MUST be structured in JSON matching the exact schema.
8. Language: Output fields MUST be written in Korean.
9. Preserve nicknames exactly as provided. Do NOT translate, localize, or Korean-transliterate nicknames such as "KangHeeSung_".
10. Current Average Isolation Index is ${formatObserved(isolationValue)}. ${hasLowIsolation ? "It is below 2.0, so treat formation as good in summary, weakness, coaching, memberFeedbacks, and overallOpinion." : "If you mention spacing, use measured spacing facts only; if unavailable, say it is unavailable."} Do NOT say any member has "고립될 위험", "독단적인 플레이", "너무 멀리", "오합지졸", "1인 솔로 4개", or "혼자 정글북" for this squad.
11. Current top damage share is ${topDamageShareText}. ${topDamageGuidance} Describe the observed damage share only. Do not replace blame with an unsupported "화력 분담 보완" judgment. Separate conditional practice advice from observed facts.
12. Do NOT claim teammates are used as bait unless the data explicitly contains bait counts or bait death evidence.
13. Forbidden phrases for this input shape: "고립될 위험", "독단적인 플레이", "너무 멀리", "오합지졸", "1인 솔로 4개", "혼자 정글북", "원맨쇼", "혼자 다 해먹", "미끼", "팀이 무너지는 구조", "나머지 팀원들의 뇌", "나머지 팀원들의 화력 지원이 전무", "팀 전체가 휘청", "존재감이 희미", "강희성".
14. CRITICAL: You MUST output ${gradeOutput} in the "squadGrade" property. Do NOT change or recalculate the grade yourself.
15. [PUNCHLINE FACTS] are the only material for jokes, exaggeration, metaphors and nicknames. Copy every number from the facts exactly. Do NOT round, convert, subtract, average, or derive any new number, even one that looks obvious (for example, a difference between two figures). Name each share with its exact label (딜 비중 = damage, 킬 비중 = kill, 어시스트 비중 = assist, 녹다운 비중 = knockouts) and never swap or rename them.
16. Give the report some bite. Use short, punchy sentences and PUBG community slang such as 킬로그, 캐리, 치킨. Use a slang word only where it fits the sentence; never use it as filler. Place each fact in the field it belongs to: positive (hype) facts in summary or strength; negative or lopsided facts (roast, or a team-level gap from [MEASURED OBSERVATIONS]) in weakness or coaching. Never put a positive fact in weakness, and never fill a field just to avoid leaving it empty. summary is one line about the record. overallOpinion is a short closing remark to the whole team that joins two facts into one natural sentence, not a bare fact. Use a contrast (예: "~했지만 ~입니다") only between a hype fact and a roast fact; when both point the same way, connect them with "~했고" or "~면서". Never paste two finished sentences together with 와/과, never copy a sentence already written in summary or strength, and do not repeat the same fact in several fields.
17. Style examples with placeholders (X, Y, N are measured values from the facts, never invented):
    - hype: a damage share of X% becomes "화력의 X%를 혼자 떠안은 캐리" (over-the-top praise of the number only).
    - roast: N matches with 0 wins becomes "N경기 동안 우승 0회, 트로피 진열장이 아직 비어 있습니다." (a sarcastic remark about the record only).
    Do NOT tease aim, brain, fingers, focus, judgment, mentality or any ability, and do NOT attribute intent or unrecorded actions.
    Use the term 킬로그 배달부 only for a member whose fact id is member_kill_log, because that fact is the only measured condition for it.
18. When a point has no measured fact or its metric is unavailable, output an empty string ("") for that field. The screen hides empty fields. Do NOT write a dry verdict such as "판단을 보류합니다", an in-character pass line, or any padding in weakness, coaching, fault or advice.
19. Each [PUNCHLINE FACTS] line may end with "→ 한마디:". Whenever you use such a fact in summary, strength, weakness, coaching, praise or overallOpinion, write it together with its 한마디 in the same sentence, keeping the 한마디 wording and its bite (you may shorten it, never soften it, and never replace it with a plain verdict). A field built from a fact that has a 한마디 must contain that 한마디. overallOpinion must carry a 한마디 that is not already used in another field; when every 한마디 is already used, write a short closing call to the team instead of repeating one. Never copy the label "→ 한마디:" itself. Pair a 한마디 only with its own fact and connect them in the same direction (a hype 한마디 after a hype fact, a roast 한마디 after a roast fact); never glue a hype 한마디 onto a fact you contrast with using 하지만. Member praise lines are written by the server, so keep praise to one short sentence.
      `.trim();

  const prompt = `
${squadReportSummary}

${punchlineBlock}

${observationBlock}

Based on the above performance data, write a tactical coaching report according to your designated persona.
Use measured statistics and available benchmarks to provide concrete, quantitative facts (e.g. "평균 대비 X초 빠름") in your feedback.
    `.trim();

  const evidenceRules = `
[Missing observation policy — overrides persona and grade instructions above]
- Do NOT evaluate, mock, or assign training tasks for abilities that are not measured in this report, such as 집중력, 판단력, 멘탈, 에임, 명중률, 반응속도. Only the measured metrics above may support a judgment.
- Unavailable metrics are NOT zero or poor play. Never praise, blame, compare, or infer performance from them.
- If cover rate or focus-fire score is unavailable, do not evaluate cover, covering teammates, simultaneous engagement, or focus-fire ability anywhere, including member feedback. There is no implemented cover collection yet; this does not mean a lack of cover opportunities.
- Zero smoke rescues counts successful recorded rescues, NOT smoke attempts, unused smoke, or a refusal to save. Do not say 연막을 아꼈다/국 끓인다 or blame recovery skill from a success count alone.
- Personal shares describe distribution only. Do not infer 소극적, 적극적, 후방 지원, 위치 선정, 연계 부족, 협공 능력, or intent from shares. If no personal weakness is measured, output an empty string ("") in fault. Output advice only when it follows from a measured fact; otherwise output an empty string ("").
- These are team-scope observations across the selected matches, not the target player alone. Individual isolation/wipe/cover values cannot replace missing team metrics.
- Only discuss measured metrics. If no supported weakness is evident, output an empty string for that field instead of inventing a fault.
${tradeEvaluable ? "" : `- Backup speed is NOT evaluable for this squad (fewer than ${SQUAD_MIN_TRADE_KILLS} measured trade kills). Do NOT state any backup speed value or backup timing, do NOT compare it with the global average, and do NOT praise, blame or advise on backup timing.`}
${reviveEvaluable ? "" : `- Revive rate is NOT evaluable for this squad (fewer than ${SQUAD_MIN_KNOCKS} measured knocks). Do NOT state any revive rate, and do NOT compare revive counts with the global revive rate.`}
- [MEASURED OBSERVATIONS] lists each member's recorded shares and individual records. Shares sum to 100% across the team, so someone is always the lowest, and they reflect role differences rather than mistakes. Use shares for praise only (a team-highest value or a role description) and for team-level spread lines, and never present a spread as a coordination, focus-fire or efficiency problem. Individual records are neutral facts: never use them as blame, never link them to a team result such as "화력이 발휘되지 못한다", and never explain why a member died or why a strike failed. Copy numbers exactly and never copy a bracket tag.
- [ANALYSIS SCOPE] Wins and placements cover every match played together (Matches Played Together). Every other number (shares, knocks, revives, smoke rescues, rates) covers only Matches Used For Stats, which may be fewer than the latest matches when older matches are past the 14-day detail window. When Matches Used For Stats is smaller than Matches Played Together, name that scope once in Korean (for example "상세 분석 가능한 8경기 기준") when you cite such a stat, and write 최근 N경기 only for wins and placements. Never put 상세 분석 가능한 N경기 in a sentence about wins or placements, and never combine the two scopes in one clause. When both counts are equal, no scope phrase is needed.
- Do not infer player intent, communication, safety, or actions from absent evidence.
- A team damage, kill or assist share spread describes distribution only. Never present it as a coordination, focus-fire or efficiency problem, and never tell the team to even it out.
- Squad isolation, backup and recovery metrics describe the entire team. roleProfiles contain NO individual backup, smoke or revive evidence, and the only individual position evidence is the searched player's own "개인 기록" distance line (how often the nearest standing teammate was far away at the moment of the knock or death), which is a neutral fact. Never blame an individual for a team metric, infer front/back positioning, or infer kill-stealing intent from kill/assist shares.
- ${teamMode === "duo" ? 'This is a DUO team of exactly two players. Call it 듀오, never 스쿼드 or 4인. Do not mention third or fourth members, and do not compare against squad-sized teams.' : 'This is a SQUAD team.'}
- ${gradeOutput === "null" ? 'Overall grade is withheld. Output JSON null for squadGrade. Do not assign a grade in any prose field.' : `Output exactly "${displaySquadGrade}" as squadGrade.`}
`;
  return { prompt, systemInstruction: `${systemInstruction}\n${evidenceRules}`, squadReportSummary };
}
