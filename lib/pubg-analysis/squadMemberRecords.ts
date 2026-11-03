// 스쿼드 팀원 개인 기록. 저장된 상세 분석 결과에서 개인 단위로 셀 수 있는 값만 모은다. 순수 함수만 둔다.
// 선제 타격은 검색한 본인 시점에서만 측정되므로 본인에게만 붙인다. 사망 시점 팀원 거리는 측정하지 않아 다루지 않는다.

export interface SquadMemberRecords {
  // 팀에서 가장 먼저 사망한 경기 수와 비교 가능했던 경기 수. 측정할 수 없으면 null.
  firstDeaths: { count: number; matches: number } | null;
  // 검색한 본인의 선제 타격 성공·시도. 팀원에게는 붙지 않는다.
  initiative: { successes: number; attempts: number; matches: number } | null;
}

export interface SquadRecordMatch {
  team?: ReadonlyArray<{ name?: unknown; timeSurvived?: unknown }> | null;
  initiative_rate?: unknown;
  initiativeSampleCount?: unknown;
}

// 개인 못한 점 후보의 고정 기준이다. 다른 사람의 성적과 상관없이 같은 기록은 같은 판정을 받는다.
// 선제 타격은 성공이 시도의 절반에 못 미칠 때, 첫 사망은 비교한 경기의 40% 이상이면서 3경기 이상일 때만 후보가 된다.
export const SQUAD_INITIATIVE_MIN_ATTEMPTS = 6;
export const SQUAD_INITIATIVE_FAULT_RATE = 0.5;
export const SQUAD_FIRST_DEATH_MIN_COUNT = 3;
export const SQUAD_FIRST_DEATH_MIN_RATE = 0.4;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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

  for (const match of input.matches) {
    const first = firstDeathKey(Array.isArray(match.team) ? match.team : [], memberKeys, input.keyOf);
    if (first !== undefined) {
      comparedMatches += 1;
      if (first !== null) firstDeathCounts.set(first, (firstDeathCounts.get(first) ?? 0) + 1);
    }

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
  }]));
}

/** 못한 점 후보 문장 재료. 서버가 기준을 정하고 모델은 문장만 다듬는다. */
export function squadFaultCandidates(
  members: ReadonlyArray<{ name: string; records?: SquadMemberRecords | null }>,
): Map<string, string[]> {
  const result = new Map<string, string[]>(members.map(member => [member.name, []]));

  const firstDeathLeaders = members.flatMap(member => member.records?.firstDeaths ? [{ name: member.name, ...member.records.firstDeaths }] : []);
  const maxCount = Math.max(0, ...firstDeathLeaders.map(entry => entry.count));
  const leaders = firstDeathLeaders.filter(entry => entry.count === maxCount);
  if (leaders.length === 1) {
    const [leader] = leaders;
    if (leader.count >= SQUAD_FIRST_DEATH_MIN_COUNT && leader.count / leader.matches >= SQUAD_FIRST_DEATH_MIN_RATE) {
      result.get(leader.name)?.push(`팀에서 가장 먼저 사망한 경기가 비교한 ${leader.matches}경기 중 ${leader.count}경기로 팀 최다입니다.`);
    }
  }

  for (const member of members) {
    const initiative = member.records?.initiative;
    if (initiative && initiative.attempts >= SQUAD_INITIATIVE_MIN_ATTEMPTS
      && initiative.successes / initiative.attempts < SQUAD_INITIATIVE_FAULT_RATE) {
      result.get(member.name)?.push(`선제 타격 시도 ${initiative.attempts}회 중 ${initiative.successes}회만 성공했습니다.`);
    }
  }
  return result;
}
