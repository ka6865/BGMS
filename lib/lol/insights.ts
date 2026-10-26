import { pickLolChallenges } from "./challenges";
import type { LolPlayerMatchSummary } from "./types";

// kind와 수치 필드는 화면 시각화용이며, 값이 없으면 문자열 value로 표시한다.
export type LolInsight = {
  label: string; value: string; description: string; sampleSize?: number;
  kind?: "flag" | "compare" | "lead" | "share" | "count"; achieved?: boolean; ratio?: number; mine?: number; theirs?: number; amount?: number;
};
export type LolMatchInsights = { laning: LolInsight[]; contribution: LolInsight[]; opponentLabel?: string };
export type LolRecentTrends = { sampleSize: number; metrics: LolInsight[] };

const LANES = ["TOP", "MIDDLE", "BOTTOM"];
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): value is number => number(value) && value >= 0;
const ratio = (value: unknown): value is number => count(value) && value <= 1;
// 정글 비교 지표는 경기 원문에서만 읽고 저장용 challenges 화이트리스트(SQL과 공유)는 늘리지 않는다.
const JUNGLE_KEYS = ["enemyJungleMonsterKills", "scuttleCrabKills", "killsOnLanersEarlyJungleAsJungler", "buffsStolen"] as const;
function pickJungle(value: unknown): Partial<Record<typeof JUNGLE_KEYS[number], number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(JUNGLE_KEYS.flatMap(key => count(source[key]) ? [[key, source[key]]] : []));
}
const fmt = (value: number) => value.toLocaleString("ko-KR", { maximumFractionDigits: 1 });

export function buildLolMatchInsights(input: {
  challenges: unknown; position: string; queueId: number; duration: number | null; remake?: boolean;
  visionScore?: unknown; opponentVisionScore?: unknown; opponentChallenges?: unknown;
}): LolMatchInsights {
  const laning: LolInsight[] = []; const contribution: LolInsight[] = [];
  if (input.remake || input.duration === null || input.duration < 300) return { laning, contribution };
  const c = pickLolChallenges(input.challenges);
  const opponent = pickLolChallenges(input.opponentChallenges);
  const classic = [400, 420, 430, 440, 490].includes(input.queueId);
  const jungle = input.position === "JUNGLE";
  if (classic && (LANES.includes(input.position) || jungle)) {
    for (const [key, label] of [["laningPhaseGoldExpAdvantage", "라인전 골드·경험치"],
      ["earlyLaningPhaseGoldExpAdvantage", "초반 골드·경험치"]] as const) {
      if (c[key] === 0 || c[key] === 1) laning.push({ label, value: c[key] === 1 ? "우위 달성" : "우위 미달성", kind: "flag", achieved: c[key] === 1,
        description: `Riot의 ${label} 우위 조건을 ${c[key] === 1 ? "달성했습니다" : "달성하지 않았습니다"}.` });
    }
    if (count(c.maxCsAdvantageOnLaneOpponent)) laning.push({ label: "최대 CS 우위", value: fmt(c.maxCsAdvantageOnLaneOpponent),
      kind: "lead", amount: c.maxCsAdvantageOnLaneOpponent,
      description: `${jungle ? "상대 정글러" : "맞라이너"}보다 CS를 최대 ${fmt(c.maxCsAdvantageOnLaneOpponent)}개 앞선 기록입니다.` });
    if (count(c.maxLevelLeadLaneOpponent)) laning.push({ label: "최대 레벨 우위", value: fmt(c.maxLevelLeadLaneOpponent),
      kind: "lead", amount: c.maxLevelLeadLaneOpponent,
      description: `${jungle ? "상대 정글러" : "맞라이너"} 대비 최대 레벨 우위는 ${fmt(c.maxLevelLeadLaneOpponent)}입니다.` });
    if (!jungle && input.duration >= 600 && count(c.laneMinionsFirst10Minutes)) laning.push({ label: "10분 라인 CS", value: fmt(c.laneMinionsFirst10Minutes),
      kind: "compare", mine: c.laneMinionsFirst10Minutes, theirs: count(opponent.laneMinionsFirst10Minutes) ? opponent.laneMinionsFirst10Minutes : undefined,
      description: `첫 10분 동안 라인 미니언 ${fmt(c.laneMinionsFirst10Minutes)}개를 처치했습니다.`
        + (count(opponent.laneMinionsFirst10Minutes) ? ` 같은 포지션 상대는 ${fmt(opponent.laneMinionsFirst10Minutes)}개를 기록했습니다.` : "") });
  }
  if (classic && jungle) {
    const mine = pickJungle(input.challenges); const theirs = pickJungle(input.opponentChallenges);
    const theirCs = count(opponent.jungleCsBefore10Minutes) ? opponent.jungleCsBefore10Minutes : undefined;
    if (input.duration >= 600 && count(c.jungleCsBefore10Minutes)) laning.push({ label: "10분 정글 CS", value: fmt(c.jungleCsBefore10Minutes),
      kind: "compare", mine: c.jungleCsBefore10Minutes, theirs: theirCs,
      description: `첫 10분 동안 정글 CS ${fmt(c.jungleCsBefore10Minutes)}를 기록했습니다.`
        + (theirCs !== undefined ? ` 상대 정글러는 ${fmt(theirCs)}를 기록했습니다.` : "") });
    for (const [key, label, text] of [["enemyJungleMonsterKills", "상대 정글 몬스터", "상대 정글 몬스터 처치"],
      ["scuttleCrabKills", "바위게", "바위게 처치"], ["killsOnLanersEarlyJungleAsJungler", "초반 갱킹 처치", "초반 정글러로서 라이너 처치"]] as const) {
      const value = mine[key]; const other = theirs[key];
      if (value !== undefined) laning.push({ label, value: fmt(value), kind: "compare", mine: value, theirs: other,
        description: `${text} ${fmt(value)}회` + (other !== undefined ? `, 상대 정글러는 ${fmt(other)}회입니다.` : "입니다.") });
    }
    if (mine.buffsStolen !== undefined) contribution.push({ label: "버프 스틸", value: fmt(mine.buffsStolen), kind: "count",
      amount: mine.buffsStolen, description: `상대 버프를 가져간 횟수는 ${fmt(mine.buffsStolen)}입니다.` });
    if (count(c.epicMonsterSteals)) contribution.push({ label: "오브젝트 스틸", value: fmt(c.epicMonsterSteals), kind: "count",
      amount: c.epicMonsterSteals, description: `에픽 몬스터를 스틸한 횟수는 ${fmt(c.epicMonsterSteals)}입니다.` });
  }
  if (classic && (LANES.includes(input.position) || jungle || input.position === "UTILITY")
    && count(input.visionScore) && count(input.opponentVisionScore)) {
    const difference = input.visionScore - input.opponentVisionScore;
    laning.push({ label: "시야 점수 격차", value: `${difference > 0 ? "+" : ""}${fmt(difference)}`,
      kind: "compare", mine: input.visionScore, theirs: input.opponentVisionScore,
      description: difference === 0 ? "같은 포지션 상대와 시야 점수가 같습니다."
        : `같은 포지션 상대보다 시야 점수가 ${fmt(Math.abs(difference))}점 ${difference > 0 ? "높습니다" : "낮습니다"}.` });
  }
  for (const [key, label, subject] of [["teamDamagePercentage", "팀 내 피해 비중", "팀의 챔피언 대상 피해"],
    ["damageTakenOnTeamPercentage", "받은 피해 비중", "팀이 받은 피해"], ["killParticipation", "킬 관여율", "팀 처치"]] as const) {
    if (ratio(c[key])) contribution.push({ label, value: `${fmt(c[key] * 100)}%`, kind: "share", ratio: c[key],
      description: `${subject} 중 ${fmt(c[key] * 100)}%${key === "killParticipation" ? "에 관여했습니다" : "를 기록했습니다"}.` });
  }
  for (const [key, label, text] of [["dragonTakedowns", "드래곤", "드래곤 처치에 관여한 횟수"],
    ["baronTakedowns", "바론", "내셔 남작 처치에 관여한 횟수"], ["riftHeraldTakedowns", "전령", "협곡의 전령 처치에 관여한 횟수"],
    ["turretPlatesTaken", "포탑 방패", "획득한 포탑 방패 수"], ["saveAllyFromDeath", "아군 구출", "아군의 사망을 막은 횟수"],
    ["tookLargeDamageSurvived", "피해 후 생존", "큰 피해를 받고 생존한 횟수"],
    ["effectiveHealAndShielding", "치유·보호막", "유효 치유·보호막 합계"]] as const) {
    if (count(c[key]) && (!classic ? !["dragonTakedowns", "baronTakedowns", "riftHeraldTakedowns", "turretPlatesTaken"].includes(key) : true))
      contribution.push({ label, value: fmt(c[key]), kind: "count", amount: c[key], description: `${text}는 ${fmt(c[key])}입니다.` });
  }
  return jungle ? { laning, contribution, opponentLabel: "상대 정글러" } : { laning, contribution };
}

