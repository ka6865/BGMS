import { TEAMMATE_FAR_DISTANCE_M } from "./deathContext";

// 스쿼드 팀원 개인 기록. 저장된 상세 분석 결과에서 개인 단위로 셀 수 있는 값만 모은다. 순수 함수만 둔다.
// 선제 타격과 기절·사망 시점 팀원 거리는 검색한 본인 시점에서만 측정되므로 본인에게만 붙인다.

export interface SquadMemberRecords {
  // 팀에서 가장 먼저 사망한 경기 수와 비교 가능했던 경기 수. 측정할 수 없으면 null.
  firstDeaths: { count: number; matches: number } | null;
  // 검색한 본인의 선제 타격 성공·시도. 팀원에게는 붙지 않는다.
  initiative: { successes: number; attempts: number; matches: number } | null;
  // 검색한 본인이 쓰러지거나 사망한 순간 가장 가까운 생존 팀원이 멀리 있던 경기 수와 측정된 경기 수.
  farFromTeam: { count: number; measured: number } | null;
}

export interface SquadRecordMatch {
  team?: ReadonlyArray<{ name?: unknown; timeSurvived?: unknown }> | null;
  initiative_rate?: unknown;
  initiativeSampleCount?: unknown;
  deathContext?: unknown;
}

// 개인 못한 점 후보의 고정 기준이다. 다른 사람의 성적과 상관없이 같은 기록은 같은 판정을 받는다.
// 선제 타격은 성공이 시도의 절반에 못 미칠 때, 첫 사망은 비교한 경기의 40% 이상이면서 3경기 이상일 때만 후보가 된다.
export const SQUAD_INITIATIVE_MIN_ATTEMPTS = 6;
export const SQUAD_INITIATIVE_FAULT_RATE = 0.5;
export const SQUAD_FIRST_DEATH_MIN_COUNT = 3;
export const SQUAD_FIRST_DEATH_MIN_RATE = 0.4;
// 기절·사망 시점에 가장 가까운 생존 팀원이 TEAMMATE_FAR_DISTANCE_M 이상 떨어진 경기가 측정된 경기의 절반 이상이고 3경기 이상일 때 후보가 된다.
export const SQUAD_FAR_MIN_MEASURED = 3;
export const SQUAD_FAR_MIN_RATE = 0.5;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

type DeathContextSampleLike = { nearestAliveTeammateM?: unknown; aliveTeammateCount?: unknown };

/**
 * 한 경기의 기절·사망 시점 거리. 소생 가능성이 있는 기절 시점을 우선하고, 쓸 수 있는 값이 없으면 사망 시점을 쓴다.
 * 생존 팀원이 없었거나 위치 샘플이 오래돼 거리를 못 만든 경기는 측정되지 않은 경기이며 null이다.
 */
function measuredNearestM(deathContext: unknown): number | null {
  if (!deathContext || typeof deathContext !== "object") return null;
  const { atKnock, atDeath } = deathContext as { atKnock?: DeathContextSampleLike | null; atDeath?: DeathContextSampleLike | null };
  for (const sample of [atKnock, atDeath]) {
    const distance = sample?.nearestAliveTeammateM;
    const alive = sample?.aliveTeammateCount;
    if (finite(distance) && distance >= 0 && finite(alive) && alive >= 1) return distance;
  }
  return null;
}

/** 한 경기에서 가장 먼저 죽은 팀원의 키. 동시 사망이거나 측정 팀원이 2명 미만이면 null이고, 비교 불가면 undefined다. */
function firstDeathKey(
  team: ReadonlyArray<{ name?: unknown; timeSurvived?: unknown }>,
  memberKeys: ReadonlySet<string>,
  keyOf: (name: string) => string,
): string | null | undefined {
  const measured = team.flatMap(entry => {
    const key = typeof entry?.name === "string" ? keyOf(entry.name) : "";
    return memberKeys.has(key) && finite(entry.timeSurvived) && entry.timeSurvived > 0
      ? [{ key, time: entry.timeSurvived }]
      : [];
  });
  if (measured.length < 2) return undefined;
  const sorted = [...measured].sort((a, b) => a.time - b.time);
  // 모두 같은 시각까지 살아 있었다면 먼저 죽은 사람이 없다.
  if (sorted[0].time === sorted[1].time) return null;
  return sorted[0].key;
}

export function buildSquadMemberRecords(input: {
  matches: ReadonlyArray<SquadRecordMatch>;
  memberKeys: ReadonlyArray<string>;
  selfKey: string;
  keyOf: (name: string) => string;
}): Map<string, SquadMemberRecords> {
  const memberKeys = new Set(input.memberKeys);
  const firstDeathCounts = new Map<string, number>(input.memberKeys.map(key => [key, 0]));
  let comparedMatches = 0;
  let initiative = { successes: 0, attempts: 0, matches: 0 };
  let far = { count: 0, measured: 0 };

  for (const match of input.matches) {
    const first = firstDeathKey(Array.isArray(match.team) ? match.team : [], memberKeys, input.keyOf);
    if (first !== undefined) {
      comparedMatches += 1;
      if (first !== null) firstDeathCounts.set(first, (firstDeathCounts.get(first) ?? 0) + 1);
    }

    const nearestM = measuredNearestM(match.deathContext);
    if (nearestM !== null) far = { count: far.count + (nearestM >= TEAMMATE_FAR_DISTANCE_M ? 1 : 0), measured: far.measured + 1 };

    const attempts = match.initiativeSampleCount;
    const rate = match.initiative_rate;
    // 성공률이 없는 경기를 실패로 세지 않는다. 분자와 분모를 같은 경기 집합에서 센다.
    if (finite(attempts) && attempts > 0 && finite(rate) && rate >= 0 && rate <= 100) {
      initiative = {
        successes: initiative.successes + Math.round((rate / 100) * attempts),
        attempts: initiative.attempts + attempts,
        matches: initiative.matches + 1,
      };
    }
  }

  return new Map(input.memberKeys.map(key => [key, {
    firstDeaths: comparedMatches > 0 ? { count: firstDeathCounts.get(key) ?? 0, matches: comparedMatches } : null,
    initiative: key === input.selfKey && initiative.attempts > 0 ? initiative : null,
    farFromTeam: key === input.selfKey && far.measured > 0 ? far : null,
  }]));
}

