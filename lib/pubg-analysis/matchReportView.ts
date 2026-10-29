// 경기 흐름·경기 전체 섹션이 쓰는 표시 문구와 킬 트리 계산. 화면 밖 테스트에서도 그대로 검증한다.
import type {
  MatchCarePackage,
  MatchDeath,
  MatchDeathType,
  MatchFightOutcome,
  MatchKill,
  MatchMyKill,
  MatchReport,
} from "./matchReport";
import type { ReplayDamageCause } from "./replayEventKinds";
import { FIGHT_LEAD_IN_MS } from "@/lib/replay/replayEngagements";

export const DEATH_TYPE_LABELS: Record<MatchDeathType, string> = {
  zone: "자기장",
  bledOut: "기절 후 사망",
  thirdParty: "써드파티",
  rotating: "이동 중 잡힘",
  ambushed: "기습 당함",
  isolated: "고립",
  outfought: "정면 교전 패배",
  other: "기타",
};

export const FIGHT_OUTCOME_LABELS: Record<MatchFightOutcome, { label: string; description: string; tone: string }> = {
  won: { label: "승리", description: "적만 쓰러졌습니다", tone: "bg-emerald-500/15 text-emerald-300" },
  traded: { label: "맞교환", description: "양쪽 모두 쓰러졌습니다", tone: "bg-amber-500/15 text-amber-300" },
  lost: { label: "패배", description: "우리 팀만 쓰러졌습니다", tone: "bg-red-500/15 text-red-300" },
  brokeOff: { label: "이탈", description: "아무도 쓰러지지 않았습니다", tone: "bg-white/10 text-gray-300" },
};

export const CARE_PACKAGE_LABELS: Record<MatchCarePackage["kind"], string> = {
  redBox: "보급 상자",
  flare: "조명탄 보급",
  blueChip: "블루칩 보급",
  small: "소형 보급",
  other: "보급",
};

export const BODY_PART_LABELS: Record<string, string> = {
  HeadShot: "머리",
  TorsoShot: "몸통",
  PelvisShot: "골반",
  ArmShot: "팔",
  LegShot: "다리",
};

export const DAMAGE_CAUSE_LABELS: Record<ReplayDamageCause, string> = {
  gun: "총기",
  grenade: "수류탄",
  explosion: "폭발",
  fire: "화염",
  zone: "자기장",
  bleed: "출혈",
  fall: "낙하",
  vehicle: "차량",
  melee: "근접",
  drown: "익사",
  other: "기타",
};

export const KNOCKED_BY_LABELS: Record<NonNullable<MatchMyKill["knockedBy"]>, string> = {
  me: "내가 기절시킨 상대",
  team: "팀원이 기절시킨 상대",
  other: "다른 팀이 기절시킨 상대",
};

/** 봇만 있는 팀을 빼고 센 우리 팀 순위. 봇 팀이 우리보다 위에 없으면 null. */
export function humanTeamPlace(report: MatchReport): number | null {
  const mine = report.teams.find((team) => team.isMine);
  if (!mine || mine.rank < 1) return null;
  const botOnlyAbove = report.teams.filter((team) => team.rank >= 1 && team.rank < mine.rank && team.players.every((player) => player.isBot)).length;
  return botOnlyAbove > 0 ? mine.rank - botOnlyAbove : null;
}

export function formatMatchClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** 사망 유형마다 근거 한 줄. 값이 없으면 유형 이름만 쓴다. */
export function describeDeath(death: MatchDeath): string {
  const parts: string[] = [DEATH_TYPE_LABELS[death.type]];
  switch (death.type) {
    case "thirdParty":
      parts.push(`최근 1분간 ${death.teamsInLastMinute}팀 교전`);
      break;
    case "rotating":
      parts.push(death.inVehicle ? "차량 이동 중" : `교전 직전 30초에 ${death.movedBeforeFightM ?? 0}m 이동`);
      break;
    case "ambushed":
      parts.push("상대가 먼저 사격");
      break;
    case "isolated":
      if (death.nearestTeammateM !== null) parts.push(`가장 가까운 팀원 ${death.nearestTeammateM}m`);
      break;
    case "bledOut":
      if (death.knockedAtMs !== null) parts.push(`${Math.round((death.timeMs - death.knockedAtMs) / 1000)}초 경과`);
      break;
    default:
      break;
  }
  if (death.distanceM !== null && death.type !== "zone" && death.type !== "bledOut") parts.push(`${death.distanceM}m`);
  return parts.join(" · ");
}

