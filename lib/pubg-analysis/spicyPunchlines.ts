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

// 단일 경기 매운맛 응답은 반말이라 한마디도 반말로 맞춘다.
const MATCH_JABS = {
  early_exit: ["자기장 구경도 제대로 못 하고 일찍 로비로 퇴근했네.", "낙하산 접고 짐 풀자마자 귀가한 판이었어."],
  duel_losing: ["1:1만 붙으면 상대 킬로그에 이름을 성실하게 올려 줬네.", "1:1 성적표는 거의 상대 하이라이트 영상 재료야."],
  quiet_gun: ["오래 살아남긴 했는데 총구는 끝까지 얌전했네.", "생존 시간은 긴데 딜량 칸은 관광 기록 수준이야."],
  share_tiny: ["팀 딜 그래프에서 네 몫은 돋보기로 찾아야 보여."],
  far_from_team: ["팀원이랑 거리가 거의 장거리 연애 수준이었어."],
} as const;

const MATCH_HYPES = {
  chicken: ["치킨은 치킨이지. 이건 인정.", "치킨 챙긴 판이네. 이건 인정.", "결국 치킨은 네 몫이었네. 이 판은 인정."],
  duel_winning: ["1:1 붙는 족족 상대를 로비로 돌려보냈네. 이건 인정."],
  damage_carry: ["팀 딜 절반을 혼자 짊어진 화력 엔진이었어. 이건 인정."],
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
    if (finite(match?.stats?.winPlace) === 1 && (
      MATCH_HYPES.chicken.some((variant) => parsed.finalVerdict.includes(variant))
      || (MATCH_HYPES.chicken as readonly string[]).includes(jab) && /우승|치킨/u.test(parsed.finalVerdict)
    )) return text;
    return JSON.stringify({ ...parsed, finalVerdict: `${parsed.finalVerdict.trim()} ${jab}`.trim() });
  } catch {
    return text;
  }
}

// 최근 요약 카드: 비교 평균에 못 미친 지표별 한마디. 단일 경기처럼 반말이다.
// 강도는 차이 크기로 정한다(aiSummaryCards의 SUMMARY_GAP_POLICY). 약은 가벼운 견제, 강만 센 놀림을 쓴다.
export type SummaryJabIntensity = "weak" | "mid" | "strong";
type TieredLines = Readonly<Record<SummaryJabIntensity, readonly string[]>>;

