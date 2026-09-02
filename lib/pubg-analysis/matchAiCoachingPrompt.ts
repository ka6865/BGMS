import { buildBackupCoachingContext, type BackupCoachingContext } from "@/lib/pubg-analysis/backupCoaching";

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
    eliteBenchmark = {},
    killContribution = { solo: 0, cleanup: 0, other: 0 },
    tradeStats = {},
    combatPressure = {},
    isolationData = null,
    teamImpact = { damageImpact: 0, killImpact: 0, teamDamageShare: 0, teamKillShare: 0 } as any,
    badges = [],
  } = matchData;
  const leadKills = stats?.leadShotKills ?? matchData.leadShotKills ?? 0;
  const leadKnocks = stats?.leadShotKnocks ?? matchData.leadShotKnocks ?? 0;
  const ridingKills = stats?.ridingShotKills ?? matchData.ridingShotKills ?? 0;
  const ridingKnocks = stats?.ridingShotKnocks ?? matchData.ridingShotKnocks ?? 0;
  const hasVehicleCombat = leadKills > 0 || leadKnocks > 0 || ridingKills > 0 || ridingKnocks > 0;
  const personalReviveRate = tradeStats.teammateKnocks > 0 ? Math.round((tradeStats.revCount / tradeStats.teammateKnocks) * 100) : 0;
  const smokeOpportunityRate = tradeStats.teammateKnocks > 0 ? Math.round((tradeStats.smokeRescues / tradeStats.teammateKnocks) * 100) : 0;
  const smokeAttemptSuccessRate = tradeStats.smokeCount > 0 ? Math.round((tradeStats.smokeRescues / tradeStats.smokeCount) * 100) : 0;
  const totalThrows = combatPressure.utilityStats?.throwCount || 0;
  const lethalThrows = combatPressure.utilityStats?.lethalThrowCount
    ?? ((matchData.itemUseSummary?.frags || 0) + (matchData.itemUseSummary?.molotovs || 0));
  const rawUtilityHits = combatPressure.utilityStats?.hitCount || 0;
  const utilityHits = lethalThrows > 0 ? Math.min(rawUtilityHits, lethalThrows) : 0;
  const utilityDamage = combatPressure.utilityStats?.totalDamage ?? combatPressure.utilityDamage ?? 0;
  const utilityAccuracy = lethalThrows > 0 ? Number(((utilityHits / lethalThrows) * 100).toFixed(1)) : 0;
  const avgDamagePerLethalThrow = lethalThrows > 0 ? Number((utilityDamage / lethalThrows).toFixed(1)) : 0;
  const utilityInterpretation = lethalThrows > 0
    ? `피해형 투척 ${lethalThrows}회 중 피해 적중 ${utilityHits}회로 평가할 것`
    : `피해형 투척 0회이므로 적중률/폭파 칭호를 만들지 말고, 총 투척 ${totalThrows}회는 연막 또는 비피해 투척 활용으로만 해석할 것`;
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
    totalTradeKills: tradeStats.tradeKills || 0,
    totalRevCount: tradeStats.revCount || 0,
    totalSmokeRescues: tradeStats.smokeRescues || 0,
    totalTeamWipes: tradeStats.enemyTeamWipes || 0,
    totalTeammateKnocks: tradeStats.teammateKnocks || 0,
    benchmarkTradeLatency: eliteBenchmark.avgTradeLatency,
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

  const playerReportSummary = `
[기본 성적]
- 매치: ${mapName} (${gameMode}), 순위: #${stats.winPlace}
- 전투: ${stats.kills}킬 / ${stats.assists}어시 / ${stats.DBNOs}기절 / 유효 딜량 ${Math.floor(stats.processedDamageDealt ?? stats.damageDealt)}${hasVehicleCombat ? `\n- 특수 전투(차량): 리드샷 기절/킬 ${leadKnocks}/${leadKills}, 라이딩샷 기절/킬 ${ridingKnocks}/${ridingKills}` : ""}
- 킬 기여도: 직접 사살(Solo Kill) ${killContribution.solo}회 / 마무리 사살(Cleanup) ${killContribution.cleanup}회
- 실력 등급: 엘리트 대비 딜량 ${teamImpact.damageImpact}% / 킬 ${teamImpact.killImpact}% 
- 팀 기여도: 팀 내 딜량 비중 ${teamImpact.teamDamageShare}% / 팀 내 킬 비중 ${teamImpact.teamKillShare}%
- 획득 배지: ${badges.length > 0 ? badges.map((b: any) => `[${b.name}: ${b.desc}]`).join(", ") : "없음"}
- 생존: ${Math.floor(stats.timeSurvived / 60)}분 ${stats.timeSurvived % 60}초
- 전술 안정도: ${benchmark.score ?? "측정 불가"} / 100
- 매치 임팩트: ${benchmark.impactScore ?? "측정 불가"} (${impactGradeLabel}, 안정도 대비 +${benchmark.impactBonus ?? 0})
- 임팩트 근거: ${impactReasons}

[전술 지표 (유저 vs DB 티어 평균)]
- 1:1 교전 승률: ${matchData.duelStats?.duelWinRate || 0}% (Elite Avg: ${eliteBenchmark.avgDuelWinRate || 55}%)
- 복수(Trade) 성공률: ${tradeStats.tradeRate || 0}% (Elite Avg: ${eliteBenchmark.avgTradeRate || 50}%)
- 선제 공격 성공률: ${matchData.initiative_rate || 0}% (Elite Avg: ${eliteBenchmark.avgInitiativeRate || 55}%)
- 대응 사격 속도(반응): ${tradeStats.reactionLatencyMs > 0 ? (tradeStats.reactionLatencyMs / 1000).toFixed(2) : "데이터 부족"}s (Elite Avg: ${eliteBenchmark.avgCounterLatency !== undefined ? eliteBenchmark.avgCounterLatency : 0.5}s)
- 백업(Trade) 속도: ${backupLatencyText} (Elite Avg: ${eliteBenchmark.avgTradeLatency !== undefined ? eliteBenchmark.avgTradeLatency : 12.0}s)
- 백업 결과 해석: ${backupContext.promptLine}
- 전술 지원: 견제사격 ${tradeStats.suppCount || 0}회 (Elite Avg: ${eliteBenchmark.avgSuppCount || 3.0}회)
- 위기 관리: 내가 한 소생률 ${personalReviveRate}% (아군 기절 ${tradeStats.teammateKnocks || 0}회 중 내 소생 ${tradeStats.revCount || 0}회, Elite Avg: ${eliteBenchmark.avgReviveRate || 80}%) / 내 연막 구출률 ${smokeOpportunityRate}% (아군 기절 대비 성공, Elite Avg: ${eliteBenchmark.avgSmokeRate || 60}%) / 구출 연막 시도 성공률 ${smokeAttemptSuccessRate}% (시도 ${tradeStats.smokeCount || 0}회, 성공 ${tradeStats.smokeRescues || 0}회)
- 공간 전술: 고립 지수 ${isolationData?.isolationIndex || "데이터 부족"} (Elite Avg: ${eliteBenchmark.avgIsolationIndex || 1.0}) / 아군 평균 거리: ${isolationData?.minDist || 0}m / 고도차 ${isolationData?.heightDiff || 0}m / 십자포화 노출: ${isolationData?.isCrossfire ? "있음" : "없음"}
- 유틸리티 정밀: 총 투척 ${totalThrows}회 / 피해형 투척 ${lethalThrows}회 / 피해 적중 ${utilityHits}회 / 피해형 투척 적중률 ${utilityAccuracy}% / 피해형 투척당 평균 딜 ${avgDamagePerLethalThrow}
- 유틸리티 해석: ${utilityInterpretation}
- 교전 압박: 압박 지수 ${combatPressure.pressureIndex || 0} (Elite Avg: ${eliteBenchmark.avgPressureIndex || 3.0}) / 투척물 딜량 ${combatPressure.utilityDamage || 0}
- 운영 패턴: 사망 페이즈 ${matchData.deathPhase || 0} (Elite Avg: ${eliteBenchmark.avgDeathPhase || 6} 페이즈)
- 팀 전멸 기여: ${tradeStats.enemyTeamWipes || 0}회
`.trim();

  const personaPrompt = isMild
    ? `당신은 '다정한 코치'입니다. 유저의 플레이에서 전술적 가치를 찾아 따뜻하게 조언하십시오. 
       단, 상위권 지표와 큰 격차가 나는 수치(예: 너무 짧은 교전 거리, 낮은 주도권)를 무리하게 칭찬(억지 미화)하지 마십시오. 
       수치가 부족하다면 '이타적 희생'보다는 '성장 가능성이 필요한 부분'으로 정직하게 언급하되, 부드러운 말투로 격려하십시오.`
    : `당신은 '매운맛 분석가'입니다. 팩트 중심의 냉혹한 실전 분석가입니다. 
       획득한 배지가 있더라도 전술적 지표(고립, 대응 사격 속도 등)가 엉망이라면 '속 빈 강정'이라며 독설을 퍼붓고, 
       팀 기여도가 낮은데 배지만 챙겼다면 '팀에 기여 없는 훈장 사냥꾼'으로 규정하십시오.`;

  const promptLines = [
    `당신은 PUBG 전술 분석 전문가입니다. 이번 매치의 전술 데이터를 바탕으로 유저에게 [${isMild ? "다정한 맛" : "매운맛"}] 분석 리포트를 제공하십시오.`,
    "",
    personaPrompt,
    "",
    "[데이터 기반 판정 지침]",
    "- 모든 분석 용어와 코치 이름은 반드시 한글로만 표기하십시오.",
    "- [Apple-to-Apple] 반드시 유저의 수치와 상위권 벤치마크 수치를 직접 대조하십시오.",
    "- [배지 우선순위] 유저가 획득한 배지가 있다면 이를 signature(칭호) 결정의 핵심 근거로 사용하십시오.",
    "- [팀 영향력] 내 딜량 비중이 40% 이상이면 '캐리', 15% 미만이면 '버스' 키워드를 전술적으로 활용하십시오.",
    "- [팀 영향력 해석 보호 규칙] 높은 딜량 비중은 우선 '강한 캐리/교전 주도'로 해석하십시오. 아군 소생 실패, 복구 실패, 팀원 사망 방치 데이터가 없으면 의도, 인성, 팀원 이용 여부를 단정하는 표현을 금지합니다.",
    "- [매치 임팩트 해석 규칙] 매치 임팩트가 '하드캐리' 또는 '레전드'이면 해당 판은 단일 경기 하이라이트 성과로 인정하십시오. 낮은 세부 항목을 지적하더라도 '판 전체가 나쁘다'거나 '방관했다'고 단정하지 말고, 강한 성과와 보완점을 분리해 말하십시오.",
    "- [승리 기여 중복 방지] 1등 자체는 생존 결과입니다. '1등이라서 보너스'라고 표현하지 말고, 화력 캐리/복구 기여/결정적 마무리/승리 기여 근거처럼 행동 근거만 말하십시오.",
    "- [고립 해석 보호 규칙] 고립 지수가 2.0 미만이면 양호한 대열 유지로 해석하십시오. 이 경우 '고립될 위험', '고립 위험이 높다', '너무 멀리', '독단적인 플레이', '독단 플레이'를 부정문에서도 쓰지 마십시오.",
    "- [금지 표현] '팀원을 방패', '팀원을 들러리', '팀원을 방치', '팀원 등쳐먹음', '이기적 독식', '혼자 다 해먹', '팀 지원 지표가 바닥', '팀원은 들러리', '나머지 팀원들의 화력 지원이 전무', '팀 전체가 휘청', '존재감이 희미'를 signature/signatureSub/briefFeedback/finalVerdict/actionItems 어디에도 쓰지 마십시오. 대신 '교전 분담 부족', '팀 지원 지표 보완', '강한 캐리지만 협업 지표 보완 필요'라고 표현하십시오.",
    "- [출력 전 자체 검수] JSON을 작성한 뒤 signatureSub/briefFeedback/finalVerdict/actionItems에 금지 표현이 하나라도 있으면 응답하기 전에 반드시 고치십시오. 특히 '혼자 다 해먹는 화력'은 절대 쓰지 말고 '강한 화력을 보여주지만 협업 지표 보완이 필요'라고 쓰십시오.",
    "- [투척물 분석 규칙 (V11.4)] ",
    "  * '피해형 투척 적중률'은 수류탄/화염병/C4 등 피해형 투척물 기준입니다. 연막탄/M79 연막은 총 투척 수와 연막 구출 지표에서만 해석하십시오.",
    "  * 피해형 투척이 0회이면 정확도 칭호를 만들지 말고, 연막 사용 또는 구출 기회 여부만 따로 설명하십시오.",
    "  * 피해형 투척 적중률이 30% 이상이면 '폭파 전문가', 킬까지 있다면 '투척물 마스터' 칭호를 고려하십시오.",
    "  * 피해형 투척당 평균 데미지가 50 이상이면 적의 위치를 정확히 파악하고 던지는 '정밀 폭격기'로 칭송하십시오.",
    "  * 투척물 딜량이 0이면 정확도만으로 교전 보조 능력을 단정하지 마십시오.",
    "- [백업 해석 규칙] 백업 속도는 시간 단독으로 평가하지 말고, 적 제압/팀 전멸 기여/소생/연막 구출 결과를 함께 판단하십시오. 결과가 성공한 긴 백업은 '느린 백업'으로 단정하지 말고 '교전 정리 후 복구 성공'과 '복구 시간 단축 과제'를 분리해 말하십시오.",
    "- [백업 성공 보호 규칙] 분석 데이터의 '백업 결과 해석'에 '느린 백업이라고 단정하지 말 것'이 포함되면 briefFeedback/finalVerdict/actionItems 어디에서도 '방관', '치명적', '느린 백업', '성공이라기엔 느림'으로 비난하지 마십시오. 이 경우 백업 액션 아이템 제목은 '복구 시간 단축'으로만 작성하고, 설명은 '성공 복구였지만 다음에는 시간을 줄이자'는 방향으로 작성하십시오.",
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
