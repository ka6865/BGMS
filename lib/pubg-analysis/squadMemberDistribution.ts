// 스쿼드 AI 평가에 줄 측정 분포 사실을 만든다. 순수 함수만 둔다.
// 개인 딜·킬·어시스트·기절 비중의 팀 내 순위와 최고·최저만 다룬다. 실력, 의도, 위치는 말하지 않는다.
// 비중은 합이 100%인 분배라 누군가는 반드시 최저가 되고 역할 차이도 반영한다. 그래서 개인 "못한 점"과 "개인 피드백"의 근거가 아니라 칭찬과 팀 분포 설명에만 쓴다.
// 개인 못한 점은 squadMemberRecords가 고정 기준으로 정한 "못한 점 후보"에서만 나온다.

import { TEAMMATE_FAR_DISTANCE_M } from "./deathContext";
import { squadFaultCandidates, type SquadMemberRecords } from "./squadMemberRecords";

export interface SquadObservationMember {
  name?: unknown;
  shares?: { damage?: unknown; kill?: unknown; assist?: unknown; dbno?: unknown } | null;
  records?: SquadMemberRecords | null;
}

export interface SquadObservationInput {
  roleProfiles?: ReadonlyArray<SquadObservationMember> | null;
  // 팀원 비중 계산에 쓴 분석 경기 수와, 함께 뛴 전체 경기 수. 둘이 다르면 머리말에 함께 적는다.
  analyzedMatchCount?: number | null;
  totalMatchCount?: number | null;
}

const METRICS = [
  { key: "damage", label: "딜" },
  { key: "kill", label: "킬" },
  { key: "assist", label: "어시스트" },
  { key: "dbno", label: "기절" },
] as const;

// 최고·최저로 지목하려면 다음 순위와 이 값(%p) 이상 벌어져야 한다. 작은 차이는 분포 설명에 쓰지 않는다.
const MIN_EXTREME_GAP = 5;
// 팀 단위 최고·최저 줄은 최고와 최저의 차이가 이 값(%p) 이상일 때만 만든다.
const MIN_TEAM_SPREAD = 10;
// 최고·최저 지목은 3명 이상일 때만 한다. 2명이면 한 쪽이 최저이자 상대의 보수라 정보가 없다.
const MIN_MEMBERS_FOR_EXTREME = 3;

function share(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

type Measured = { name: string; values: Record<(typeof METRICS)[number]["key"], number | null>; records: SquadMemberRecords | null };

function measuredMembers(input: SquadObservationInput): Measured[] {
  return (input.roleProfiles ?? []).flatMap((profile): Measured[] => {
    const name = typeof profile?.name === "string" ? profile.name.trim() : "";
    if (!name) return [];
    const values = {
      damage: share(profile.shares?.damage),
      kill: share(profile.shares?.kill),
      assist: share(profile.shares?.assist),
      dbno: share(profile.shares?.dbno),
    };
    const records = profile.records ?? null;
    return Object.values(values).some(value => value !== null) ? [{ name, values, records }] : [];
  });
}

/** 같은 값은 같은 순위로 센다. 순위는 비중이 큰 쪽이 1위다. */
function rankOf(members: Measured[], key: (typeof METRICS)[number]["key"], value: number): number {
  return 1 + members.filter(other => (other.values[key] ?? -1) > value).length;
}

/**
 * 모델에게 줄 측정 분포 블록. 비중이 측정된 팀원이 2명 미만이면 빈 문자열이다.
 * 숫자는 여기서 만든 문자열을 그대로 쓰게 하고, 순위·최고·최저는 서버가 정한다.
 */
export function buildSquadObservationBlock(input: SquadObservationInput): string {
  const members = measuredMembers(input);
  if (members.length < 2) return "";
  const extremesAllowed = members.length >= MIN_MEMBERS_FOR_EXTREME;

  const teamLines: string[] = [];
  const memberHighs = new Map<string, string[]>();
  for (const member of members) memberHighs.set(member.name, []);

  for (const { key, label } of METRICS) {
    const ranked = members
      .map(member => ({ name: member.name, value: member.values[key] }))
      .filter((entry): entry is { name: string; value: number } => entry.value !== null)
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    if (ranked.length < 2) continue;
    const top = ranked[0];
    const second = ranked[1];
    const bottom = ranked[ranked.length - 1];
    if (top.value - bottom.value >= MIN_TEAM_SPREAD) {
      teamLines.push(`- 팀 ${label} 비중은 최고 ${top.value}%(${top.name}), 최저 ${bottom.value}%(${bottom.name})로 갈렸습니다.`);
    }
    if (!extremesAllowed) continue;
    if (top.value - second.value >= MIN_EXTREME_GAP) memberHighs.get(top.name)?.push(`${label} ${top.value}%`);
  }

  const faultCandidates = squadFaultCandidates(members);
  const memberLines = members.map(member => {
    const parts = METRICS.flatMap(({ key, label }) => {
      const value = member.values[key];
      return value === null ? [] : [`${label} ${value}%(팀 ${rankOf(members, key, value)}위)`];
    });
    const highs = memberHighs.get(member.name) ?? [];
    const recordParts = [
      member.records?.firstDeaths ? `팀에서 가장 먼저 사망 ${member.records.firstDeaths.count}/${member.records.firstDeaths.matches}경기` : "",
      member.records?.initiative ? `선제 타격 ${member.records.initiative.attempts}회 중 ${member.records.initiative.successes}회 성공` : "",
      member.records?.farFromTeam ? `기절·사망 시점 가장 가까운 생존 팀원 ${TEAMMATE_FAR_DISTANCE_M}m 이상 ${member.records.farFromTeam.count}/${member.records.farFromTeam.measured}경기` : "",
    ].filter(Boolean);
    const candidates = faultCandidates.get(member.name) ?? [];
    return [
      `- ${member.name}: ${parts.join(" · ")}${highs.length ? ` [팀 최고: ${highs.join(", ")}]` : ""}`,
      recordParts.length ? `  개인 기록: ${recordParts.join(" · ")}` : "",
      ...candidates.map(text => `  못한 점 후보: ${text}`),
    ].filter(Boolean).join("\n");
  });

  const analyzed = Number(input.analyzedMatchCount);
  const total = Number(input.totalMatchCount);
  // 팀 지표는 함께 뛴 최근 경기 중 상세 분석이 가능한(14일 보관 이내, 팀 관측 있음) 경기로 계산한다. 일부가 빠졌으면 범위를 밝힌다.
  const scope = Number.isInteger(analyzed) && analyzed > 0
    ? Number.isInteger(total) && total > analyzed
      ? `함께 뛴 최근 ${total}경기 중 상세 분석이 가능한 ${analyzed}경기 기준`
      : `함께 뛴 ${analyzed}경기 기준`
    : "분석 경기 기준";

  return `[MEASURED OBSERVATIONS]
(${scope}. 기록된 비중의 분포일 뿐이며 실력, 의도, 위치, 역할 수행을 뜻하지 않습니다. 숫자는 그대로 옮깁니다.)
${teamLines.length > 0 ? `Team:\n${teamLines.join("\n")}\n` : ""}Members:
${memberLines.join("\n")}`;
}
