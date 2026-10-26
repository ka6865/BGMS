// BGMS 경기 기여도 점수(시험판). 외부 모집단 없이 같은 경기 10명 안에서만 비교해 표본 편향을 피한다.
// 각 지표는 팀 내 비중을 그 포지션이 보통 가져가는 몫으로 나눈 값이고, 포지션별 가중치로 합친 기여도 1.0이 기대 수준이다.
export const LOL_SCORE_VERSION = "s1";

export type LolTeamLuck = "최고" | "좋음" | "보통" | "나쁨" | "최악";
export type LolParticipantScore = {
  score: number; rank: number; award?: "MVP" | "ACE"; inbun: number; teamLuck: LolTeamLuck;
};

type Metric = "kp" | "damage" | "gold" | "tank" | "objective" | "vision" | "utility" | "survival";
type Weights = Record<Metric, number>;

const W = (kp: number, damage: number, gold: number, tank: number, objective: number, vision: number, utility: number, survival: number): Weights =>
  ({ kp, damage, gold, tank, objective, vision, utility, survival });

// 초기 가중치는 사람이 정한 값이며, 표본이 쌓이면 승패 데이터로 다시 맞춘다.
const POSITION_WEIGHTS: Record<string, Weights> = {
  TOP: W(0.15, 0.20, 0.10, 0.15, 0.15, 0.05, 0, 0.20),
  JUNGLE: W(0.25, 0.10, 0.10, 0.10, 0.15, 0.10, 0, 0.20),
  MIDDLE: W(0.20, 0.25, 0.10, 0.05, 0.10, 0.05, 0.05, 0.20),
  BOTTOM: W(0.20, 0.25, 0.15, 0, 0.15, 0.05, 0, 0.20),
  UTILITY: W(0.25, 0.05, 0, 0.10, 0.05, 0.25, 0.10, 0.20),
};
type ShareMetric = Exclude<Metric, "survival">;
const S = (kp: number, damage: number, gold: number, tank: number, objective: number, vision: number, utility: number): Record<ShareMetric, number> =>
  ({ kp, damage, gold, tank, objective, vision, utility });
// 포지션별로 팀 안에서 보통 가져가는 몫. 2026-10-26 솔로·자유랭크 40경기(380명) 실측 평균을 반올림한 초기값이다.
const EXPECTED_SHARE: Record<string, Record<ShareMetric, number>> = {
  TOP: S(0.15, 0.21, 0.20, 0.29, 0.22, 0.13, 0.16),
  JUNGLE: S(0.22, 0.20, 0.21, 0.23, 0.36, 0.19, 0.17),
  MIDDLE: S(0.19, 0.25, 0.20, 0.18, 0.16, 0.13, 0.16),
  BOTTOM: S(0.21, 0.23, 0.24, 0.12, 0.22, 0.12, 0.08),
  UTILITY: S(0.23, 0.12, 0.15, 0.18, 0.04, 0.43, 0.43),
};
const EVEN_SHARE = S(0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2);
// 칼바람처럼 포지션이 없는 큐는 시야·오브젝트를 빼고 평가한다.
const ARAM_WEIGHTS = W(0.25, 0.25, 0.10, 0.15, 0, 0, 0.05, 0.20);
const CLASSIC_QUEUES = new Set([400, 420, 430, 440, 490]);
const ARAM_QUEUES = new Set([100, 450]);
const MIN_DURATION_SECONDS = 300;

const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function teamShare(own: number, total: number, expected = 0.2): number {
  // 팀 전체가 0이면 비교할 수 없으므로 기대 수준(1)으로 둔다.
  return total > 0 ? clamp(own / total / expected, 0, 2.5) : 1;
}

// 팀 내 비중은 어느 팀이든 평균이 1이라, 팀운은 나를 뺀 팀원과 상대 팀의 절대 성과(골드·피해·KDA)를 비교한다.
function luck(mates: Array<Record<string, unknown>>, enemies: Array<Record<string, unknown>>): LolTeamLuck {
  const mean = (rows: Array<Record<string, unknown>>, pick: (row: Record<string, unknown>) => number) =>
    rows.length ? rows.reduce((total, row) => total + pick(row), 0) / rows.length : 0;
  const kda = (row: Record<string, unknown>) => (num(row.kills) + num(row.assists)) / Math.max(1, num(row.deaths));
  const ratios = [
    (row: Record<string, unknown>) => num(row.goldEarned),
    (row: Record<string, unknown>) => num(row.totalDamageDealtToChampions),
    kda,
  ].map((pick) => {
    const ours = mean(mates, pick); const theirs = mean(enemies, pick);
    return ours > 0 && theirs > 0 ? Math.log(ours / theirs) : 0;
  });
  const diff = ratios.reduce((total, value) => total + value, 0) / ratios.length;
  if (diff >= 0.2) return "최고";
  if (diff >= 0.07) return "좋음";
  if (diff > -0.07) return "보통";
  if (diff > -0.2) return "나쁨";
  return "최악";
}