const SUMMARY_METRIC_JABS: Readonly<Record<string, TieredLines>> = {
  damage_average: {
    weak: ["딜량은 평균에서 살짝 모자랐네.", "딜량이 한 끗 차이로 아쉬웠어.", "딜량은 조금만 더 얹으면 되는 수준이야."],
    mid: ["딜량 칸이 좀 조용했네.", "딜량은 평균 앞에서 한 발 물러섰어.", "총은 쐈는데 딜량은 평균에 못 닿았어."],
    strong: ["딜량 칸은 조용히 고개 숙이고 있었네.", "총은 들고 다녔는데 딜량은 소문만 무성했어.", "딜량 기록이 거의 실종 신고 수준이야."],
  },
  initiative_rate: {
    weak: ["먼저 쏜 교전이 평균보다 살짝 적었네.", "선제 타격은 아주 조금 밀렸어.", "첫 사격 타이밍이 한 끗 늦은 판이 있었네."],
    mid: ["선제 타격은 평균보다 자주 뺏겼네.", "먼저 맞고 시작한 교전이 꽤 많았어.", "첫 총성은 상대 몫인 경우가 많았네."],
    strong: ["선제 타격 기록만 보면 먼저 맞고 시작하는 게 국룰이었네.", "첫 사격은 거의 상대한테 양보했어.", "교전 시작 버튼은 대부분 상대가 눌렀네."],
  },
  pressure_index: {
    weak: ["교전 압박은 평균보다 살짝 약했어.", "압박은 조금만 더 이어 가면 되는 수준이야.", "압박 기록이 한 끗 모자랐네."],
    mid: ["교전 압박이 중간에 자주 끊겼네.", "압박은 시작했는데 끝까지 밀진 못했어.", "압박 기록은 평균에 못 미쳤어."],
    strong: ["교전 압박은 상대한테 안부 인사 수준이었어.", "압박이라고 부르기엔 너무 예의 바른 기록이야.", "상대가 편하게 숨 돌릴 만한 압박이었네."],
  },
  counter_failure_rate: {
    weak: ["기습당했을 때 대응이 살짝 늦은 적이 있었네.", "기습 대응은 아주 조금 아쉬웠어.", "기습 뒤 첫 대응이 한 끗 모자랐네."],
    mid: ["기습당하고 대응 못 한 교전이 꽤 있었네.", "기습 대응 실패가 평균보다 잦았어.", "기습 뒤 첫 대응이 자주 비었네."],
    strong: ["기습당하고 3초 동안은 거의 관전 모드였네.", "기습만 당하면 반격이 실종됐어.", "기습 대응 기록은 거의 백지야."],
  },
  reaction_latency: {
    weak: ["반격이 평균보다 살짝 늦었네.", "반격 타이밍이 한 박자 반의 반쯤 늦었어.", "반격은 조금만 당기면 되는 수준이야."],
    mid: ["반격 버튼이 한 박자씩 늦게 눌리는 기록이야.", "맞고 나서 반격까지 시간이 꽤 걸렸네.", "반격 속도는 평균보다 느렸어."],
    strong: ["반격은 상대가 다 쏘고 난 뒤에 도착했네.", "맞고 나서 반격까지 거의 회의를 한 수준이야.", "반격 속도 기록이 느긋해도 너무 느긋했어."],
  },
  duel_win_rate: {
    weak: ["1:1은 평균보다 살짝 밀렸네.", "1:1 성적이 한 끗 아쉬웠어.", "1:1은 조금만 더 이기면 되는 수준이야."],
    mid: ["1:1에서 지는 쪽이 꽤 잦았네.", "1:1 성적은 평균에 못 미쳤어.", "1:1 붙으면 상대 쪽이 자주 웃었네."],
    strong: ["1:1 성적표는 거의 상대 하이라이트 영상 재료야.", "1:1만 붙으면 상대 킬로그를 채워 줬네.", "1:1 기록은 상대한테 보너스 같았어."],
  },
  solo_kill_share: {
    weak: ["혼자 마무리한 킬이 평균보다 살짝 적었네.", "직접 마무리는 아주 조금 모자랐어.", "단독 마무리가 한 끗 아쉬웠네."],
    mid: ["혼자 마무리한 킬이 꽤 적었네.", "킬로그에 혼자 이름 올린 장면이 드물었어.", "단독 마무리 기록은 평균에 못 미쳤어."],
    strong: ["킬로그에 혼자 이름 올린 장면은 손에 꼽혀.", "단독 마무리는 거의 전설 속 이야기야.", "혼자 마무리한 킬은 찾기가 힘들 정도야."],
  },
  death_phase: {
    weak: ["후반까지 버틴 판이 평균보다 살짝 적었네.", "생존 페이즈가 한 끗 모자랐어.", "조금만 더 버티면 평균이야."],
    mid: ["자기장 후반 구경은 자주 놓쳤네.", "중반쯤 퇴장하는 판이 꽤 있었어.", "생존 페이즈는 평균에 못 미쳤어."],
    strong: ["자기장 좁아지는 구경은 주로 관전 화면으로 했네.", "후반 자기장은 거의 소문으로만 들었어.", "마지막 원은 관전석에서 보는 게 익숙했네."],
  },
  isolation_average: {
    weak: ["팀원이랑 거리가 평균보다 살짝 벌어졌네.", "대열이 아주 조금 느슨했어.", "팀원과 거리가 한 걸음쯤 멀었네."],
    mid: ["팀원이랑 거리가 꽤 벌어진 판이 많았네.", "대열에서 자주 떨어져 다녔어.", "팀원과 거리가 평균보다 멀었어."],
    strong: ["팀원이랑 거리가 거의 장거리 연애 수준이었어.", "대열이라기보다 각자 여행이었네.", "팀원 위치는 미니맵 끝에서나 보였겠어."],
  },
  trade_success_rate: {
    weak: ["아군 복수가 평균보다 살짝 적었네.", "복수 기록이 한 끗 모자랐어.", "복수는 조금만 더 챙기면 되는 수준이야."],
    mid: ["쓰러진 아군 복수를 자주 놓쳤네.", "복수 기록은 평균에 못 미쳤어.", "아군 기절 뒤 갚아 준 기록이 적었네."],
    strong: ["쓰러진 아군 복수는 대부분 다음 생으로 미뤘네.", "복수 기록은 거의 빈칸이야.", "아군 기절은 많았는데 갚아 준 기록은 실종이야."],
  },
  backup_latency: {
    weak: ["백업이 평균보다 살짝 늦었네.", "백업 도착이 한 끗 늦었어.", "백업은 조금만 당기면 되는 수준이야."],
    mid: ["백업 도착이 꽤 늦었네.", "백업 시간은 평균보다 길었어.", "아군 기절 뒤 복수까지 시간이 꽤 걸렸네."],
    strong: ["백업은 아군 장례식 끝날 즈음 도착했어.", "백업은 거의 다음 교전에 맞춰 도착했네.", "복수까지 걸린 시간이 여유로워도 너무 여유로웠어."],
  },
  // 연막 구출은 구할 수 없는 상황이 섞여 있어 강하게 놀리지 않는다.
  smoke_opportunity_rate: {
    weak: ["연막 구출 기록이 살짝 적었네.", "연막 구출은 한 끗 아쉬웠어.", "연막 구출이 조금 모자랐네."],
    mid: ["연막 구출 기록이 평균보다 적었어.", "연막 구출은 조용한 편이었네.", "연막 구출 기록이 아쉬웠어."],
    strong: ["아군이 쓰러져도 연막 구출 기록은 조용했네.", "연막 구출 기록이 평균보다 꽤 적었어.", "연막 구출은 거의 쉬어 갔네."],
  },
};
const SUMMARY_HYPES: TieredLines = {
  weak: ["평균보다 살짝 앞섰네. 이 정도는 인정할게.", "한 끗 차이지만 이번 관측에서는 인정할게.", "조금이라도 앞섰으니 이번 관측 범위에서 인정."],
  mid: ["이번 관측에서 비교 평균보다 유리하게 나온 지표는 인정할게.", "이 지표는 이번 관측 범위에서 인정할 만하네.", "평균보다 확실히 앞섰네. 이번 관측에서는 인정."],
  strong: ["이건 트집 잡기 힘들 만큼 앞섰네. 이번 관측에서는 인정.", "평균을 크게 넘겼네. 이번 관측 범위에서 인정할게.", "이 지표는 매운맛도 할 말이 없네. 이번 관측에서는 인정."],
};

