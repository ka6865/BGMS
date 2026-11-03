import { SQUAD_MIN_KNOCKS, SQUAD_MIN_TRADE_KILLS } from "./squadEvidenceSamples";

// 스쿼드 AI 매운맛의 펀치라인 재료를 측정값에서 고른다.
// 순수 함수만 둔다. 측정값이 없거나 표본이 부족한 지표는 재료로 만들지 않고,
// 같은 입력이면 항상 같은 재료가 나온다. 재료의 수치는 여기서 만든 문자열을 그대로 쓴다.

export type SquadPunchlineKind = "roast" | "hype";

export interface SquadPunchline {
  id: string;
  kind: SquadPunchlineKind;
  fact: string;
  metric: string;
}

export interface SquadMemberPunchline extends SquadPunchline {
  name: string;
}

export interface SquadPunchlineMember {
  name?: unknown;
  totalKills?: unknown;
  totalDamage?: unknown;
  shares?: { damage?: unknown; kill?: unknown } | null;
}

export interface SquadPunchlineInput {
  stats?: Record<string, unknown> | null;
  scores?: Record<string, unknown> | null;
  squadGrade?: string | null;
  benchmarkStats?: Record<string, unknown> | null;
  matchesSummary?: ReadonlyArray<{ winPlace?: unknown }> | null;
  roleProfiles?: ReadonlyArray<SquadPunchlineMember> | null;
}

// 팀 재료는 최대 5개다. 한 방향(놀림·띄움)이 3개를 넘으면 반대 방향이 밀려나지 않게 막는다.
export const SQUAD_PUNCHLINE_LIMIT = 5;
export const SQUAD_PUNCHLINE_KIND_LIMIT = 3;

// 백업 속도·구조율·연막 기록의 표본 기준은 squadEvidenceSamples와 공유한다.
const MIN_TRADE_KILLS = SQUAD_MIN_TRADE_KILLS;
const MIN_KNOCKS = SQUAD_MIN_KNOCKS;
// 전체 팀 평균 대비 30% 이상 차이가 나야 놀리거나 띄운다. 작은 차이는 재료가 아니다.
const RATIO_THRESHOLD = 1.3;
// 구조 성공률 차이는 최소 5%p 이상일 때만 쓴다.
const MIN_REVIVE_RATE_GAP = 5;
// 연막 구출 성공이 3회 이상이면 띄우는 재료가 된다. 0회는 기절 5회 이상일 때만 놀린다.
const SMOKE_RESCUE_HYPE_MIN = 3;
const SMOKE_ZERO_MIN_KNOCKS = 5;
// 팀 딜 비중 차이가 40%p 이상이면 편차가 극단적인 것으로 본다(예: 73%와 27%는 46%p).
const DAMAGE_SPREAD_MIN_GAP = 40;
// 우승 0회 놀림은 최근 5경기 이상일 때만 쓴다. 최고 순위 띄움은 3위 이내일 때만 쓴다.
const WINS_ZERO_MIN_MATCHES = 5;
const BEST_RANK_HYPE_MAX = 3;
// 개인 킬 비중은 팀 킬 합이 5킬 이상일 때만 비중으로 쓴다.
const MIN_TEAM_KILLS_FOR_SHARE = 5;
// 개인 비중 기준: 최소 40%, 또는 균등 비중(100 / 인원)의 1.4배 중 큰 값을 높은 비중으로 본다.
const SHARE_HIGH_FLOOR = 40;
const SHARE_HIGH_FAIR_RATIO = 1.4;
// 개인 딜 비중이 20% 미만이거나 균등 비중의 절반 미만이면 낮은 비중으로 본다.
const DAMAGE_LOW_CEILING = 20;
const DAMAGE_LOW_FAIR_RATIO = 0.5;

type Candidate = SquadPunchline & { weight: number };

