import { isEarlyElimination } from "./benchmarkScore";

// 단일 경기·최근 요약 매운맛의 비꼬는 한마디. 스쿼드(squadPunchlines)와 같이 서버가 측정값으로 고른다.
// 한마디에는 숫자, 의도·심리·소통·엄폐처럼 측정하지 않은 것을 쓰지 않는다. 수치는 사실 문장이 담는다.
// 못한 점만 비꼬고, 잘한 점은 비꼬지 않고 인정한다.

/** 같은 시드면 같은 한마디다. */
function pickVariant(variants: readonly string[], seed: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash ^ seed.charCodeAt(index)) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return variants[hash % variants.length];
}

const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

const MATCH_JABS = {
  early_exit: ["자기장 구경도 제대로 못 하고 일찍 로비로 퇴근했습니다.", "낙하산 접고 짐 풀자마자 귀가한 경기였습니다."],
  duel_losing: ["1:1만 붙으면 상대 킬로그에 이름을 성실하게 올려 줬습니다.", "1:1 성적표는 상대 하이라이트 영상 재료에 가깝습니다."],
  quiet_gun: ["오래 살아남긴 했는데 총구는 끝까지 얌전했습니다.", "생존 시간은 길었는데 딜량 칸은 관광 기록 수준입니다."],
  share_tiny: ["팀 딜 그래프에서 본인 몫은 돋보기로 찾아야 보입니다."],
  far_from_team: ["팀원과의 거리가 거의 장거리 연애 수준이었습니다."],
} as const;

const MATCH_HYPES = {
  chicken: ["치킨은 치킨입니다. 이건 인정합니다."],
  duel_winning: ["1:1 붙는 족족 상대를 로비로 돌려보냈습니다. 이건 인정합니다."],
  damage_carry: ["팀 딜의 절반을 혼자 짊어진 화력 엔진이었습니다. 이건 인정합니다."],
} as const;

/** 단일 경기 매운맛 한마디. 비꼴 재료가 있으면 그것을, 없으면 인정할 재료를, 둘 다 없으면 null. */
export function matchSpicyJab(match: any): string | null {
  const stats = match?.stats ?? {};
  const seed = String(match?.matchId ?? "");
  const damage = finite(stats.processedDamageDealt) ?? finite(stats.damageDealt);
  const survived = finite(stats.timeSurvived);
  const duels = finite(match?.duelStats?.totalDuels), wins = finite(match?.duelStats?.wins);
  const teamDamage = finite(match?.teamImpact?.totalTeamDamage), damageShare = finite(match?.teamImpact?.teamDamageShare);
  const isolation = finite(match?.isolationData?.isolationIndex);
  const early = isEarlyElimination({
    survivalTime: survived, deathPhase: finite(match?.deathPhase),
    myDeathCount: typeof stats.deathType === "string" ? (stats.deathType === "alive" ? 0 : 1) : null,
  });
  // 우선순위대로 하나만 쓴다. 표본·조건이 부족하면 재료로 만들지 않는다.
  const roast = early === true ? "early_exit"
    : duels !== null && wins !== null && duels >= 3 && wins / duels <= 1 / 3 ? "duel_losing"
    : damage !== null && survived !== null && damage < 100 && survived >= 900 ? "quiet_gun"
    : teamDamage !== null && damageShare !== null && teamDamage >= 300 && damageShare <= 15 ? "share_tiny"
    : isolation !== null && isolation >= 2.5 ? "far_from_team"
    : null;
  if (roast) return pickVariant(MATCH_JABS[roast], seed);
  const hype = finite(stats.winPlace) === 1 ? "chicken"
    : duels !== null && wins !== null && duels >= 3 && wins / duels >= 0.75 ? "duel_winning"
    : teamDamage !== null && damageShare !== null && teamDamage >= 300 && damageShare >= 50 ? "damage_carry"
    : null;
  return hype ? pickVariant(MATCH_HYPES[hype], seed) : null;
}

/** 매운맛 단일 경기 응답의 finalVerdict 끝에 한마디를 붙인다. 이미 붙어 있으면 그대로 둔다(캐시 재적용). */
export function applyMatchSpicyJab(text: string, match: any): string {
  const jab = matchSpicyJab(match);
  if (!jab) return text;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || typeof parsed.finalVerdict !== "string" || parsed.finalVerdict.includes(jab)) return text;
    return JSON.stringify({ ...parsed, finalVerdict: `${parsed.finalVerdict.trim()} ${jab}`.trim() });
  } catch {
    return text;
  }
}

// 최근 요약 카드: 비교 평균에 못 미친 지표별 한마디.
const SUMMARY_METRIC_JABS: Readonly<Record<string, readonly string[]>> = {
  damage_average: ["평균 화력은 비교 평균 앞에서 조용히 고개를 숙였습니다.", "총은 들고 다녔는데 딜량은 소문만 무성했습니다."],
  initiative_rate: ["선제 타격 기록만 보면 먼저 맞고 시작하는 게 국룰이었습니다."],
  pressure_index: ["교전 압박은 상대에게 안부 인사 수준이었습니다."],
  counter_failure_rate: ["기습당한 뒤 3초 동안은 관전 모드에 가까웠습니다."],
  reaction_latency: ["반격 버튼이 한 박자씩 늦게 눌리는 기록입니다."],
  duel_win_rate: ["1:1 성적표는 상대 하이라이트 영상 재료에 가깝습니다."],
  solo_kill_share: ["킬로그에 혼자 이름 올린 장면은 손에 꼽힙니다."],
  death_phase: ["자기장이 좁아지는 구경은 주로 관전 화면으로 하셨습니다."],
  isolation_average: ["팀원과의 거리가 장거리 연애 수준이었습니다."],
  trade_success_rate: ["쓰러진 아군의 복수는 대부분 다음 생으로 미뤄졌습니다."],
  backup_latency: ["백업은 아군 장례식이 끝날 즈음 도착했습니다."],
  smoke_opportunity_rate: ["아군이 쓰러져도 연막 구출 기록은 조용했습니다."],
};
const SUMMARY_HYPES = ["이 항목은 트집 잡을 데가 없어 매운맛이 머쓱합니다.", "여기는 인정합니다. 맵게 할 말이 없습니다."];

/**
 * 요약 카드 매운맛 한마디. 못 미친 지표가 있으면 첫 지표를 비꼬고, 비교 지표가 모두 평균 이상이면 인정한다.
 * unfavorableMetricIds가 비고 favorable이 false면(비교 불가) null.
 */
export function summaryCardSpicyJab(unfavorableMetricIds: readonly string[], allFavorable: boolean, seed: string): string | null {
  const metricId = unfavorableMetricIds.find(id => SUMMARY_METRIC_JABS[id]);
  if (metricId) return pickVariant(SUMMARY_METRIC_JABS[metricId], `${seed}:${metricId}`);
  return allFavorable ? pickVariant(SUMMARY_HYPES, seed) : null;
}