export function summarizeLolRecentTrends(rows: LolPlayerMatchSummary[]): LolRecentTrends | undefined {
  const valid = rows.slice(0, 100).filter(row => row.remake === false && typeof row.win === "boolean"
    && count(row.duration_seconds) && row.duration_seconds >= 300);
  if (valid.length < 3) return undefined;
  const metrics: LolInsight[] = [];
  const lane = valid.filter(row => [400, 420, 430, 440, 490].includes(row.queue_id) && LANES.includes(row.team_position ?? ""))
    .map(row => pickLolChallenges(row.challenges).laningPhaseGoldExpAdvantage).filter(value => value === 0 || value === 1);
  if (lane.length >= 3) metrics.push({ label: "라인전 우위 경기", value: `${fmt(lane.reduce<number>((sum, value) => sum + value, 0) / lane.length * 100)}%`,
    sampleSize: lane.length, description: "Riot의 라인전 골드·경험치 우위 조건을 달성한 경기 비율입니다." });
  for (const [key, label] of [["teamDamagePercentage", "평균 팀 피해 비중"], ["killParticipation", "평균 킬 관여율"]] as const) {
    const values = valid.map(row => pickLolChallenges(row.challenges)[key]).filter(ratio);
    if (values.length >= 3) metrics.push({ label, value: `${fmt(values.reduce((sum, value) => sum + value, 0) / values.length * 100)}%`,
      sampleSize: values.length, description: "값이 제공된 경기의 평균입니다." });
  }
  const vision = valid.map(row => row.vision_score).filter(count);
  if (vision.length >= 3) metrics.push({ label: "평균 시야 점수", value: fmt(vision.reduce((sum, value) => sum + value, 0) / vision.length),
    sampleSize: vision.length, description: "경기 종료 시 시야 점수의 평균입니다." });
  return metrics.length >= 3 ? { sampleSize: valid.length, metrics } : undefined;
}