export function scoreLolMatch(info: { queueId?: unknown; gameDuration?: unknown; participants?: unknown }): Array<LolParticipantScore | null> {
  const participants = Array.isArray(info.participants) ? info.participants as Array<Record<string, unknown>> : [];
  const queueId = Number(info.queueId);
  const aram = ARAM_QUEUES.has(queueId);
  if (participants.length !== 10 || (!aram && !CLASSIC_QUEUES.has(queueId)) || num(info.gameDuration) < MIN_DURATION_SECONDS
    || participants.some((player) => player.gameEndedInEarlySurrender === true)) return participants.map(() => null);
  const teamOf = (player: Record<string, unknown>) => Number(player.teamId);
  const sum = (teamId: number, pick: (player: Record<string, unknown>) => number) =>
    participants.filter((player) => teamOf(player) === teamId).reduce((total, player) => total + pick(player), 0);
  const metrics = participants.map((player): Record<Metric, number> => {
    const team = teamOf(player);
    const expected = aram ? EVEN_SHARE : EXPECTED_SHARE[String(player.teamPosition)] ?? EVEN_SHARE;
    const share = (key: ShareMetric, pick: (row: Record<string, unknown>) => number) =>
      teamShare(pick(player), sum(team, pick), expected[key]);
    const utility = (row: Record<string, unknown>) =>
      num(row.totalHealsOnTeammates) + num(row.totalDamageShieldedOnTeammates) + num(row.timeCCingOthers) * 100;
    return {
      kp: share("kp", (row) => num(row.kills) + num(row.assists)),
      damage: share("damage", (row) => num(row.totalDamageDealtToChampions)),
      gold: share("gold", (row) => num(row.goldEarned)),
      // 받은 피해 자체가 아니라 실제로 경감한 피해만 탱킹으로 본다.
      tank: share("tank", (row) => num(row.damageSelfMitigated)),
      objective: share("objective", (row) => num(row.damageDealtToObjectives)),
      vision: share("vision", (row) => num(row.visionScore)),
      utility: share("utility", utility),
      // 팀 사망 중 내 몫이 적을수록 높고, 평균 몫(20%)이면 1이다.
      survival: clamp(2 - teamShare(num(player.deaths), sum(team, (row) => num(row.deaths))), 0, 2),
    };
  });
  const values = participants.map((player, index) => {
    const weights = aram ? ARAM_WEIGHTS : POSITION_WEIGHTS[String(player.teamPosition)] ?? ARAM_WEIGHTS;
    return (Object.keys(weights) as Metric[]).reduce((total, key) => total + weights[key] * metrics[index][key], 0);
  });
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value || a.index - b.index);
  const rank = new Map(order.map((entry, position) => [entry.index, position + 1]));
  const best = (win: boolean) => order.find((entry) => participants[entry.index].win === win)?.index;
  const mvp = best(true);
  const ace = best(false);
  const average = (indexes: number[]) => indexes.length ? indexes.reduce((total, index) => total + values[index], 0) / indexes.length : 0;
  return participants.map((player, index) => {
    const team = teamOf(player);
    const mates = participants.map((_, other) => other).filter((other) => teamOf(participants[other]) === team);
    const teamAverage = average(mates);
    return {
      // 기대 수준(1.0)을 5점으로 두고, 기여도 0.125 차이를 1점으로 펼쳐 0~10으로 나타낸다.
      score: Math.round(clamp(5 + (values[index] - 1) * 8, 0, 10) * 10) / 10,
      rank: rank.get(index)!,
      ...(index === mvp ? { award: "MVP" as const } : index === ace ? { award: "ACE" as const } : {}),
      inbun: Math.round((teamAverage > 0 ? values[index] / teamAverage : 1) * 100) / 100,
      teamLuck: luck(participants.filter((other, otherIndex) => teamOf(other) === team && otherIndex !== index),
        participants.filter((other) => teamOf(other) !== team)),
    };
  });
}