export type KillTreeNode = {
  name: string;
  teamId: number | null;
  timeMs: number | null;
  weapon: string | null;
  isBot: boolean;
  /** 기절한 채 사망해 처치가 기절시킨 선수에게 기록된 경우. */
  diedKnocked: boolean;
  children: KillTreeNode[];
};

/**
 * 마지막까지 살아남은 선수부터 "누가 누구를 잡았나"를 내려가며 묶는다.
 * 부활 뒤 다시 죽은 선수는 마지막 처치만 쓰고, 처치자가 없는 죽음(자기장 등)은 "환경" 아래로 모은다.
 */
export function buildKillTree(kills: readonly MatchKill[]): KillTreeNode[] {
  const lastKill = new Map<string, MatchKill>();
  for (const kill of [...kills].sort((a, b) => a.timeMs - b.timeMs)) lastKill.set(kill.victim.toLowerCase(), kill);
  const byKiller = new Map<string, MatchKill[]>();
  for (const kill of lastKill.values()) {
    const key = kill.killer && kill.killer.toLowerCase() !== kill.victim.toLowerCase() ? kill.killer.toLowerCase() : "";
    const list = byKiller.get(key) ?? [];
    list.push(kill);
    byKiller.set(key, list);
  }
  const teamOf = new Map<string, number | null>();
  for (const kill of kills) {
    if (kill.killer) teamOf.set(kill.killer.toLowerCase(), kill.killerTeamId);
    teamOf.set(kill.victim.toLowerCase(), kill.victimTeamId);
  }
  const displayOf = new Map<string, string>();
  for (const kill of kills) {
    if (kill.killer) displayOf.set(kill.killer.toLowerCase(), kill.killer);
    displayOf.set(kill.victim.toLowerCase(), kill.victim);
  }
  const visited = new Set<string>();
  const childrenOf = (key: string): KillTreeNode[] =>
    (byKiller.get(key) ?? [])
      .sort((a, b) => a.timeMs - b.timeMs)
      .flatMap((kill) => {
        const victimKey = kill.victim.toLowerCase();
        if (visited.has(victimKey)) return [];
        visited.add(victimKey);
        return [{
          name: kill.victim,
          teamId: kill.victimTeamId,
          timeMs: kill.timeMs,
          weapon: kill.weapon,
          isBot: kill.victimIsBot,
          diedKnocked: kill.diedKnocked === true,
          children: childrenOf(victimKey),
        }];
      });

  const survivors = [...byKiller.keys()].filter((key) => key && !lastKill.has(key));
  const roots: KillTreeNode[] = survivors
    .sort((a, b) => (byKiller.get(b)?.length ?? 0) - (byKiller.get(a)?.length ?? 0))
    .map((key) => {
      visited.add(key);
      return { name: displayOf.get(key) ?? key, teamId: teamOf.get(key) ?? null, timeMs: null, weapon: null, isBot: false, diedKnocked: false, children: childrenOf(key) };
    });
  // 처치자가 부활 뒤 다시 죽어 루트가 끊긴 경우에도 모든 처치가 한 번은 보이도록 남은 처치자를 붙인다.
  for (const key of byKiller.keys()) {
    if (!key || visited.has(key)) continue;
    visited.add(key);
    roots.push({ name: displayOf.get(key) ?? key, teamId: teamOf.get(key) ?? null, timeMs: null, weapon: null, isBot: false, diedKnocked: false, children: childrenOf(key) });
  }
  const environment = childrenOf("");
  if (environment.length > 0) {
    roots.push({ name: "환경 (자기장·사고)", teamId: null, timeMs: null, weapon: null, isBot: false, diedKnocked: false, children: environment });
  }
  return roots;
}

/** 리포트에 화면에 보여줄 내용이 있는지. 예전 분석 결과나 빈 리포트는 섹션을 숨긴다. */
export function hasMatchFlow(report: MatchReport | null | undefined): report is MatchReport {
  return !!report && (report.fights.length > 0 || report.landing !== null || report.circles.length > 0 || report.death !== null);
}

export function hasMatchOverview(report: MatchReport | null | undefined): report is MatchReport {
  return !!report && (report.teams.length > 0 || report.kills.length > 0);
}

/** 2D 리플레이를 교전 직전부터 여는 시각(초). */
export function fightReplaySeconds(startMs: number, leadInMs = FIGHT_LEAD_IN_MS): number {
  return Math.max(0, Math.floor((startMs - leadInMs) / 1000));
}