function finiteNonNegative(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}초`;
}

function formatRate(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function shareOf(value: unknown): number | null {
  const parsed = finiteNonNegative(value);
  return parsed === null || parsed > 100 ? null : parsed;
}

function measuredNames(profiles: ReadonlyArray<SquadPunchlineMember> | null | undefined) {
  return (profiles ?? [])
    .filter((profile) => typeof profile?.name === "string" && profile.name.trim() !== "")
    .map((profile) => ({ profile, name: String(profile.name) }));
}

function teamCandidates(input: SquadPunchlineInput): Candidate[] {
  const stats = input.stats ?? {};
  const benchmark = input.benchmarkStats ?? {};
  const candidates: Candidate[] = [];

  // 백업 속도: 팀 평균 트레이드 시간을 전체 팀 평균과 비교한다. 표본이 모자라면 제외한다.
  const tradeKills = finiteNonNegative(stats.totalTradeKills);
  const tradeMs = finiteNonNegative(stats.avgTradeLatency);
  const benchmarkTradeMs = finiteNonNegative(benchmark.avgTradeLatency);
  if (tradeKills !== null && tradeKills >= MIN_TRADE_KILLS && tradeMs !== null
    && benchmarkTradeMs !== null && benchmarkTradeMs > 0) {
    const text = `백업 속도 평균 ${formatSeconds(tradeMs)}, 전체 팀 평균 ${formatSeconds(benchmarkTradeMs)}`;
    if (tradeMs >= benchmarkTradeMs * RATIO_THRESHOLD) {
      candidates.push({
        id: "backup_slow", kind: "roast", metric: "avgTradeLatency",
        fact: `${text}로 평균보다 느립니다.`,
        weight: Math.min(1, (tradeMs - benchmarkTradeMs) / benchmarkTradeMs),
      });
    } else if (tradeMs * RATIO_THRESHOLD <= benchmarkTradeMs) {
      candidates.push({
        id: "backup_fast", kind: "hype", metric: "avgTradeLatency",
        fact: `${text}로 평균보다 빠릅니다.`,
        weight: Math.min(1, (benchmarkTradeMs - tradeMs) / benchmarkTradeMs),
      });
    }
  }

  // 구조 성공률: 아군 소생 수를 아군 기절 수로 나눠 전체 팀 평균 구조율과 비교한다.
  const knocks = finiteNonNegative(stats.totalTeammateKnocks);
  const revives = finiteNonNegative(stats.totalRevives);
  const benchmarkReviveRate = finiteNonNegative(benchmark.avgReviveRate);
  if (knocks !== null && knocks >= MIN_KNOCKS && revives !== null && revives <= knocks
    && benchmarkReviveRate !== null && benchmarkReviveRate > 0) {
    const rate = (revives / knocks) * 100;
    const gap = rate - benchmarkReviveRate;
    const text = `아군 기절 ${knocks}회 중 ${revives}회를 살려 구조 성공률 ${formatRate(rate)}, 전체 팀 평균 ${formatRate(benchmarkReviveRate)}`;
    if (rate >= benchmarkReviveRate * RATIO_THRESHOLD && gap >= MIN_REVIVE_RATE_GAP) {
      candidates.push({
        id: "revive_high", kind: "hype", metric: "reviveRate",
        fact: `${text}로 평균보다 높습니다.`,
        weight: Math.min(1, gap / benchmarkReviveRate),
      });
    } else if (rate * RATIO_THRESHOLD <= benchmarkReviveRate && -gap >= MIN_REVIVE_RATE_GAP) {
      candidates.push({
        id: "revive_low", kind: "roast", metric: "reviveRate",
        fact: `${text}로 평균보다 낮습니다.`,
        weight: Math.min(1, -gap / benchmarkReviveRate),
      });
    }
  }

  // 연막 구출은 성공 기록 수만 쓴다. 연막을 던진 횟수나 아낀 이유는 측정하지 않으므로 말하지 않는다.
  const smokeRescues = finiteNonNegative(stats.totalSmokeRescues);
  if (smokeRescues !== null) {
    if (smokeRescues >= SMOKE_RESCUE_HYPE_MIN) {
      candidates.push({
        id: "smoke_rescue_many", kind: "hype", metric: "smokeRescues",
        fact: `연막 구출 성공 기록이 ${smokeRescues}회입니다.`,
        weight: Math.min(1, smokeRescues / 10),
      });
    } else if (smokeRescues === 0 && knocks !== null && knocks >= SMOKE_ZERO_MIN_KNOCKS) {
      candidates.push({
        id: "smoke_rescue_zero", kind: "roast", metric: "smokeRescues",
        fact: `아군 기절 ${knocks}회 중 연막 구출 성공 기록은 0회입니다.`,
        weight: 0.3,
      });
    }
  }

  // 팀 딜 비중 편차: 개인 비중이 측정된 인원이 둘 이상일 때만 본다.
  const damageShares = measuredNames(input.roleProfiles)
    .map(({ profile, name }) => ({ name, damage: shareOf(profile.shares?.damage) }))
    .filter((entry): entry is { name: string; damage: number } => entry.damage !== null)
    .sort((a, b) => b.damage - a.damage || a.name.localeCompare(b.name));
  if (damageShares.length >= 2) {
    const top = damageShares[0];
    const bottom = damageShares[damageShares.length - 1];
    const gap = top.damage - bottom.damage;
    if (gap >= DAMAGE_SPREAD_MIN_GAP) {
      candidates.push({
        id: "damage_spread", kind: "roast", metric: "damageSpread",
        fact: `팀 딜 비중이 ${top.damage}%(${top.name})와 ${bottom.damage}%(${bottom.name})로 갈렸습니다.`,
        weight: Math.min(1, gap / 100),
      });
    }
  }

  // 순위: 요약에 포함된 경기 중 순위가 1 이상인 값만 센다.
  const placements = (input.matchesSummary ?? [])
    .map((match) => finiteNonNegative(match?.winPlace))
    .filter((place): place is number => place !== null && place >= 1 && Number.isInteger(place));
  if (placements.length > 0) {
    const matchCount = placements.length;
    const wins = placements.filter((place) => place === 1).length;
    const bestRank = Math.min(...placements);
    if (wins === 0 && matchCount >= WINS_ZERO_MIN_MATCHES) {
      candidates.push({
        id: "wins_zero", kind: "roast", metric: "wins",
        fact: `최근 ${matchCount}경기에서 우승 기록이 0회입니다.`,
        weight: 0.4,
      });
    }
    if (wins > 0) {
      candidates.push({
        id: "wins_some", kind: "hype", metric: "wins",
        fact: `최근 ${matchCount}경기에서 우승 ${wins}회를 기록했습니다.`,
        weight: Math.min(1, (wins / matchCount) * 2),
      });
    } else if (bestRank <= BEST_RANK_HYPE_MAX) {
      candidates.push({
        id: "best_rank_top", kind: "hype", metric: "bestRank",
        fact: `최근 ${matchCount}경기 중 최고 순위는 ${bestRank}위입니다.`,
        weight: 0.3,
      });
    }
  }

  // 종합 등급은 화면 카드에 이미 보이므로 농담 재료로 쓰지 않는다. 같은 말을 되풀이하면 다른 칸이 비게 된다.

  return candidates;
}

/**
 * 팀 단위 펀치라인 재료를 고른다. 가중치가 큰 순서로 상한까지 채우고, 같은 id 순서로 동점을 푼다.
 * 측정 가능한 재료가 적으면 억지로 채우지 않고 그만큼만 돌려준다.
 */
export function selectSquadPunchlines(input: SquadPunchlineInput): SquadPunchline[] {
  const candidates = teamCandidates(input)
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const picked: SquadPunchline[] = [];
  const kindCount: Record<SquadPunchlineKind, number> = { roast: 0, hype: 0 };
  for (const candidate of candidates) {
    if (picked.length >= SQUAD_PUNCHLINE_LIMIT) break;
    if (kindCount[candidate.kind] >= SQUAD_PUNCHLINE_KIND_LIMIT) continue;
    kindCount[candidate.kind] += 1;
    picked.push({ id: candidate.id, kind: candidate.kind, fact: candidate.fact, metric: candidate.metric });
  }
  return picked;
}

/**
 * 멤버별 펀치라인 재료를 고른다. 멤버마다 최대 1개이며, 개인 딜·킬 비중이 측정된 멤버는 모두 재료를 받는다.
 * 킬 비중은 팀 킬 합이 충분할 때만 쓴다. 어시스트 합은 정확한 값으로 노출되지 않아 비중 기준에 쓰지 않는다.
 */
export function selectSquadMemberPunchlines(input: Pick<SquadPunchlineInput, "roleProfiles">): SquadMemberPunchline[] {
  const members = measuredNames(input.roleProfiles);
  if (members.length === 0) return [];
  const teamKills = members.reduce((sum, { profile }) => sum + (finiteNonNegative(profile.totalKills) ?? 0), 0);
  const killSharesMeasurable = teamKills >= MIN_TEAM_KILLS_FOR_SHARE;
  const fairShare = 100 / members.length;
  const highFloor = Math.max(SHARE_HIGH_FLOOR, fairShare * SHARE_HIGH_FAIR_RATIO);
  const lowCeiling = Math.min(DAMAGE_LOW_CEILING, fairShare * DAMAGE_LOW_FAIR_RATIO);

  return members.flatMap(({ profile, name }): SquadMemberPunchline[] => {
    const damage = shareOf(profile.shares?.damage);
    const kill = killSharesMeasurable ? shareOf(profile.shares?.kill) : null;
    const make = (id: string, kind: SquadPunchlineKind, metric: string, fact: string) => ({ name, id, kind, metric, fact });

    if (damage !== null && damage < lowCeiling) {
      if (kill !== null && kill >= highFloor) {
        return [make("member_kill_log", "roast", "damageShare,killShare", `팀 딜 비중은 ${damage}%인데 팀 킬 비중은 ${kill}%입니다.`)];
      }
      return [make("member_low_damage", "roast", "damageShare", `팀 딜 비중은 ${damage}%입니다.`)];
    }
    if (damage !== null && damage >= highFloor) {
      return [make("member_damage_carry", "hype", "damageShare", `팀 딜 비중이 ${damage}%입니다.`)];
    }
    if (kill !== null && kill >= highFloor) {
      return [make("member_kill_share", "hype", "killShare", `팀 킬 비중이 ${kill}%입니다.`)];
    }
    if (damage !== null && kill !== null) {
      return [make("member_steady", "hype", "damageShare,killShare", `팀 딜 비중 ${damage}%, 팀 킬 비중 ${kill}%입니다.`)];
    }
    if (damage !== null) {
      return [make("member_steady", "hype", "damageShare", `팀 딜 비중 ${damage}%입니다.`)];
    }
    return [];
  });
}

/** 매운맛 프롬프트에 넣을 재료 블록. 재료가 없으면 빈 칸을 명시해 모델이 수치를 만들지 않게 한다. */
export function formatSquadPunchlineBlock(team: readonly SquadPunchline[], members: readonly SquadMemberPunchline[]): string {
  const teamLines = team.length > 0
    ? team.map((item) => `- [${item.kind}] ${item.id}: ${item.fact}`).join("\n")
    : "- 측정 가능한 팀 재료가 없습니다.";
  const memberLines = members.length > 0
    ? members.map((item) => `- ${item.name} [${item.kind}] ${item.id}: ${item.fact}`).join("\n")
    : "- 측정 가능한 개인 재료가 없습니다.";
  return `[PUNCHLINE FACTS]
(Only these facts and numbers may be used for jokes, exaggeration, metaphors and nicknames. Copy each number exactly.)
Team:
${teamLines}
Members:
${memberLines}`;
}
