// 2D 리플레이의 아군 교전 묶음과 최근 교전 상대 계산.
// 아군이 공격자나 피해자인 피해·기절·처치 이벤트만 쓰고, 30초 넘게 끊기면 다른 교전으로 본다.

export const FIGHT_GAP_MS = 30_000;
/** 다음 교전으로 이동할 때 교전 시작보다 이만큼 앞에서 재생한다. */
export const FIGHT_LEAD_IN_MS = 3_000;
/** 이름 자동 표시에서 아군과 교전한 적으로 보는 기간. */
export const ENGAGEMENT_LABEL_WINDOW_MS = 20_000;

export type ReplayEngagement = {
  timeMs: number;
  /** 아군이 아닌 상대 이름(소문자). 환경 피해처럼 상대가 없으면 null. */
  opponent: string | null;
};

type CombatEvent = {
  type?: unknown;
  relativeTimeMs?: unknown;
  attacker?: unknown;
  victim?: unknown;
  attackerName?: unknown;
  victimName?: unknown;
};

const normalize = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/** 시간순 아군 교전 이벤트. teamNames는 대소문자를 구분하지 않는다. */
export function collectTeamEngagements(events: readonly unknown[], teamNames: readonly string[]): ReplayEngagement[] {
  const team = new Set(teamNames.map(normalize).filter(Boolean));
  const engagements: ReplayEngagement[] = [];
  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) continue;
    const event = raw as CombatEvent;
    if (!Number.isFinite(event.relativeTimeMs)) continue;
    let attacker: string;
    let victim: string;
    if (event.type === "damage") {
      attacker = normalize(event.attackerName);
      victim = normalize(event.victimName);
    } else if (event.type === "groggy" || event.type === "kill") {
      attacker = normalize(event.attacker);
      victim = normalize(event.victim);
    } else {
      continue;
    }
    const attackerIsTeam = team.has(attacker);
    const victimIsTeam = team.has(victim);
    if (!attackerIsTeam && !victimIsTeam) continue;
    const opponent = attackerIsTeam ? victim : attacker;
    engagements.push({
      timeMs: event.relativeTimeMs as number,
      opponent: opponent && !team.has(opponent) ? opponent : null,
    });
  }
  return engagements.sort((a, b) => a.timeMs - b.timeMs);
}

/** 교전 이벤트를 FIGHT_GAP_MS 공백으로 나눈 각 교전의 시작 시각. */
export function findFightStarts(engagements: readonly ReplayEngagement[]): number[] {
  const starts: number[] = [];
  let lastMs = -Infinity;
  for (const { timeMs } of engagements) {
    if (timeMs - lastMs > FIGHT_GAP_MS) starts.push(timeMs);
    lastMs = timeMs;
  }
  return starts;
}

/** 지금 보고 있는 교전 다음 교전의 재생 시작 시각. 없으면 null. */
export function nextFightSeekMs(fightStarts: readonly number[], currentTimeMs: number): number | null {
  const next = fightStarts.find((start) => start - FIGHT_LEAD_IN_MS > currentTimeMs + 500);
  return next === undefined ? null : Math.max(0, next - FIGHT_LEAD_IN_MS);
}

/** currentTimeMs 직전 ENGAGEMENT_LABEL_WINDOW_MS 동안 아군과 교전한 상대 이름. */
export function recentOpponents(engagements: readonly ReplayEngagement[], currentTimeMs: number): Set<string> {
  const from = currentTimeMs - ENGAGEMENT_LABEL_WINDOW_MS;
  let low = 0;
  let high = engagements.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (engagements[mid].timeMs < from) low = mid + 1;
    else high = mid;
  }
  const names = new Set<string>();
  for (let i = low; i < engagements.length && engagements[i].timeMs <= currentTimeMs; i++) {
    const opponent = engagements[i].opponent;
    if (opponent) names.add(opponent);
  }
  return names;
}