export type SquadFaultTone = "mild" | "spicy";
type FaultKind = "far" | "firstDeath" | "initiative";
type FaultItem = { kind: FaultKind; text: string };

// 문장은 서버가 말투별로 쓴다. 모델은 지시해도 말투를 못 내거나 없는 기준을 만들어 넣는다.
// 매운맛의 한마디는 기록된 숫자만 놀리고 실력·의도·원인은 말하지 않으며, 같은 문장 안에 붙여 나열처럼 읽히지 않게 한다.
const FAULT_TEXT: Record<FaultKind, Record<SquadFaultTone, (a: number, b: number) => string>> = {
  far: {
    mild: (measured, count) => `기절·사망 순간 가장 가까운 생존 팀원이 ${TEAMMATE_FAR_DISTANCE_M}m 밖에 있던 경기가 측정된 ${measured}경기 중 ${count}경기입니다.`,
    spicy: (measured, count) => `기절·사망 순간 가장 가까운 생존 팀원이 ${TEAMMATE_FAR_DISTANCE_M}m 밖에 있던 경기가 측정된 ${measured}경기 중 ${count}경기, 서로 안부 묻기엔 먼 거리였습니다.`,
  },
  firstDeath: {
    mild: (matches, count) => `팀에서 가장 먼저 사망한 경기가 비교한 ${matches}경기 중 ${count}경기로 팀 최다입니다.`,
    spicy: (matches, count) => `팀에서 가장 먼저 사망한 경기가 비교한 ${matches}경기 중 ${count}경기로 팀 최다, 박수는 못 드리는 1위입니다.`,
  },
  initiative: {
    mild: (attempts, successes) => `선제 타격 시도 ${attempts}회 중 ${successes}회만 성공했습니다.`,
    spicy: (attempts, successes) => `선제 타격 ${attempts}회 시도에 ${successes}회 성공, 선제권은 아직 상대 몫이었습니다.`,
  },
};

// 조언은 후보 종류마다 하나뿐인 조건부 확인 문장이다. 기준을 새로 만들거나 원인을 말하지 않는다.
const ADVICE: Record<FaultKind, string> = {
  far: "다음 교전 전에 가장 가까운 아군의 위치를 확인해 보세요.",
  firstDeath: "다음 교전에서는 아군이 함께 사격할 수 있는지 확인한 뒤 들어가 보세요.",
  initiative: "먼저 사격할 수 있는 각도와 상대 위치를 확인해 보세요.",
};

type FaultMember = { name: string; records?: SquadMemberRecords | null };

function faultItems(members: ReadonlyArray<FaultMember>, tone: SquadFaultTone): Map<string, FaultItem[]> {
  const result = new Map<string, FaultItem[]>(members.map(member => [member.name, []]));
  const add = (name: string, kind: FaultKind, a: number, b: number) =>
    result.get(name)?.push({ kind, text: FAULT_TEXT[kind][tone](a, b) });

  // 사건 시점 거리가 가장 구체적이라 먼저 둔다. 조언은 맨 앞 후보로 쓴다.
  for (const member of members) {
    const far = member.records?.farFromTeam;
    if (far && far.measured >= SQUAD_FAR_MIN_MEASURED && far.count / far.measured >= SQUAD_FAR_MIN_RATE) {
      add(member.name, "far", far.measured, far.count);
    }
  }

  const firstDeathLeaders = members.flatMap(member => member.records?.firstDeaths ? [{ name: member.name, ...member.records.firstDeaths }] : []);
  const maxCount = Math.max(0, ...firstDeathLeaders.map(entry => entry.count));
  const leaders = firstDeathLeaders.filter(entry => entry.count === maxCount);
  if (leaders.length === 1) {
    const [leader] = leaders;
    if (leader.count >= SQUAD_FIRST_DEATH_MIN_COUNT && leader.count / leader.matches >= SQUAD_FIRST_DEATH_MIN_RATE) {
      add(leader.name, "firstDeath", leader.matches, leader.count);
    }
  }

  for (const member of members) {
    const initiative = member.records?.initiative;
    if (initiative && initiative.attempts >= SQUAD_INITIATIVE_MIN_ATTEMPTS
      && initiative.successes / initiative.attempts < SQUAD_INITIATIVE_FAULT_RATE) {
      add(member.name, "initiative", initiative.attempts, initiative.successes);
    }
  }
  return result;
}

/** 못한 점 후보 문장. 서버가 기준과 말투를 정한다. */
export function squadFaultCandidates(members: ReadonlyArray<FaultMember>, tone: SquadFaultTone = "mild"): Map<string, string[]> {
  return new Map([...faultItems(members, tone)].map(([name, items]) => [name, items.map(item => item.text)]));
}

/** 화면에 나가는 개인 못한 점과 조언. 후보가 없으면 둘 다 빈 문자열이다. */
export function squadMemberFaultFeedback(members: ReadonlyArray<FaultMember>, tone: SquadFaultTone): Map<string, { fault: string; advice: string }> {
  return new Map([...faultItems(members, tone)].map(([name, items]) => [name, {
    fault: items.map(item => item.text).join(" "),
    advice: items.length > 0 ? ADVICE[items[0].kind] : "",
  }]));
}