// 요약 카드 매운맛 의견의 서버 문장(비교·점검)과 모델 점검 문장은 존댓말로 만들어지므로 문장 끝만 반말로 바꾼다.
// 관측 한계와 중립 비교도 매운 코치의 반말 어미로 맞춘다.
const BANMAL_ENDINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/비슷한 수준입니다(?=[.!?]|$)/gu, "비슷한 수준이야"],
  [/보류합니다(?=[.!?]|$)/gu, "보류할게"],
  [/견주지 않습니다(?=[.!?]|$)/gu, "견주지 않을게"],
  [/확인했습니다(?=[.!?]|$)/gu, "확인했어"],
  [/돌아보(?:세요|십시오)(?=[.!?]|$)/gu, "돌아봐"],
  [/살펴보(?:세요|십시오)(?=[.!?]|$)/gu, "살펴봐"],
  [/해\s*보(?:세요|십시오)(?=[.!?]|$)/gu, "해 봐"],
  [/하(?:세요|십시오)(?=[.!?]|$)/gu, "해"],
  [/높습니다(?=[.!?]|$)/gu, "높아"],
  [/낮습니다(?=[.!?]|$)/gu, "낮아"],
  [/빠릅니다(?=[.!?]|$)/gu, "빨라"],
  [/느립니다(?=[.!?]|$)/gu, "느려"],
  [/같습니다(?=[.!?]|$)/gu, "같아"],
];

/** 요약 카드 매운맛 의견의 문장 끝을 반말로 바꾼다. 이미 반말이면 그대로라 여러 번 적용해도 같다. */
export function toSummarySpicyBanmal(text: string): string {
  return BANMAL_ENDINGS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

/**
 * 요약 카드 매운맛 한마디. 못 미친 지표가 있으면 첫 지표를 강도에 맞춰 비꼬고, 비교 지표가 모두 평균 이상이면 인정한다.
 * unfavorableMetricIds가 비고 favorable이 false면(비교 불가) null. 강도를 모르면 중간 단계를 쓴다.
 */
export function summaryCardSpicyJab(unfavorableMetricIds: readonly string[], allFavorable: boolean, seed: string, intensity: SummaryJabIntensity | null = null): string | null {
  const level = intensity ?? "mid";
  const metricId = unfavorableMetricIds.find(id => SUMMARY_METRIC_JABS[id]);
  if (metricId) return pickVariant(SUMMARY_METRIC_JABS[metricId][level], `${seed}:${metricId}`);
  return allFavorable ? pickVariant(SUMMARY_HYPES[level], seed) : null;
}

/** 강한 놀림 문장. 약한 차이에 모델이 이런 표현을 쓰면 강도 위반으로 본다. */
export const SUMMARY_STRONG_JAB_PATTERN = /관전|로비|다음\s*생|장례식|국룰|실종|소문|하이라이트|백지|빈칸|장거리\s*연애|전설|회의|퇴근|귀가|낙제|변명/u;
