import { isEarlyElimination } from "@/lib/pubg-analysis/benchmarkScore";
import { buildBackupCoachingContext, type BackupCoachingContext } from "@/lib/pubg-analysis/backupCoaching";
import { hasComparableBenchmarkMetric, type NormalizedBenchmark, type ObservedBenchmark } from "@/lib/pubg-analysis/benchmarkAdapter";
import { firstReplyLatencyMs } from "@/lib/pubg-analysis/firstReply";
import { COUNTER_LATENCY_PENALTY_MS } from "@/lib/pubg-analysis/constants";

interface MatchAiPromptInput {
  matchData: any;
  coachingStyle?: string;
}

export interface MatchAiPromptResult {
  fullPrompt: string;
  playerReportSummary: string;
  backupContext: BackupCoachingContext;
}

export function buildMatchAiCoachingPrompt({ matchData, coachingStyle = "spicy" }: MatchAiPromptInput): MatchAiPromptResult {
  const isMild = coachingStyle === "mild";
  const {
    stats,
    mapName,
    gameMode,
    eliteBenchmark = null,
    killContribution = { solo: 0, cleanup: 0, other: 0 },
    tradeStats = {},
    combatPressure = {},
    isolationData = null,
    teamImpact = { damageImpact: null, killImpact: null, teamDamageShare: null, teamKillShare: null } as any,
    badges = [],
  } = matchData;
  const observedEliteBenchmark: ObservedBenchmark | null = eliteBenchmark
    && typeof eliteBenchmark === "object"
    && !Array.isArray(eliteBenchmark)
    && Number.isFinite(Number(eliteBenchmark.sampleCount))
    && Number(eliteBenchmark.sampleCount) >= 5
    ? eliteBenchmark
    : null;
  const benchmarkMetric = (key: keyof NormalizedBenchmark): number | null => (
    hasComparableBenchmarkMetric(observedEliteBenchmark, key)
      ? Number((observedEliteBenchmark as Record<string, unknown>)[key])
      : null
  );
  const formatPercent = (value: unknown): string => {
    return typeof value === "number" && Number.isFinite(value)
      ? `${value}%`
      : "측정 불가";
  };
  const finiteNonNegative = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  };
  const formatNumber = (value: unknown, suffix = ""): string => {
    const numeric = finiteNonNegative(value);
    return numeric === null ? "측정 불가" : `${numeric}${suffix}`;
  };
  const boundedRate = (numerator: unknown, denominator: unknown): number | null => {
    const safeNumerator = finiteNonNegative(numerator);
    const safeDenominator = finiteNonNegative(denominator);
    if (safeNumerator === null || safeDenominator === null || safeDenominator <= 0) return null;
    return Math.round(Math.max(0, Math.min(100, (safeNumerator / safeDenominator) * 100)));
  };
  const formatCount = (value: unknown): string => {
    const numeric = finiteNonNegative(value);
    return numeric === null ? "측정 불가" : String(numeric);
  };
  const formatBenchmarkPercent = (key: keyof NormalizedBenchmark): string => {
    const value = benchmarkMetric(key);
    return value === null ? "측정 불가" : `${value}%`;
  };
  const formatBenchmarkNumber = (key: keyof NormalizedBenchmark, suffix = ""): string => {
    const value = benchmarkMetric(key);
    return value === null ? "측정 불가" : `${value}${suffix}`;
  };
  const earlyElimination = isEarlyElimination({
    survivalTime: finiteNonNegative(stats?.timeSurvived), deathPhase: finiteNonNegative(matchData.deathPhase),
    myDeathCount: typeof stats?.deathType === "string" ? (stats.deathType === "alive" ? 0 : 1) : null,
  });
  const leadKills = stats?.leadShotKills ?? matchData.leadShotKills ?? 0;
  const leadKnocks = stats?.leadShotKnocks ?? matchData.leadShotKnocks ?? 0;
  const ridingKills = stats?.ridingShotKills ?? matchData.ridingShotKills ?? 0;
  const ridingKnocks = stats?.ridingShotKnocks ?? matchData.ridingShotKnocks ?? 0;
  const hasVehicleCombat = leadKills > 0 || leadKnocks > 0 || ridingKills > 0 || ridingKnocks > 0;
  const personalReviveRate = boundedRate(tradeStats.revCount, tradeStats.teammateKnocks);
  const smokeOpportunityRate = boundedRate(tradeStats.smokeRescues, tradeStats.teammateKnocks);
  const smokeAttemptSuccessRate = boundedRate(tradeStats.smokeRescues, tradeStats.smokeCount);
  const totalThrows = finiteNonNegative(combatPressure.utilityStats?.throwCount);
  const lethalThrowValue = finiteNonNegative(combatPressure.utilityStats?.lethalThrowCount);
  const fallbackFragCount = finiteNonNegative(matchData.itemUseSummary?.frags);
  const fallbackMolotovCount = finiteNonNegative(matchData.itemUseSummary?.molotovs);
  const fallbackLethalThrows = fallbackFragCount === null && fallbackMolotovCount === null
    ? null
    : (fallbackFragCount ?? 0) + (fallbackMolotovCount ?? 0);
  const lethalThrows = lethalThrowValue ?? fallbackLethalThrows;
  const missingThrowLink = combatPressure.utilityStats?.accuracyStatus === "missing";
  const rawUtilityHits = missingThrowLink ? null : finiteNonNegative(combatPressure.utilityStats?.hitCount);
  const utilityHits = lethalThrows !== null && rawUtilityHits !== null
    ? Math.min(rawUtilityHits, lethalThrows)
    : null;
  const utilityDamage = finiteNonNegative(combatPressure.utilityStats?.totalDamage ?? combatPressure.utilityDamage);
  const utilityAccuracy = lethalThrows !== null && lethalThrows > 0 && utilityHits !== null
    ? Number(((utilityHits / lethalThrows) * 100).toFixed(1))
    : null;
  const avgDamagePerLethalThrow = !missingThrowLink && lethalThrows !== null && lethalThrows > 0 && utilityDamage !== null
    ? Number((utilityDamage / lethalThrows).toFixed(1))
    : null;
  const utilityInterpretation = lethalThrows !== null && lethalThrows > 0
    ? `피해형 투척 ${lethalThrows}회 중 피해 적중 ${utilityHits === null ? "측정 불가" : `${utilityHits}회`}로 평가할 것`
    : `피해형 투척 ${formatCount(lethalThrows)}회이므로 적중률/폭파 칭호를 만들지 말고, 총 투척 ${formatCount(totalThrows)}회는 연막 또는 비피해 투척 활용으로만 해석할 것`;
  const rawBackupLatency = tradeStats.tradeLatencyMs;
  const backupLatencyMs = rawBackupLatency === null
    || rawBackupLatency === undefined
    || (typeof rawBackupLatency === "string" && rawBackupLatency.trim() === "")
    ? null
    : Number(rawBackupLatency);
  const backupLatencyText = backupLatencyMs !== null
    && Number.isFinite(backupLatencyMs)
    && backupLatencyMs >= 0
    ? `${(backupLatencyMs / 1000).toFixed(1)}s`
    : "데이터 부족";
  const backupContext = buildBackupCoachingContext({
    avgBackupLatency: backupLatencyText,
    totalTradeKills: finiteNonNegative(tradeStats.tradeKills) ?? 0,
    totalRevCount: finiteNonNegative(tradeStats.revCount) ?? 0,
    totalSmokeRescues: finiteNonNegative(tradeStats.smokeRescues) ?? 0,
    totalTeamWipes: finiteNonNegative(tradeStats.enemyTeamWipes) ?? 0,
    totalTeammateKnocks: finiteNonNegative(tradeStats.teammateKnocks) ?? 0,
    benchmarkTradeLatency: benchmarkMetric("avgTradeLatency") ?? undefined,
  });
  const benchmark = matchData.benchmark || {};
  const impactGradeLabel = benchmark.impactGrade === "LEGEND"
    ? "레전드"
    : benchmark.impactGrade === "HARD_CARRY" ? "하드캐리"
      : benchmark.impactGrade === "CARRY" ? "캐리"
        : benchmark.impactGrade === "GOOD" ? "좋은 판" : "일반";
  const impactReasons = Array.isArray(benchmark.impactReasons) && benchmark.impactReasons.length > 0
    ? benchmark.impactReasons.join(", ")
    : "없음";
  const impactBonus = formatNumber(benchmark.impactBonus);
  const isCrossfireText = isolationData === null || typeof isolationData?.isCrossfire !== "boolean"
    ? "측정 불가"
    : isolationData.isCrossfire ? "있음" : "없음";

  const playerReportSummary = `
[기본 성적]
- 매치: ${mapName} (${gameMode}), 순위: #${stats.winPlace}
- 전투: ${stats.kills}킬 / ${stats.assists}어시 / ${stats.DBNOs}기절 / 유효 딜량 ${Math.floor(stats.processedDamageDealt ?? stats.damageDealt)}${hasVehicleCombat ? `\n- 특수 전투(차량): 리드샷 기절/킬 ${leadKnocks}/${leadKills}, 라이딩샷 기절/킬 ${ridingKnocks}/${ridingKills}` : ""}
- 킬 기여도: 직접 사살(Solo Kill) ${killContribution.solo}회 / 마무리 사살(Cleanup) ${killContribution.cleanup}회
- 실력 등급: 엘리트 대비 딜량 ${formatPercent(teamImpact.damageImpact)} / 킬 ${formatPercent(teamImpact.killImpact)}
- 팀 기여도: 팀 내 딜량 비중 ${formatPercent(teamImpact.teamDamageShare)} / 팀 내 킬 비중 ${formatPercent(teamImpact.teamKillShare)}
- 획득 배지: ${badges.length > 0 ? badges.map((b: any) => `[${b.name}: ${b.desc}]`).join(", ") : "없음"}
- 생존: ${Math.floor(stats.timeSurvived / 60)}분 ${stats.timeSurvived % 60}초
- 전술 안정도: ${benchmark.score ?? "측정 불가"} / 100
- 매치 임팩트: ${benchmark.impactScore ?? "측정 불가"} (${impactGradeLabel}, 안정도 대비 +${impactBonus})
- 임팩트 근거: ${impactReasons}

[전술 지표 (유저 vs DB 티어 평균)]
- 1:1 교전 승률: ${formatPercent(matchData.duelStats?.duelWinRate)} (교전 ${formatCount(matchData.duelStats?.totalDuels)}회, Elite Avg: ${formatBenchmarkPercent("avgDuelWinRate")})
- 복수(Trade) 성공률: ${formatPercent(tradeStats.tradeRate)} (Elite Avg: ${formatBenchmarkPercent("avgTradeRate")})
- 선제 공격 성공률: ${formatPercent(matchData.initiative_rate)} (선제 시도 ${formatCount(matchData.initiativeSampleCount)}회, Elite Avg: ${formatBenchmarkPercent("avgInitiativeRate")})
- 대응 사격 속도(첫 반격): ${(() => {
  const firstReply = firstReplyLatencyMs(matchData);
  const ambushed = (finiteNonNegative(matchData.duelStats?.reversalAttempts) ?? 0) > 0;
  if (firstReply !== null) return `${(firstReply / 1000).toFixed(2)}s (기습당한 교전 ${matchData.duelStats.firstReplyWithin3sCount}회의 첫 피격→첫 반격 평균, Elite Avg: ${formatBenchmarkNumber("avgFirstReplyLatency", "s")})`;
  if (ambushed && finiteNonNegative(tradeStats.reactionLatencyMs) === COUNTER_LATENCY_PENALTY_MS) return `3초 안에 첫 반격 없음(기습 ${matchData.duelStats.reversalAttempts}회, 실제 시간 측정 불가) (Elite 3초 내 대응 실패율: ${formatBenchmarkPercent("avgCounterFailureRate")})`;
  return ambushed ? "측정 불가(첫 반격 기록 없음)" : "기습당한 교전 없음";
})()}
- 백업(Trade) 속도: ${backupLatencyText} (Elite Avg: ${formatBenchmarkNumber("avgTradeLatency", "s")})
- 백업 결과 해석: 복수 처치까지의 시간이며, 소생·합류·복구에 걸린 시간은 측정하지 않음
- 전술 지원: 아군 처치 지원 ${formatCount(tradeStats.suppCount)}회 / 아군 처치 ${formatCount(tradeStats.teammateKills)}회 중 지원 비율 ${formatPercent(tradeStats.suppRate)} (비교 자료 없음)
- 위기 관리: 내가 한 소생률 ${formatPercent(personalReviveRate)} (아군 기절 ${formatCount(tradeStats.teammateKnocks)}회 중 내 소생 ${formatCount(tradeStats.revCount)}회, Elite Avg: ${formatBenchmarkPercent("avgReviveRate")}) / 내 연막 구출률 ${formatPercent(smokeOpportunityRate)} (아군 기절 대비 성공, Elite Avg: ${formatBenchmarkPercent("avgSmokeRate")}) / 구출 연막 시도 성공률 ${formatPercent(smokeAttemptSuccessRate)} (시도 ${formatCount(tradeStats.smokeCount)}회, 성공 ${formatCount(tradeStats.smokeRescues)}회)
- 공간 전술: 고립 지수 ${isolationData?.isolationIndex ?? "데이터 부족"} (Elite Avg: ${formatBenchmarkNumber("avgIsolationIndex")}) / 아군 평균 거리: ${formatNumber(isolationData?.minDist, "m")} / 고도차 ${formatNumber(isolationData?.heightDiff, "m")} / 십자포화 노출: ${isCrossfireText}
- 유틸리티 정밀: 총 투척 ${formatCount(totalThrows)}회 / 피해형 투척 ${formatCount(lethalThrows)}회 / 피해 적중 ${formatCount(utilityHits)}회 / 피해형 투척 적중률 ${formatPercent(utilityAccuracy)} / 피해형 투척당 평균 딜 ${formatNumber(avgDamagePerLethalThrow)}
- 유틸리티 해석: ${utilityInterpretation}
- 교전 압박: 압박 지수 ${formatNumber(combatPressure.pressureIndex)} (Elite Avg: ${formatBenchmarkNumber("avgPressureIndex")}) / 투척물 딜량 ${formatNumber(combatPressure.utilityDamage ?? combatPressure.utilityStats?.totalDamage)}
- 운영 패턴: 사망 페이즈 ${(() => {
  // 구버전 저장 행은 첫 자기장 전 사망을 경기 종료 시점 페이즈로 기록할 수 있다. 생존 시간과 맞지 않는 값은 쓰지 않는다.
  const phase = finiteNonNegative(matchData.deathPhase), survived = finiteNonNegative(stats?.timeSurvived);
  return phase !== null && phase >= 3 && survived !== null && survived < 360 ? "측정 불가(생존 시간과 맞지 않음)" : formatNumber(matchData.deathPhase);
})()} (Elite Avg: ${formatBenchmarkNumber("avgDeathPhase", " 페이즈")})
- 조기 탈락 분류: ${earlyElimination === null ? "측정 불가" : earlyElimination ? "해당" : "해당 없음"} (10분 미만 생존 또는 실제 사망 시 3페이즈 이하)
- 팀 전멸 기여: ${formatCount(tradeStats.enemyTeamWipes)}회
`.trim();

  const personaPrompt = isMild
    ? `당신은 '다정한 코치'입니다. 유저의 플레이에서 전술적 가치를 찾아 따뜻하게 조언하십시오. 
       단, 상위권 지표와 큰 격차가 나는 수치(예: 너무 짧은 교전 거리, 낮은 주도권)를 무리하게 칭찬(억지 미화)하지 마십시오. 
       관측 기록이 부족하면 평가를 보류하십시오. 관측된 강점을 설명하고 다음 경기에 시도할 행동은 조건부 제안으로 구분하십시오.`
    : `당신은 '매운맛 분석가'입니다. 팩트 중심의 냉혹한 실전 분석가입니다. 
       관측된 수치와 비교 근거로 확인되는 개선점을 직설적으로 설명하십시오.
       배지나 일부 낮은 지표만으로 경기 전체 기여도를 부정하거나 의도·성격을 단정하지 마십시오.`;

  const promptLines = [
    `당신은 PUBG 전술 분석 전문가입니다. 이번 매치의 전술 데이터를 바탕으로 유저에게 [${isMild ? "다정한 맛" : "매운맛"}] 분석 리포트를 제공하십시오.`,
    "",
    personaPrompt,
    "",
    "[데이터 기반 판정 지침]",
    "- 모든 분석 용어와 코치 이름은 반드시 한글로만 표기하십시오.",
    "- [비교 근거] 해당 지표의 비교값이 숫자로 제공된 경우에만 비교하십시오. 비교값이 측정 불가이면 상위권보다 느림/낮음/부족 또는 평균 수준을 주장하지 마십시오.",
    "- 배지가 없다는 이유로 실속 없음/훈장 사냥꾼/기여 부족을 단정하지 마십시오. 배지는 특정 조건의 보상일 뿐 전체 성과의 평가 기준이 아닙니다.",
    "- 후방/전방/진입 위치는 측정되지 않았습니다. 칭호에도 사용하지 마십시오.",
    "- [배지 우선순위] 유저가 획득한 배지가 있다면 이를 signature(칭호) 결정의 핵심 근거로 사용하십시오.",
    "- [피해 기준] 유효 딜량은 무기별 집계로 투척물·차량 폭발 등 제외 항목이 있을 수 있습니다. 팀 내 딜량 비중은 PUBG 공식 피해량으로 계산하므로 두 값의 기준이 다를 수 있습니다. 공식 피해량과 유효 딜량을 같은 수치로 단정하지 마십시오.",
    "- [팀 영향력] 딜량 비중은 실제 화력 분담 비율만 설명하십시오. 비중만으로 교전 주도, 소극적 플레이, 후방 대기, 숨기, 동료 의존을 단정하지 마십시오.",
    "- [팀 영향력 해석 보호 규칙] 높은 딜량 비중은 '화력 기여'로만 설명하십시오. 비중은 진입/선제 공격의 증거가 아닙니다. 아군 소생 실패, 복구 실패, 팀원 사망 방치 데이터가 없으면 의도, 인성, 팀원 이용 여부를 단정하는 표현을 금지합니다.",
    "- [매치 임팩트 해석 규칙] 매치 임팩트가 '하드캐리' 또는 '레전드'이면 해당 판은 단일 경기 하이라이트 성과로 인정하십시오. 낮은 세부 항목을 지적하더라도 '판 전체가 나쁘다'거나 '방관했다'고 단정하지 말고, 강한 성과와 보완점을 분리해 말하십시오.",
    "- [승리 기여 중복 방지] 1등 자체는 생존 결과입니다. '1등이라서 보너스'라고 표현하지 말고, 화력 캐리/복구 기여/결정적 마무리/승리 기여 근거처럼 행동 근거만 말하십시오.",
    "- [고립 해석 보호 규칙] 고립 지수가 2.0 미만이면 양호한 대열 유지로 해석하십시오. 이 경우 '고립될 위험', '고립 위험이 높다', '너무 멀리', '독단적인 플레이', '독단 플레이', '고립형', '고독한 화력소'를 칭호나 부정문에서도 쓰지 마십시오. 평균 거리로 실제 엄폐·시야·소통을 추정하지 마십시오.",
    "- [금지 표현] '팀원을 방패', '팀원을 들러리', '팀원을 방치', '팀원 등쳐먹음', '이기적 독식', '혼자 다 해먹', '팀 지원 지표가 바닥', '팀원은 들러리', '나머지 팀원들의 화력 지원이 전무', '팀 전체가 휘청', '존재감이 희미'를 signature/signatureSub/briefFeedback/finalVerdict/actionItems 어디에도 쓰지 마십시오. 비난을 '교전 분담 부족'이나 '협업 지표 보완 필요'로 순화해 남기지 마십시오. 근거 없는 해석은 보류하고 관측된 수치와 조건부 연습 제안을 구분하십시오.",
    "- [출력 전 자체 검수] JSON을 작성한 뒤 signatureSub/briefFeedback/finalVerdict/actionItems에 금지 표현이 하나라도 있으면 응답하기 전에 반드시 고치십시오. 금지 표현을 다른 부족 판정으로 바꾸지 마십시오. 해당 판단을 뒷받침할 행동 근거가 없으면 '해당 평가는 행동 근거가 부족해 보류합니다.'라고 쓰십시오.",
    "- [관측/추천 구분] 측정하지 않은 과거 행동(숨어 다님, 후방 대기, 아군 곁을 맴돎)을 만들지 마십시오. 다음 경기의 제안과 이번 경기의 관측 사실을 별도 문장으로 쓰십시오.",
    "- [투척물 분석 규칙] 총 투척 수와 피해형 투척 수는 다릅니다. 예: 총 12회/피해형 4회/명중 1회라면 '총 투척 12회 중 피해형 4회, 명중 1회, 적중률 25%'입니다. 12회를 피해형 투척이라고 쓰지 마십시오. 측정 불가 적중 수를 0회로 바꾸지 마십시오.",
    "  * '피해형 투척 적중률'은 수류탄/화염병/C4 등 피해형 투척물 기준입니다. 연막탄/M79 연막은 총 투척 수와 연막 구출 지표에서만 해석하십시오.",
    "  * 피해형 투척이 0회이면 정확도 칭호를 만들거나 유틸리티 보조를 못했다고 말하지 말고, 연막 사용 또는 구출 기회 여부만 따로 설명하십시오.",
    "  * 피해형 투척 적중률이 30% 이상이면 '폭파 전문가', 킬까지 있다면 '투척물 마스터' 칭호를 고려하십시오.",
    "  * 피해형 투척당 평균 데미지는 피해량만 설명하며, 적 위치 파악 능력이나 정확한 의도를 입증하지 않습니다.",
    "  * 투척물 딜량이 0이면 정확도만으로 교전 보조 능력을 단정하지 마십시오.",
    "- [백업 해석 규칙] 백업 속도는 아군 기절 후 복수 처치까지의 시간입니다. 이를 소생·합류·복구에 걸린 시간으로 해석하거나 복구 시간 단축을 지시하지 마십시오. 전멸 기여와 소생 횟수만으로 같은 사건의 복구 성공을 단정하지 마십시오.",
    "- [표본과 비교] 투척 1~2회나 대응 사격 관측이 적을 때는 전반적인 능력을 단정하지 마십시오. 평균만으로 상위 백분위를 주장하지 말고, 선제 공격 성공률을 첫 발 명중률로 해석하지 마십시오.",
    "- [적은 표본] 1:1 교전·선제 시도·피해형 투척이 3회 미만인 지표는 횟수만 말하고, 능력이 부족하다거나 높이라는 평가·지시(actionItems 포함)의 근거로 쓰지 마십시오.",
    "- [비교 없는 평가 금지] Elite Avg가 측정 불가인 지표(예: 대응 사격 속도)는 빠르다/느리다/미흡하다로 평가하지 말고 관측값만 말하십시오.",
    "- [기여 인정] 처치·어시스트·기절·소생·적 팀 전멸 기여 중 하나라도 1회 이상이면 '아무 기여도 없다', '아무것도 남기지 못했다'처럼 쓰지 마십시오. 피해량이나 1:1 교전 승리가 있으면 화력·교전 성과가 전무하다고 쓰지 마십시오. 조기 탈락은 서버의 조기 탈락 분류를 따르고, 생존 시간과 사망 페이즈 사실로만 말하십시오.",
    "- [인성 표현 금지] 무책임, 무능, 민폐, 한심, 이기적 같은 태도·인성 평가와 집중력·판단력·멘탈처럼 측정하지 않은 능력은 쓰지 마십시오.",
    "- [진입 추정 금지] 진입 시점이나 무리한 진입 여부는 측정하지 않았습니다. '무리한 진입'을 원인이나 행동 제안으로 쓰지 마십시오. 화력 비중으로 '전선 돌파자', '대치선돌파수' 같은 돌파·돌입·진입 칭호를 만들지 마십시오.",
    "- [피드백 구성] briefFeedback 3개는 서로 다른 주제(화력·교전·팀플레이 또는 생존)를 다루고, 각 문장에 관측 수치와 그 수치가 이번 경기에서 뜻하는 바를 함께 쓰십시오. 같은 수치를 반복하지 마십시오.",
    "- [마지막 한마디] finalVerdict는 이번 경기 기록에서 가장 중요한 사실 하나와 다음 경기 과제 하나를 한두 문장으로 쓰십시오. 분석 원칙이나 코치 자신의 태도를 말하지 마십시오.",
    "- [행동 제안] actionItems는 이번 경기에서 표본이 충분한 지표 가운데 가장 아쉬운 1~2개만 골라, 다음 경기에서 확인하거나 시도할 구체 행동으로 쓰십시오. 근거가 없으면 1개만 쓰십시오.",
    "- **핵심 규칙**: 불필요한 미사여구와 항목 나열을 절대 금지합니다. 칭호와 그에 대한 전술적 이유를 설명한 뒤, 하단에 정확히 3개의 핵심 피드백 문장만 제공하십시오.",
    "",
    "반드시 아래 구조의 JSON 객체로만 응답하세요. 백틱(```) 없이 순수 JSON만 출력하십시오.",
    "{",
    `  "coach": "${isMild ? "다정한 코치" : "매운맛 분석가"}",`,
    '  "signature": "유저의 플레이 스타일 칭호 (배지 및 영향력 고려)",',
    '  "signatureSub": "칭호 부여 이유 (1문장, 배지 명칭 포함 권장)",',
    '  "briefFeedback": [',
    '    "첫 번째 핵심 피드백 (데이터 수치 및 배지 언급, 1문장)",',
    '    "두 번째 핵심 피드백 (데이터 수치 및 팀 영향력 언급, 1문장)",',
    '    "세 번째 핵심 피드백 (데이터 수치 포함, 1문장)"',
    '  ],',
    '  "finalVerdict": "마지막 한마디 (짧게)",',
    '  "actionItems": [ { "icon": "🎯", "title": "목표", "desc": "팁" } ]',
    "}",
  ];

  return {
    fullPrompt: `${promptLines.join("\n")}\n\n[분석 데이터]\n${playerReportSummary}`,
    playerReportSummary,
    backupContext,
  };
}
