import type { AnalysisState, RescueEpisode } from "../types";
import { calcDist3D, normalizeName } from "../utils";

/**
 * [계산 5] Combat·Utility 핸들러가 함께 쓰는 생명 번호와 구조 사건 장부.
 *
 * - 사람 키는 accountId를 우선하고, 없으면 이름으로 알려진 accountId, 그다음 정규화 이름을 쓴다.
 * - 구조 사건 키는 victim + 생명 번호 + 기절 사건(dBNOId, 없으면 기절 시각)이다.
 * - 두 핸들러가 같은 이벤트를 각각 받아도 사건은 한 번만 열리고 한 번만 닫힌다.
 */

export function rememberIdentity(state: AnalysisState, actor: any): void {
  const name = normalizeName(actor?.name || "");
  const accountId = actor?.accountId;
  if (!name || !accountId) return;
  state.actorIdsByName.set(name, accountId);
  state.actorNamesById.set(accountId, name);
}

export function identityKey(state: AnalysisState, actor: any): string {
  const name = normalizeName(actor?.name || "");
  return actor?.accountId || state.actorIdsByName.get(name) || name;
}

export function identityName(state: AnalysisState, actor: any): string {
  return normalizeName(actor?.name || "") || state.actorNamesById.get(actor?.accountId) || actor?.accountId || "";
}

export function currentLife(state: AnalysisState, id: string): number {
  return state.actorLives.get(id) ?? 0;
}

/** 내가 살아 있고 기절하지 않은 상태인지. 상태 기록이 없으면 서 있는 것으로 본다. */
export function isMyselfStanding(state: AnalysisState): boolean {
  const status = state.playerAliveStatus.get(state.lowerNickname) ?? state.playerAliveStatus.get(state.myAccountId);
  return status !== false && status !== "groggy";
}

const validDbnoId = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function openRescueEpisode(
  state: AnalysisState,
  victim: any,
  dBNOId: unknown,
  ts: number,
  isMine: boolean,
): RescueEpisode | null {
  const victimId = identityKey(state, victim);
  if (!victimId) return null;
  const life = currentLife(state, victimId);
  const knockPart = validDbnoId(dBNOId) ? `dbno:${dBNOId}` : `ts:${ts}`;
  const key = `${victimId}:${life}:${knockPart}`;
  const existing = state.rescueEpisodes.get(key);
  if (existing) return existing;

  // 앞선 기절이 소생·사망 이벤트 없이 남아 있으면 새 기절이 그 사건을 대체한다.
  const previousKey = state.latestRescueEpisodeByVictim.get(victimId);
  const previous = previousKey ? state.rescueEpisodes.get(previousKey) : undefined;
  if (previous && previous.outcome === null) previous.outcome = "closed";

  const episode: RescueEpisode = {
    key,
    victimId,
    victimName: identityName(state, victim),
    life,
    knockTs: ts,
    isMine,
    outcome: null,
    revivedByMe: false,
    selfRevive: false,
    mySmoke: false,
    myStandingObserved: !isMine && isMyselfStanding(state),
  };
  state.rescueEpisodes.set(key, episode);
  state.latestRescueEpisodeByVictim.set(victimId, key);
  return episode;
}

/** victim의 현재 생명에서 가장 최근 구조 사건(열림·닫힘 무관). */
export function latestEpisodeForVictim(state: AnalysisState, victim: any): RescueEpisode | null {
  const victimId = identityKey(state, victim);
  if (!victimId) return null;
  const key = state.latestRescueEpisodeByVictim.get(victimId);
  const episode = key ? state.rescueEpisodes.get(key) : undefined;
  if (!episode || episode.life !== currentLife(state, victimId)) return null;
  return episode;
}

/**
 * 일반 소생(재투입이 아닌 것)을 기절 사건에 연결한다. 같은 사건의 두 번째 소생은 first=false다.
 * 팀원 자가 소생은 내 연막 구출로 세지 않는다.
 */
export function resolveRevive(
  state: AnalysisState,
  e: any,
  ts: number,
  flags: { isMeReviver: boolean; isSelfRevive: boolean },
): { episode: RescueEpisode | null; first: boolean } {
  const episode = latestEpisodeForVictim(state, e.victim);
  if (episode && episode.outcome === "revived") return { episode, first: false };
  if (!episode || episode.outcome !== null) {
    const victimId = identityKey(state, e.victim);
    const fallbackKey = `${victimId}:${currentLife(state, victimId)}:revive-ts:${ts}`;
    if (state.reviveFallbackKeys.has(fallbackKey)) return { episode: null, first: false };
    state.reviveFallbackKeys.add(fallbackKey);
    return { episode: null, first: true };
  }
  episode.outcome = "revived";
  episode.selfRevive = flags.isSelfRevive;
  episode.revivedByMe = flags.isMeReviver && !flags.isSelfRevive;
  // 소생은 서 있는 사람만 할 수 있으므로 내 소생은 그 사건의 기회 관측이다.
  if (episode.revivedByMe) episode.myStandingObserved = true;
  if (!episode.isMine && !episode.selfRevive && episode.mySmoke) state.totalSmokeRescues++;
  return { episode, first: true };
}

export function closeEpisodeForVictim(state: AnalysisState, victimId: string, outcome: "died" | "closed"): void {
  const key = state.latestRescueEpisodeByVictim.get(victimId);
  const episode = key ? state.rescueEpisodes.get(key) : undefined;
  if (episode && episode.outcome === null) episode.outcome = outcome;
}

/** 내가 다시 서게 된 순간(소생·재투입) 열린 팀원 사건에 기회 관측을 표시한다. */
export function markMyStanding(state: AnalysisState): void {
  for (const episode of state.rescueEpisodes.values()) {
    if (episode.outcome === null && !episode.isMine) episode.myStandingObserved = true;
  }
}

/**
 * 내 연막 투척을 조건(기절 후 20초 미만, 투척자와 기절 아군 100m 미만)을 만족하는
 * 열린 팀원 사건 전부에 붙인다. 새로 붙은 사건이 있으면 true.
 */
export function attachMySmoke(state: AnalysisState, myLoc: any, ts: number): boolean {
  let attached = false;
  for (const episode of state.rescueEpisodes.values()) {
    if (episode.outcome !== null || episode.isMine || episode.mySmoke) continue;
    if (ts < episode.knockTs || ts - episode.knockTs >= 20000) continue;
    const victimLoc = state.playerLocations.get(episode.victimName) ?? state.playerLocations.get(episode.victimId);
    const distanceM = victimLoc ? calcDist3D(myLoc, victimLoc) / 100 : NaN;
    if (!Number.isFinite(distanceM) || distanceM >= 100) continue;
    episode.mySmoke = true;
    // 투척은 서 있는 사람만 할 수 있다.
    episode.myStandingObserved = true;
    attached = true;
  }
  return attached;
}

export function summarizeRescueEpisodes(state: AnalysisState) {
  let rescueOpportunityCount = 0;
  let rescueCount = 0;
  let reviveWithOwnSmokeCount = 0;
  for (const episode of state.rescueEpisodes.values()) {
    if (episode.isMine || episode.selfRevive || !episode.myStandingObserved) continue;
    rescueOpportunityCount++;
    if (episode.outcome !== "revived") continue;
    if (episode.revivedByMe || episode.mySmoke) rescueCount++;
    if (episode.revivedByMe && episode.mySmoke) reviveWithOwnSmokeCount++;
  }
  return { rescueOpportunityCount, rescueCount, reviveWithOwnSmokeCount };
}
