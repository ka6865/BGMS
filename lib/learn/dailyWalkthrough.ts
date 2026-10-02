import type { DailyRankerStory } from "./dailyStories";
import type { DailyScene } from "./dailyScenes";
import type { DailyEvidence, DailyEvidenceFact } from "./dailyEvidence";
import { dailyWeaponName, type DailyEncounterAction } from "./dailyCombatStory";
import { WEAPON_NAMES } from "../pubg-analysis/constants";

export type DailyWalkthroughChapter = DailyScene & {
  brief?: { situation: string; action: string; outcome: string };
  operatingPoint?: { conditions: string; point: string; evidenceIds: string[] };
  movement?: {
    landing?: { timeSeconds: number; place?: string | null };
    phase?: number;
    revealedSeconds?: number;
    shrinkObservedSeconds?: number | null;
    insideObservedSeconds?: number | null;
    outsideMeters?: number | null;
  };
  combatZone?: {
    phase: number;
    observedSeconds: number;
    outsideMeters: number | null;
    shrinkObservedSeconds?: number;
    center?: { x: number; y: number };
    radius?: number;
  };
};

type Zone = DailyEvidence["zones"][number];
type Fact = DailyEvidenceFact;
type LifeInterval = { startSeconds: number; endSeconds: number };
type Sample = { x: number; y: number; timeSeconds: number; evidenceId: string; side?: "ally" | "opponent"; label: string; sourceIndices?: number[]; ranker?: boolean; playerId?: string; playerName?: string };
type BlueSample = { timeSeconds: number; center: { x: number; y: number }; radius: number; sourceIndex: number };

const time = (seconds: number) => String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(Math.floor(seconds % 60)).padStart(2, "0");
const distanceLabel = (meters: number) => meters >= 1000 ? (meters / 1000).toFixed(1) + "km" : Math.round(meters) + "m";
const unique = <T,>(values: T[]) => [...new Set(values)];
const validPoint = (point: { x: number; y: number }) => Number.isFinite(point.x) && Number.isFinite(point.y);
const knownWeapons = new Set(Object.values(WEAPON_NAMES));
const displayWeapon = (raw: string) => {
  if (/^BP_.*Molotov/i.test(raw)) return "화염병";
  const name = dailyWeaponName(raw);
  return knownWeapons.has(name) ? name : "무기 미확인";
};

function mapSnapshot(samples: Sample[], zone?: Zone, lifeIntervals?: LifeInterval[], splitLifePath = false): DailyScene["mapSnapshot"] {
  const ordered = samples.filter((sample) => validPoint(sample) && Number.isFinite(sample.timeSeconds)
      && (!sample.ranker || !lifeIntervals || lifeIntervals.some(({ startSeconds, endSeconds }) =>
        sample.timeSeconds >= startSeconds && sample.timeSeconds <= endSeconds)))
    .sort((a, b) => a.timeSeconds - b.timeSeconds)
    .filter((sample, index, all) => index === 0 || sample.timeSeconds !== all[index - 1].timeSeconds
      || sample.x !== all[index - 1].x || sample.y !== all[index - 1].y || sample.label !== all[index - 1].label);
  const own = ordered.filter((sample) => sample.ranker);
  if (!own.length) return undefined;
  const centerX = (Math.min(...own.map(({ x }) => x)) + Math.max(...own.map(({ x }) => x))) / 2;
  const centerY = (Math.min(...own.map(({ y }) => y)) + Math.max(...own.map(({ y }) => y))) / 2;
  const radius = zone?.center && validPoint(zone.center) && Number.isFinite(zone.radius) && zone.radius! > 0 ? zone.radius! : 0;
  const extent = Math.max(
    ...ordered.map(({ x }) => Math.abs(x - centerX)),
    ...ordered.map(({ y }) => Math.abs(y - centerY)),
    radius ? Math.abs(zone!.center!.x - centerX) + radius : 0,
    radius ? Math.abs(zone!.center!.y - centerY) + radius : 0,
    256,
  );
  const viewSize = Math.max(512, Math.ceil((extent * 2.2) / 128) * 128);
  const marks = ordered.filter((sample) => !sample.ranker && (sample.side === "opponent" || sample.side === "ally"))
    .map((sample) => ({ x: sample.x, y: sample.y, kind: sample.side === "opponent" ? "opponent" as const : "teammate" as const, label: sample.label }));
  const pathSegments = splitLifePath && lifeIntervals
    ? lifeIntervals.map(({ startSeconds, endSeconds }) => own.filter((sample) =>
      sample.timeSeconds >= startSeconds && sample.timeSeconds <= endSeconds).map(({ x, y }) => ({ x, y })))
      .filter((segment) => segment.length)
    : undefined;
  return {
    path: own.map(({ x, y }) => ({ x, y })),
    pathStartSeconds: own[0].timeSeconds,
    pathEndSeconds: own.at(-1)!.timeSeconds,
    viewSize,
    ...(pathSegments ? { pathSegments } : {}),
    observations: ordered.map(({ x, y, timeSeconds, evidenceId, side, label, sourceIndices }) =>
      ({ x, y, timeSeconds, evidenceId, side, label, sourceIndices })),
    ...(marks.length ? { marks } : {}),
    ...(zone?.center && radius ? {
      zone: { x: zone.center.x, y: zone.center.y, radius },
      zoneObservedSeconds: zone.observedSeconds,
      ...(zone.sourceIndices ? { zoneSourceIndices: zone.sourceIndices } : {}),
    } : {}),
  };
}

export function buildDailyWalkthrough(story: DailyRankerStory): {
  headline: string;
  summary: string;
  chapters: DailyWalkthroughChapter[];
  highlights?: DailyWalkthroughChapter[];
  combatScenes?: DailyWalkthroughChapter[];
  takeaways: { title: string; text: string; evidenceIds: string[] }[];
  overview?: DailyScene["mapSnapshot"];
} {
  const facts = (story.facts ?? []).filter((fact) => fact.id && Number.isFinite(fact.timeSeconds) && fact.timeSeconds >= 0)
    .sort((a, b) => a.timeSeconds - b.timeSeconds) as Fact[];
  const route = (story.route ?? []).filter((point) => Number.isFinite(point.timeSeconds) && validPoint(point)).sort((a, b) => a.timeSeconds - b.timeSeconds);
  const finds = [...(story.weaponFinds ?? [])].sort((a, b) => a.timeSeconds - b.timeSeconds);
  const encounters = story.encounters ?? [];
  const finish = facts.filter((fact) => fact.kind === "finish").sort((a, b) => a.timeSeconds - b.timeSeconds).at(-1);
  const terminalOutcomeFact = facts.find((fact) => fact.kind === "terminal_opponent_death" && fact.deathCause === "blue_zone"
    && fact.victimId && fact.sourceIndices?.length && finish?.sourceIndices?.some((index) => fact.sourceIndices!.includes(index)));
  const landing = facts.find((fact) => fact.id === "landing" && fact.kind === "landing");
  const rankerId = landing?.actorId ?? finish?.actorId;
  const rankerTeam = landing?.actorTeamId ?? finish?.actorTeamId;
  const winnerLabel = (rank: string) => story.mode === "solo" ? rank : "팀 " + rank;
  type Participant = { id?: string; names: Set<string>; side: "ally" | "opponent" };
  const participants: Participant[] = [];
  const addParticipant = (id: string | undefined, name: string | undefined, side: "ally" | "opponent") => {
    if (!name && !id) return;
    const sameId = id ? participants.find((item) => item.id === id) : undefined;
    const matchingNames = name ? participants.filter((item) => item.side === side && item.names.has(name)) : [];
    const otherNameMatches = matchingNames.filter((item) => item !== sameId);
    const unambiguousName = otherNameMatches.length === 1
      && (!otherNameMatches[0].id || !id || otherNameMatches[0].id === id) ? otherNameMatches[0] : undefined;
    let participant = sameId ?? unambiguousName;
    if (!participant) participants.push(participant = { ...(id ? { id } : {}), names: new Set(), side });
    if (id) participant.id = id;
    if (name) participant.names.add(name);
    if (sameId && unambiguousName && sameId !== unambiguousName) {
      for (const alias of unambiguousName.names) sameId.names.add(alias);
      participants.splice(participants.indexOf(unambiguousName), 1);
    }
  };
  addParticipant(rankerId, story.nickname, "ally");
  for (const player of story.roster ?? []) addParticipant(undefined, player.name, "ally");
  for (const fact of facts) {
    if (fact.actorId && (fact.actorId === rankerId || rankerTeam !== undefined && fact.actorTeamId === rankerTeam))
      addParticipant(fact.actorId, undefined, "ally");
    else if (fact.actorId && rankerTeam !== undefined && fact.actorTeamId !== undefined)
      addParticipant(fact.actorId, undefined, "opponent");
    if (fact.victimId && (fact.victimId === rankerId || rankerTeam !== undefined && fact.victimTeamId === rankerTeam))
      addParticipant(fact.victimId, undefined, "ally");
    else if (fact.victimId && rankerTeam !== undefined && fact.victimTeamId !== undefined)
      addParticipant(fact.victimId, undefined, "opponent");
  }
  for (const kill of story.teamKillEvents ?? []) {
    addParticipant(undefined, kill.killer, "ally");
    addParticipant(undefined, kill.victim, "opponent");
  }
  for (const encounter of encounters) {
    for (const player of encounter.opponentIdentity?.players ?? [])
      addParticipant(player.id, player.name, "opponent");
    for (const player of encounter.opponentIdentity?.players ?? [])
      addParticipant(player.id, player.name, "opponent");
    for (const name of [...(encounter.rosterAllies ?? []), ...(encounter.allies ?? []), ...(encounter.involvedAllies ?? [])]) {
      const identity = encounter.actions.flatMap((event) => [
        ...(event.actor === name && event.actorId ? [{ id: event.actorId }] : []),
        ...(event.victim === name && event.victimId ? [{ id: event.victimId }] : []),
      ])[0];
      addParticipant(identity?.id, name, "ally");
    }
    for (const name of encounter.opponents ?? []) {
      const identity = encounter.actions.flatMap((event) => [
        ...(event.actor === name && event.actorId ? [{ id: event.actorId }] : []),
        ...(event.victim === name && event.victimId ? [{ id: event.victimId }] : []),
      ])[0];
      addParticipant(identity?.id, name, "opponent");
    }
    for (const event of encounter.actions) {
      const actorKnown = participants.find((item) => Boolean(event.actorId && item.id === event.actorId) || item.names.has(event.actor));
      const victimKnown = participants.find((item) => Boolean(event.victimId && item.id === event.victimId) || item.names.has(event.victim));
      const actorSide = Boolean(rankerId && event.actorId === rankerId) || event.actor === story.nickname
        || rankerTeam !== undefined && event.actorTeamId === rankerTeam ? "ally"
        : rankerTeam !== undefined && event.actorTeamId !== undefined ? "opponent"
          : event.kind === "ally_down" ? "opponent" : victimKnown?.side === "ally" ? "opponent"
            : victimKnown?.side === "opponent" ? "ally" : actorKnown?.side;
      const victimSide = Boolean(rankerId && event.victimId === rankerId) || event.victim === story.nickname
        || rankerTeam !== undefined && event.victimTeamId === rankerTeam ? "ally"
        : rankerTeam !== undefined && event.victimTeamId !== undefined ? "opponent"
          : event.kind === "ally_down" ? "ally" : actorKnown?.side === "ally" ? "opponent"
            : actorKnown?.side === "opponent" ? "ally" : victimKnown?.side;
      if (!actorSide || !victimSide) continue;
      addParticipant(event.actorId, event.actor, actorSide);
      addParticipant(event.victimId, event.victim, victimSide);
    }
  }
  const rankerParticipant = participants.find((item) => Boolean(rankerId && item.id === rankerId) || item.names.has(story.nickname));
  const rosterOrder = unique(encounters.flatMap(({ rosterAllies }) => rosterAllies ?? []));
  const allies = participants.filter((item) => item.side === "ally")
    .sort((a, b) => {
      const aName = [...a.names].find((name) => rosterOrder.includes(name));
      const bName = [...b.names].find((name) => rosterOrder.includes(name));
      const aOrder = aName ? rosterOrder.indexOf(aName) : Number.MAX_SAFE_INTEGER;
      const bOrder = bName ? rosterOrder.indexOf(bName) : Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      if (a === rankerParticipant) return -1;
      if (b === rankerParticipant) return 1;
      return (a.id ?? [...a.names].sort()[0] ?? "").localeCompare(b.id ?? [...b.names].sort()[0] ?? "");
    });
  const opponents = participants.filter((item) => item.side === "opponent")
    .sort((a, b) => (a.id ?? [...a.names].sort()[0] ?? "").localeCompare(b.id ?? [...b.names].sort()[0] ?? ""));
  const aliases = new Map<Participant, string>([
    ...(rankerParticipant ? [[rankerParticipant, "본인"] as const] : []),
    ...allies.filter((item) => item !== rankerParticipant)
      .map((item, index) => [item, "팀원 " + (index + 1)] as const),
    ...opponents.map((item, index) => [item, "상대 " + (index + 1)] as const),
  ]);
  const participantLabel = (name: string, id?: string, side?: "ally" | "opponent") => {
    const named = participants.filter((item) => item.names.has(name) && (!side || item.side === side));
    const found = (id ? participants.find((item) => item.id === id) : undefined)
      ?? (named.length === 1 ? named[0] : undefined);
    return (found && aliases.get(found)) ?? (side === "ally" ? "팀원" : side === "opponent" ? "상대" : name);
  };
  const starts = [landing?.timeSeconds, ...route.map(({ timeSeconds }) => timeSeconds), ...story.killEvents.map(({ timeSeconds }) => timeSeconds),
    ...story.zones.map(({ observedSeconds }) => observedSeconds), ...finds.map(({ timeSeconds }) => timeSeconds)]
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  const matchStart = landing?.timeSeconds ?? (starts.length ? Math.min(...starts) : 0);
  const ends = [...starts, ...encounters.map(({ endSeconds }) => endSeconds), ...(story.teamKillEvents ?? []).map(({ timeSeconds }) => timeSeconds)];
  const matchEnd = Math.max(matchStart, finish?.timeSeconds ?? Math.max(matchStart, ...ends.filter(Number.isFinite)));
  const inMatch = (seconds: number) => Number.isFinite(seconds) && seconds >= matchStart && seconds <= matchEnd;
  const personalKills = story.killEvents.filter(({ timeSeconds }) => inMatch(timeSeconds)).sort((a, b) => a.timeSeconds - b.timeSeconds);
  const teamKills = (story.teamKillEvents ?? personalKills.map((kill) => ({ ...kill, killer: story.nickname })))
    .filter(({ timeSeconds }) => inMatch(timeSeconds)).sort((a, b) => a.timeSeconds - b.timeSeconds);
  const teammateKills = teamKills.filter(({ killer }) => killer !== story.nickname);
  const zones = (story.zones as Zone[]).filter(({ observedSeconds }) => inMatch(observedSeconds))
    .map((zone) => ({ ...zone, firstInsideSeconds: zone.firstInsideSeconds !== null && inMatch(zone.firstInsideSeconds)
      && zone.firstInsideSeconds >= zone.observedSeconds ? zone.firstInsideSeconds : null }))
    .sort((a, b) => a.observedSeconds - b.observedSeconds);
  const phaseShrink = (zone: Zone) => {
    const nextReveal = zones.find((next) => next.observedSeconds > zone.observedSeconds)?.observedSeconds;
    const shrink = zone.shrinkObservedSeconds;
    return shrink != null && Number.isFinite(shrink) && shrink >= zone.observedSeconds
      && (nextReveal === undefined || shrink < nextReveal) ? shrink : undefined;
  };
  const blueSamples = ((story as DailyRankerStory & { blueZoneSamples?: BlueSample[] }).blueZoneSamples ?? [])
    .filter((sample) => inMatch(sample.timeSeconds) && validPoint(sample.center)
      && Number.isFinite(sample.radius) && sample.radius > 0 && Number.isInteger(sample.sourceIndex) && sample.sourceIndex >= 0)
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
  const blueAt = (anchorSeconds: number): NonNullable<DailyScene["mapSnapshot"]>["blueZone"] => {
    const sample = blueSamples.filter(({ timeSeconds }) => timeSeconds <= anchorSeconds).at(-1);
    if (!sample || anchorSeconds - sample.timeSeconds > 20) return undefined;
    const zone = zones.filter(({ observedSeconds }) => observedSeconds <= anchorSeconds).at(-1);
    const nextReveal = zone && zones.find(({ observedSeconds }) => observedSeconds > zone.observedSeconds)?.observedSeconds;
    const previous = zone && blueSamples.filter(({ timeSeconds }) => timeSeconds >= zone.observedSeconds
      && timeSeconds < sample.timeSeconds && (nextReveal === undefined || timeSeconds < nextReveal)).at(-1);
    const targetValid = zone?.center && validPoint(zone.center) && Number.isFinite(zone.radius) && zone.radius! > 0;
    const tolerance = targetValid ? Math.max(0.05, Math.min(1, zone!.radius! * 0.005)) : 0;
    const reached = targetValid && sample.radius <= zone!.radius! + tolerance
      && Math.hypot(sample.center.x - zone!.center!.x, sample.center.y - zone!.center!.y) <= tolerance;
    const changed = previous && (previous.radius - sample.radius > 0.05
      || Math.hypot(sample.center.x - previous.center.x, sample.center.y - previous.center.y) > 0.05);
    const shrinkAt = zone?.shrinkObservedSeconds;
    const futureShrink = shrinkAt != null && shrinkAt > anchorSeconds
      && (nextReveal === undefined || shrinkAt < nextReveal);
    const status: NonNullable<NonNullable<DailyScene["mapSnapshot"]>["blueZone"]>["status"] = !targetValid ? "unknown" : reached ? "complete" : changed ? "shrinking"
      : futureShrink ? "waiting" : "unknown";
    return { x: sample.center.x, y: sample.center.y, radius: sample.radius,
      observedSeconds: sample.timeSeconds, sourceIndex: sample.sourceIndex, status,
      ...(zone ? { phase: zone.phase } : {}),
      ...(status === "waiting" && futureShrink ? { countdownSeconds: shrinkAt! - anchorSeconds } : {}),
    };
  };
  const middleZone = zones[Math.floor((zones.length - 1) / 2)];
  const lateZone = zones[Math.floor(zones.length * 0.72)];
  const lastEncounter = encounters.filter(({ startSeconds, endSeconds }) => inMatch(startSeconds) && inMatch(endSeconds))
    .sort((a, b) => a.endSeconds - b.endSeconds).at(-1);
  const lastRecordedKill = teamKills.at(-1) ?? personalKills.at(-1);
  const finishLinkedToKill = Boolean(finish && lastRecordedKill
    && finish.timeSeconds >= lastRecordedKill.timeSeconds && finish.timeSeconds - lastRecordedKill.timeSeconds <= 30
    && !facts.some((fact) => ["down", "revive", "teammate_death", "terminal_opponent_death"].includes(fact.kind)
      && fact.timeSeconds > lastRecordedKill.timeSeconds && fact.timeSeconds < finish.timeSeconds));
  const terminalDown = terminalOutcomeFact && facts.filter((fact) => fact.kind === "down" && fact.victimId === rankerId
    && fact.timeSeconds > (lastRecordedKill?.timeSeconds ?? matchStart) && fact.timeSeconds < terminalOutcomeFact.timeSeconds).at(-1);
  const ownLifeFacts = facts.filter((fact) =>
    fact.kind === "player_death" && fact.victimId === rankerId
      || fact.kind === "player_return" && fact.actorId === rankerId)
    .filter((fact) => rankerTeam === undefined
      || (fact.kind === "player_death" ? fact.victimTeamId : fact.actorTeamId) === undefined
      || (fact.kind === "player_death" ? fact.victimTeamId : fact.actorTeamId) === rankerTeam)
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
  const ownLifeCycles: { death: Fact; returned: Fact; finalDeath?: Fact }[] = [];
  let latestOwnDeath: Fact | undefined;
  let pendingOwnReturn: Fact | undefined;
  for (const fact of ownLifeFacts) {
    if (fact.kind === "player_death") {
      if (latestOwnDeath && pendingOwnReturn && fact.timeSeconds > pendingOwnReturn.timeSeconds) {
        ownLifeCycles.push({ death: latestOwnDeath, returned: pendingOwnReturn, finalDeath: fact });
        pendingOwnReturn = undefined;
      }
      latestOwnDeath = fact;
    } else if (fact.kind === "player_return" && latestOwnDeath
      && fact.timeSeconds > latestOwnDeath.timeSeconds && !pendingOwnReturn) {
      pendingOwnReturn = fact;
    }
  }
  if (latestOwnDeath && pendingOwnReturn) ownLifeCycles.push({ death: latestOwnDeath, returned: pendingOwnReturn });
  const ownLifeIntervals: LifeInterval[] = [];
  let aliveStart = matchStart;
  let alive = true;
  for (const fact of ownLifeFacts) {
    if (fact.kind === "player_death" && alive) {
      ownLifeIntervals.push({ startSeconds: aliveStart, endSeconds: fact.timeSeconds });
      alive = false;
    } else if (fact.kind === "player_return" && !alive) {
      aliveStart = fact.timeSeconds;
      alive = true;
    }
  }
  if (alive) ownLifeIntervals.push({ startSeconds: aliveStart, endSeconds: matchEnd });
  const finalAction = Math.min(lastEncounter?.startSeconds ?? Infinity, lastRecordedKill?.timeSeconds ?? Infinity);
  const finalSecondKills = lastRecordedKill ? teamKills.filter(({ timeSeconds }) => Math.floor(timeSeconds) === Math.floor(lastRecordedKill.timeSeconds)) : [];
  const simultaneousKillLabel = (kills: typeof teamKills) => {
    const groups = new Map<string, { role: string; weapon: string; count: number }>();
    for (const kill of kills) {
      const role = participantLabel(kill.killer, undefined, "ally");
      const weapon = displayWeapon(kill.weapon);
      const key = role + "|" + weapon;
      const current = groups.get(key);
      groups.set(key, { role, weapon, count: (current?.count ?? 0) + 1 });
    }
    return [...groups.values()].map(({ role, weapon, count }) => count > 1
      ? role + " " + weapon + " " + count + "킬" : role + " " + weapon + " 처치").join("·");
  };
  const milestoneTimes = [
    personalKills[0] ? personalKills[0].timeSeconds + 0.01 : undefined,
    middleZone?.observedSeconds,
    lateZone?.observedSeconds,
    Number.isFinite(finalAction) ? finalAction : undefined,
  ].filter((value): value is number => value !== undefined && value > matchStart && value < matchEnd
    && (!Number.isFinite(finalAction) || value <= finalAction))
    .sort((a, b) => a - b)
    .filter((value, index, values) => index === 0 || value - values[index - 1] > 1);
  const sortedBoundaries = unique([matchStart, ...milestoneTimes.slice(0, 4),
    ...(terminalOutcomeFact && terminalOutcomeFact.timeSeconds > matchStart && terminalOutcomeFact.timeSeconds < matchEnd
      ? [terminalOutcomeFact.timeSeconds] : []), matchEnd]).sort((a, b) => a - b);
  const boundaries = sortedBoundaries.length === 1 ? [matchStart, matchEnd] : sortedBoundaries;
  const factAt = (kind: string, seconds: number) => facts.find((fact) => fact.kind === kind && Math.abs(fact.timeSeconds - seconds) < 0.01);
  const factIdsIn = (start: number, end: number, last: boolean) => facts
    .filter(({ timeSeconds }) => timeSeconds >= start && (last ? timeSeconds <= end : timeSeconds < end)).map(({ id }) => id);
  const landingPlace = landing?.place?.trim() || null;
  const movementFor = (zone: Zone | undefined, end: number, withLanding = false): DailyWalkthroughChapter["movement"] => {
    if (!zone && !(withLanding && landing)) return undefined;
    return {
      ...(withLanding && landing ? { landing: { timeSeconds: landing.timeSeconds, place: landingPlace } } : {}),
      ...(zone && zone.observedSeconds <= end ? {
        phase: zone.phase, revealedSeconds: zone.observedSeconds, outsideMeters: zone.outsideMeters,
        ...(zone.shrinkObservedSeconds != null && Number.isFinite(zone.shrinkObservedSeconds)
          && zone.shrinkObservedSeconds >= zone.observedSeconds && zone.shrinkObservedSeconds <= end
          ? { shrinkObservedSeconds: zone.shrinkObservedSeconds } : {}),
        ...(zone.firstInsideSeconds !== null && zone.firstInsideSeconds <= end
          ? { insideObservedSeconds: zone.firstInsideSeconds } : {}),
      } : {}),
    };
  };
  const phaseSamples = (zone: Zone, start: number, end: number): Sample[] => {
    const zoneFact = factAt("zone", zone.observedSeconds);
    if (!zoneFact) return [];
    const nextReveal = zones.find((next) => next.observedSeconds > zone.observedSeconds)?.observedSeconds;
    return (zone.positions ?? []).filter((point) => validPoint(point) && inMatch(point.timeSeconds)
      && point.timeSeconds >= start && point.timeSeconds <= end
      && point.timeSeconds >= zone.observedSeconds - 15 && (nextReveal === undefined || point.timeSeconds < nextReveal))
      .map((point) => ({ ...point, evidenceId: zoneFact.id, side: "ally", ranker: true,
        label: time(point.timeSeconds) + " 본인 기록된 위치" }));
  };
  const teamLandingSamples: Sample[] = facts.filter((fact) => fact.kind === "landing" && fact.actorId && rankerId
    && fact.actorId !== rankerId && rankerTeam !== undefined && fact.actorTeamId === rankerTeam
    && fact.position && validPoint(fact.position) && inMatch(fact.timeSeconds)
    && (fact.positionTimeSeconds ?? fact.timeSeconds) === fact.timeSeconds)
    .map((fact) => ({ ...fact.position!, timeSeconds: fact.timeSeconds, evidenceId: fact.id, sourceIndices: fact.sourceIndices,
      side: "ally", ranker: false, label: time(fact.timeSeconds) + " " + participantLabel("", fact.actorId, "ally") + " 착지" }));
  const routeTeamSamples = (point: NonNullable<DailyRankerStory["route"]>[number], fact: Fact): Sample[] =>
    (point.players ?? []).filter((player) => {
      if (player.name === story.nickname || !validPoint(player) || rankerTeam === undefined) return false;
      const identities = encounters.flatMap(({ actions }) => actions.flatMap((event) => [
        ...(event.actor === player.name && event.actorId ? [{ id: event.actorId, team: event.actorTeamId }] : []),
        ...(event.victim === player.name && event.victimId ? [{ id: event.victimId, team: event.victimTeamId }] : []),
      ]));
      return identities.length > 0 && unique(identities.map(({ id }) => id)).length === 1
        && identities.every(({ id, team }) => id !== rankerId && team === rankerTeam);
    }).map((player) => ({ x: player.x, y: player.y, timeSeconds: point.timeSeconds, evidenceId: fact.id,
      sourceIndices: fact.sourceIndices, side: "ally", ranker: false, label: time(point.timeSeconds) + " " + participantLabel(player.name, undefined, "ally") + " 기록된 위치" }));

  const chapters = boundaries.slice(0, -1).map((startSeconds, index): DailyWalkthroughChapter => {
    const endSeconds = boundaries[index + 1];
    const isLast = index === boundaries.length - 2;
    const within = (seconds: number) => seconds >= startSeconds && (isLast ? seconds <= endSeconds : seconds < endSeconds);
    const chapterKills = personalKills.filter(({ timeSeconds }) => within(timeSeconds));
    const chapterTeamKills = teammateKills.filter(({ timeSeconds }) => within(timeSeconds));
    const chapterFinds = finds.filter(({ timeSeconds, player }) => within(timeSeconds) && player === story.nickname);
    const representativeFinds = unique([
      chapterFinds[0], chapterFinds.find(({ weapon }) => weapon !== chapterFinds[0]?.weapon),
      chapterFinds.find(({ source }) => source === "carepackage"),
    ].filter((find): find is NonNullable<typeof find> => Boolean(find)));
    const chapterZones = zones.filter((zone) => within(zone.observedSeconds)
      || zone.firstInsideSeconds !== null && within(zone.firstInsideSeconds));
    const chapterFacts = facts.filter(({ timeSeconds }) => within(timeSeconds));
    const revives = chapterFacts.filter(({ kind }) => kind === "revive");
    const revive = revives[0];
    const reviveDown = revive && facts.filter((fact) => fact.kind === "down" && fact.victimId === revive.victimId
      && fact.timeSeconds < revive.timeSeconds).at(-1);
    const reviveZone = revive && chapterZones.filter((zone) => zone.observedSeconds >= revive.timeSeconds
      || zone.firstInsideSeconds !== null && zone.firstInsideSeconds >= revive.timeSeconds).at(-1);
    const vehicleFacts = chapterFacts.filter(({ kind }) => kind === "vehicle");
    const chapterRoute = route.filter(({ timeSeconds }) => within(timeSeconds));
    const opening: string[] = [];
    const circle: string[] = [];
    const combat: string[] = [];
    const ending: string[] = [];
    const extraEvidence = chapterZones.flatMap((zone) => {
      const fact = factAt("zone", zone.observedSeconds);
      return fact ? [fact.id] : [];
    });

    if (index === 0 && landing && within(landing.timeSeconds)) opening.push(time(landing.timeSeconds) + " 착지했습니다.");
    const importantZones = [...chapterZones].sort((a, b) => Number((b.outsideMeters ?? 0) > 0) - Number((a.outsideMeters ?? 0) > 0))
      .slice(0, 2).sort((a, b) => a.observedSeconds - b.observedSeconds);
    const contextZone = importantZones.find((zone) => (zone.outsideMeters ?? 0) > 0) ?? importantZones.at(-1);
    for (const zone of importantZones) {
      const observed = within(zone.observedSeconds);
      const inside = zone.firstInsideSeconds !== null && within(zone.firstInsideSeconds);
      const start = observed ? time(zone.observedSeconds) + " " + zone.phase + "번째 원 공개 때 "
        + (zone.outsideMeters === null ? "위치는 확인되지 않았습니다" : zone.outsideMeters > 0
          ? "새 안전 구역까지 약 " + Math.round(zone.outsideMeters) + "m 떨어져 있었습니다" : "원 안에서 위치가 확인됐습니다") : "";
    const entry = inside && (!observed || zone.outsideMeters !== 0)
        ? time(zone.firstInsideSeconds!) + " 원 안 위치를 관측했습니다. 실제 진입 시각은 다를 수 있습니다" : "";
      circle.push([start, entry].filter(Boolean).join(". ") + ".");
    }
    const placeSample = chapterRoute.find(({ place }) => Boolean(place));
    const movement = placeSample ? time(placeSample.timeSeconds) + "에는 "
      + (placeSample.place!.toLowerCase() === "losleones" ? "Los Leones" : placeSample.place)
      + " 인근에 있었습니다." : "";
    const representativeVehicle = vehicleFacts.find((vehicle) => contextZone && vehicle.timeSeconds >= contextZone.observedSeconds
      && (contextZone.firstInsideSeconds == null || vehicle.timeSeconds <= contextZone.firstInsideSeconds)) ?? vehicleFacts[0];
    const gearAndVehicle = [
      ...representativeFinds.map(({ timeSeconds, weapon, source }) =>
        ({ timeSeconds, text: time(timeSeconds) + " " + (source === "carepackage" ? "보급품" : source === "lootbox" ? "전리품 상자" : "현장") + "에서 " + displayWeapon(weapon) + " 획득." })),
      ...(representativeVehicle ? [{ timeSeconds: representativeVehicle.timeSeconds, text: time(representativeVehicle.timeSeconds) + " " + representativeVehicle.text.replace(/ 탑승$/, "에 탔습니다") + "." }] : []),
      ...(placeSample ? [{ timeSeconds: placeSample.timeSeconds, text: movement }] : []),
    ].sort((a, b) => a.timeSeconds - b.timeSeconds).map(({ text }) => text);
    if (chapterKills.length) {
      const byWeapon = new Map<string, typeof chapterKills>();
      for (const kill of chapterKills) byWeapon.set(kill.weapon, [...(byWeapon.get(kill.weapon) ?? []), kill]);
      combat.push([...byWeapon].map(([weapon, kills]) => {
        const times = unique(kills.map(({ timeSeconds }) => time(timeSeconds)));
        const distances = kills.flatMap(({ distanceMeters }) => distanceMeters === undefined ? [] : [distanceMeters]);
        const distance = distances.length ? " · 약 " + Math.min(...distances)
          + (Math.min(...distances) === Math.max(...distances) ? "" : "–" + Math.max(...distances)) + "m" : "";
        return displayWeapon(weapon) + " " + kills.length + "킬 (" + times.join(", ") + distance + ")";
      }).join(". ") + ".");
    }
    if (chapterTeamKills.length) {
      const byKiller = new Map<string, typeof chapterTeamKills>();
      for (const kill of chapterTeamKills) {
        const killer = kill.killer || "팀원 확인 불가";
        byKiller.set(killer, [...(byKiller.get(killer) ?? []), kill]);
      }
      combat.push("팀원 킬: " + [...byKiller].map(([killer, kills]) => participantLabel(killer, undefined, "ally")
        + " " + kills.length + "킬").join(", ") + ".");
    }
    if (revives.length) combat.push(revives.map((item) => {
      const down = facts.filter((fact) => fact.kind === "down" && fact.victimId === item.victimId
        && fact.timeSeconds < item.timeSeconds).at(-1);
      const who = item.victimId === rankerId ? "본인" : participantLabel("", item.victimId, "ally");
      const actor = participantLabel("", item.actorId, "ally");
      const resumedKill = facts.find((kill) => (kill.kind === "kill" || kill.kind === "teammate_kill")
        && kill.actorId === item.victimId && kill.timeSeconds > item.timeSeconds);
      return (down ? time(down.timeSeconds) + " " + who + " 기절 → " : "") + time(item.timeSeconds)
        + " 소생 기록: " + actor + " → " + who + (resumedKill ? " · " + time(resumedKill.timeSeconds) + " 후속 킬" : "");
    }).join("\n"));
    const lifeEvents = chapterFacts.filter((fact) => ownLifeFacts.includes(fact));
    if (lifeEvents.length) combat.push(lifeEvents.map((fact) => time(fact.timeSeconds)
      + (fact.kind === "player_return" ? " 본인 재등장 기록" : " 본인 사망 기록")).join(" → "));
    const finishText = finish && within(finish.timeSeconds) ? finish.text : undefined;
    const terminalInChapter = terminalOutcomeFact && within(terminalOutcomeFact.timeSeconds) ? terminalOutcomeFact : undefined;
    const lastPersonalInChapter = chapterKills.at(-1);
    const lastTeamInChapter = chapterTeamKills.toSorted((a, b) => a.timeSeconds - b.timeSeconds).at(-1);
    const finalTeamEvent = teamKills.toSorted((a, b) => a.timeSeconds - b.timeSeconds).at(-1);
    if (isLast && finalTeamEvent && within(finalTeamEvent.timeSeconds)) {
      ending.push(finalTeamEvent.killer !== story.nickname
        ? time(finalTeamEvent.timeSeconds) + " " + participantLabel(finalTeamEvent.killer, undefined, "ally") + "의 "
          + displayWeapon(finalTeamEvent.weapon) + " 킬이 팀의 마지막 킬입니다."
        : time(finalTeamEvent.timeSeconds) + " " + displayWeapon(finalTeamEvent.weapon) + (story.mode === "solo" ? " 킬이 마지막 킬입니다." : " 개인 킬이 팀의 마지막 킬입니다."));
    } else if (isLast && lastPersonalInChapter) {
      ending.push(time(lastPersonalInChapter.timeSeconds) + " " + displayWeapon(lastPersonalInChapter.weapon) + " 킬이 마지막 개인 킬입니다.");
    } else if (isLast && lastTeamInChapter) {
      ending.push(time(lastTeamInChapter.timeSeconds) + " " + participantLabel(lastTeamInChapter.killer, undefined, "ally")
        + "의 " + displayWeapon(lastTeamInChapter.weapon) + " 킬이 있었습니다.");
    }
    if (terminalInChapter) ending.push(time(terminalInChapter.timeSeconds) + " 2위 상대 자기장 사망 기록.");
    if (finishText) ending.push(time(finish!.timeSeconds) + " " + finishText.replace("경기 종료 기록", "경기 종료") + ".");
    const throughEnd = (seconds: number) => isLast ? seconds <= endSeconds : seconds < endSeconds;
    const personalTotal = personalKills.filter(({ timeSeconds }) => throughEnd(timeSeconds)).length;
    const teammateTotal = teammateKills.filter(({ timeSeconds }) => throughEnd(timeSeconds)).length;
    const teamTotal = teamKills.filter(({ timeSeconds }) => throughEnd(timeSeconds)).length;
    const outcome = (finishText ? "경기 종료. " : "여기까지 ")
      + (story.mode === "solo" ? "총 " + personalTotal + "킬."
        : "개인 " + personalTotal + "킬, 팀 전체 " + teamTotal + "킬 (팀원 " + teammateTotal + "킬 포함).");
    const paragraphs = [
      [...opening, ...gearAndVehicle].join(" "),
      unique(circle).slice(0, 2).join(" "),
      combat.join(" "),
      ending.join(" "),
    ].filter(Boolean);
    if (!paragraphs.length) paragraphs.push("이 구간에는 위치와 행동 기록이 남아 있지 않습니다.");

    const samples: Sample[] = [];
    const encounterSnapshotSourceIndices = new Set<number>();
    samples.push(...teamLandingSamples.filter(({ timeSeconds }) => within(timeSeconds)));
    if (landing && within(landing.timeSeconds) && landing.position && validPoint(landing.position)) {
      samples.push({ ...landing.position, timeSeconds: landing.positionTimeSeconds ?? landing.timeSeconds, evidenceId: landing.id,
        side: "ally", ranker: true, label: time(landing.positionTimeSeconds ?? landing.timeSeconds) + " 착지 기록된 위치" });
    }
    for (const point of chapterRoute) {
      const fact = factAt("route", point.timeSeconds);
      if (fact) samples.push({ x: point.x, y: point.y, timeSeconds: point.timeSeconds, evidenceId: fact.id,
        side: "ally", ranker: true, label: time(point.timeSeconds) + " 기록된 위치" });
      if (fact) samples.push(...routeTeamSamples(point, fact));
    }
    for (const encounter of encounters) {
      const fact = facts.find(({ id, kind }) => id === encounter.id && kind === "encounter");
      if (!fact) continue;
      const snapshot = encounter.snapshots?.find(({ offsetSeconds }) => offsetSeconds === 0);
      if (!snapshot || !within(snapshot.targetTimeSeconds)) continue;
      for (const point of snapshot.points) {
        if (!inMatch(point.sampleTimeSeconds)) continue;
        for (const sourceIndex of point.sourceIndices ?? []) encounterSnapshotSourceIndices.add(sourceIndex);
        const ageLabel = point.ageSeconds > 0 ? ` · 기준보다 ${Math.round(point.ageSeconds)}초 ${point.sampleTimeSeconds <= snapshot.targetTimeSeconds ? "전" : "후"} 표본` : "";
        samples.push({ x: point.x / 100, y: point.y / 100, timeSeconds: point.sampleTimeSeconds, evidenceId: fact.id,
          side: point.side, ranker: point.player === story.nickname, playerId: point.playerId, playerName: point.player,
          label: time(point.sampleTimeSeconds) + " " + participantLabel(point.player, point.playerId, point.side) + " 관측 위치" + ageLabel,
          sourceIndices: point.sourceIndices });
      }
    }
    for (const zone of zones) samples.push(...phaseSamples(zone, startSeconds, endSeconds).filter(({ timeSeconds }) => within(timeSeconds)));
    const temporalZone = zones.filter(({ observedSeconds }) => throughEnd(observedSeconds))
      .sort((a, b) => b.observedSeconds - a.observedSeconds)[0];
    const snapshot = mapSnapshot(samples.filter(({ timeSeconds, sourceIndices }) => inMatch(timeSeconds)
      && (within(timeSeconds) || sourceIndices?.some((sourceIndex) => encounterSnapshotSourceIndices.has(sourceIndex)))), temporalZone,
    ownLifeIntervals, ownLifeFacts.length > 0);
    const evidenceIds = unique([...factIdsIn(startSeconds, endSeconds, isLast), ...extraEvidence,
      ...(snapshot?.observations?.map(({ evidenceId }) => evidenceId) ?? []),
      ...(temporalZone ? [factAt("zone", temporalZone.observedSeconds)?.id].filter((id): id is string => Boolean(id)) : [])]);
    const firstKillAtStart = personalKills[0] && personalKills[0].timeSeconds >= startSeconds && personalKills[0].timeSeconds < endSeconds;
    const finalRank = finishText?.match(/\d+위/)?.[0];
    const finalWeaponLabel = finalTeamEvent ? displayWeapon(finalTeamEvent.weapon)
      : lastPersonalInChapter ? displayWeapon(lastPersonalInChapter.weapon) : undefined;
    const chapterTitle = finishText && terminalInChapter
      ? "우승 직전"
      : finishText && !finishLinkedToKill ? "경기 종료 결과"
      : finishText
      ? finalSecondKills.length > 1 ? "마지막 교전 이후 " + (finalRank ?? "경기 종료")
        : (finalTeamEvent?.killer !== story.nickname && finalTeamEvent?.killer
          ? participantLabel(finalTeamEvent.killer, undefined, "ally") + "의 " : "")
        + (finalWeaponLabel === "무기 미확인" ? "마지막 교전과 " : finalWeaponLabel ? finalWeaponLabel + " 킬 이후 " : "")
        + (finalRank ?? "경기 종료")
      : lastEncounter && within(lastEncounter.startSeconds) && lastEncounter.endSeconds >= finalAction ? "마지막 교전"
      : index === 0 ? "착지와 초반 준비"
        : firstKillAtStart ? "첫 킬과 다음 이동"
          : chapterFinds.some(({ source }) => source === "carepackage") ? "후반 원과 보급 무기"
            : revive ? (reviveZone ? reviveZone.phase + "번째 원 · " : "") + time(revive.timeSeconds)
              + (rankerId && reviveDown?.victimId === rankerId ? " 본인 소생" : " 팀원 소생")
              : contextZone ? contextZone.phase + "번째 원 이동"
                : chapterKills.length || chapterTeamKills.length ? "교전과 다음 이동" : time(startSeconds) + " 이후 기록";
    const closingKill = isLast && lastRecordedKill && within(lastRecordedKill.timeSeconds) ? lastRecordedKill : undefined;
    const closingActor = closingKill && "killer" in closingKill ? closingKill.killer : story.nickname;
    const closingActorId = closingKill && lastEncounter?.actions.find((event) => event.kind === "kill"
      && event.actor === closingActor && event.victim === closingKill.victim && event.timeSeconds === closingKill.timeSeconds)?.actorId;
    const firstHit = closingKill ? lastEncounter?.actions.find((event) => event.kind === "first_hit"
      && event.actor === closingActor && event.victim === closingKill.victim && within(event.timeSeconds) && event.timeSeconds <= closingKill.timeSeconds) : undefined;
    const insideZones = chapterZones.filter((zone) => (zone.outsideMeters ?? 0) > 0
      && zone.firstInsideSeconds !== null && within(zone.firstInsideSeconds));
    const insideZone = insideZones.find((zone) => zone.phase === contextZone?.phase) ?? insideZones.at(-1);
    const chapterDelta = "개인 " + chapterKills.length + "킬"
      + (story.mode === "solo" ? "" : " · 팀원 " + chapterTeamKills.length + "킬");
    const revivePeople = revive?.actorId && revive.victimId
      ? participantLabel("", revive.actorId, "ally") + " → " + participantLabel("", revive.victimId, "ally") : undefined;
    const [reviveActor, reviveRecipient] = (revivePeople ?? "팀원 → 팀원").split(" → ");
    const gear = representativeFinds.find(({ source }) => source === "carepackage") ?? representativeFinds[0];
    const combatDistance = firstHit?.distanceMeters ?? (closingKill && "distanceMeters" in closingKill ? closingKill.distanceMeters : undefined)
      ?? (closingActor === story.nickname ? lastPersonalInChapter?.distanceMeters : undefined);
    const preparation = gear?.source === "carepackage" ? time(gear.timeSeconds) + " " + displayWeapon(gear.weapon) + " 획득"
      : representativeVehicle && (contextZone?.outsideMeters ?? 0) > 0
        && (contextZone?.firstInsideSeconds == null || representativeVehicle.timeSeconds <= contextZone.firstInsideSeconds) ? time(representativeVehicle.timeSeconds) + " " + representativeVehicle.text : "";
    const finalActionBrief = isLast && finalSecondKills.length > 1
      ? time(finalSecondKills[0].timeSeconds) + " " + simultaneousKillLabel(finalSecondKills)
      : undefined;
    const brief = {
      situation: closingKill && combatDistance !== undefined && combatDistance !== null
        ? (firstHit?.distanceMeters !== null && firstHit?.distanceMeters !== undefined ? "피해를 준 거리 약 " : "마지막 킬 거리 약 ") + distanceLabel(combatDistance)
        : gear?.source === "carepackage" ? time(gear.timeSeconds) + " 보급품에서 " + displayWeapon(gear.weapon) + " 획득"
        : reviveDown ? time(reviveDown.timeSeconds) + " " + (reviveDown.victimId === rankerId
          ? "본인" : participantLabel("", reviveDown.victimId, "ally")) + " 기절"
        : index === 0 && landing && contextZone ? time(landing.timeSeconds) + " 착지 · " + time(contextZone.observedSeconds)
          + " " + contextZone.phase + "번째 원 " + (contextZone.outsideMeters === null ? "위치 미확인"
            : contextZone.outsideMeters > 0 ? distanceLabel(contextZone.outsideMeters) + " 밖" : "원 안")
        : contextZone ? time(contextZone.observedSeconds) + " " + contextZone.phase + "번째 원 · "
          + (contextZone.outsideMeters === null ? "위치 미확인" : contextZone.outsideMeters > 0
            ? "안전 구역까지 약 " + distanceLabel(contextZone.outsideMeters) : "원 안 위치 확인")
          : chapterKills.length || chapterTeamKills.length ? "이 구간의 교전"
            : landing && within(landing.timeSeconds) ? time(landing.timeSeconds) + " 착지" : "이 구간의 이동과 준비",
      action: terminalInChapter
        ? [terminalDown ? time(terminalDown.timeSeconds) + " 본인 기절" : "",
          time(terminalInChapter.timeSeconds) + " 2위 상대 자기장 사망",
          time(finish!.timeSeconds) + " " + winnerLabel(finalRank ?? "1위")].filter(Boolean).join(" · ")
        : finalActionBrief ?? (closingKill
        ? (firstHit ? time(firstHit.timeSeconds) + " " + participantLabel(firstHit.actor, firstHit.actorId, "ally")
          + " " + displayWeapon(firstHit.weapon) + " 피해 → " : "")
          + time(closingKill.timeSeconds) + " " + participantLabel(String(closingActor), closingActorId, "ally") + " "
          + displayWeapon(closingKill.weapon) + " 마지막 킬"
        : revive ? time(revive.timeSeconds) + " 소생 기록: " + reviveActor + " → " + reviveRecipient
          : chapterKills.length || chapterTeamKills.length ? (preparation ? preparation + " · " : "") + "이 구간 " + chapterDelta
            : representativeVehicle ? time(representativeVehicle.timeSeconds) + " " + representativeVehicle.text
              : gear ? time(gear.timeSeconds) + " " + displayWeapon(gear.weapon) + " 획득"
                : insideZone ? time(insideZone.firstInsideSeconds!) + " 원 안에서 첫 위치 확인" : "이 구간은 기록 없음"),
      outcome: finishText ? time(finish!.timeSeconds) + " 경기 종료 · "
        + (story.mode === "solo" ? personalTotal + "킬" : "개인 " + personalTotal + "킬 · 팀 " + teamTotal + "킬")
        + (finalRank ? " " + finalRank : "")
        : reviveZone ? time(reviveZone.observedSeconds) + " " + reviveZone.phase + "번째 원 공개"
          + (reviveZone.firstInsideSeconds !== null && within(reviveZone.firstInsideSeconds)
            ? " · " + time(reviveZone.firstInsideSeconds) + " 원 안 확인" : "")
          : revive && (chapterKills.length || chapterTeamKills.length) ? "이 구간 합계: " + chapterDelta
          : insideZone && (!preparation || insideZone.firstInsideSeconds! >= (gear?.source === "carepackage" ? gear.timeSeconds : representativeVehicle!.timeSeconds))
            ? time(insideZone.firstInsideSeconds!) + " " + insideZone.phase + "번째 원 안에서 첫 위치 확인"
            : chapterKills.length || chapterTeamKills.length ? "누적 " + (story.mode === "solo" ? personalTotal + "킬"
              : "개인 " + personalTotal + "킬 · 팀 " + teamTotal + "킬")
              : chapterZones.some(({ outsideMeters }) => outsideMeters === 0)
                ? time(chapterZones.filter(({ outsideMeters }) => outsideMeters === 0).at(-1)!.observedSeconds) + " 원 안 위치 확인"
                : chapterZones.length ? "다음 원 안 위치는 아직 확인되지 않음" : "이 구간에는 원 변화 기록 없음",
    };
    return {
      brief,
      movement: movementFor(contextZone, endSeconds, index === 0),
      id: "walkthrough-" + (index + 1),
      kind: finishText ? "finish" : index === 0 ? "opening"
        : chapterKills.length || chapterTeamKills.length || encounters.some(({ startSeconds }) => within(startSeconds)) ? "combat" : "movement",
      title: chapterTitle,
      startSeconds,
      anchorSeconds: startSeconds,
      endSeconds,
      evidenceIds,
      situation: [
        ...chapterZones.filter((zone) => zone.outsideMeters === 0 && within(zone.observedSeconds))
          .map((zone) => time(zone.observedSeconds) + " " + zone.phase + "번째 원 공개 · 원 안 위치 확인"),
        ...chapterZones.filter((zone) => zone.outsideMeters !== 0).map((zone) => within(zone.observedSeconds)
          ? time(zone.observedSeconds) + " " + zone.phase + "번째 원 공개 · " + (zone.outsideMeters === null ? "위치 미확인" : zone.outsideMeters > 0 ? "새 안전 구역까지 약 " + Math.round(zone.outsideMeters) + "m" : "원 안 위치 확인")
          : time(zone.firstInsideSeconds!) + " " + zone.phase + "번째 원 안에서 첫 위치 확인"),
        ...representativeFinds.map(({ timeSeconds, weapon }) => time(timeSeconds) + " " + displayWeapon(weapon) + " 획득"),
        ...chapterKills.slice(0, 1).map(({ timeSeconds, weapon }) => time(timeSeconds) + " " + displayWeapon(weapon) + " 처치"),
        ...(revives.slice(0, 1).map(({ timeSeconds }) => time(timeSeconds) + " 팀원 살리기")),
      ].slice(0, 2).sort().join(" · ") || (time(startSeconds) + "–" + time(endSeconds) + " " + chapterTitle),
      action: paragraphs.join("\n\n"),
      outcome,
      ...(snapshot ? { mapSnapshot: snapshot } : {}),
    };
  });

  const firstKill = personalKills[0];
  const lastPersonalKill = personalKills.at(-1);
  const lastTeamKill = teamKills.toSorted((a, b) => a.timeSeconds - b.timeSeconds).at(-1);
  const finalWeapon = lastTeamKill?.weapon ?? lastPersonalKill?.weapon;
  const finishLabel = finish?.text.match(/\d+위/)?.[0];
  const firstZone = zones.find(({ outsideMeters }) => outsideMeters !== null && outsideMeters > 0);
  const finalWeaponLabel = finalWeapon ? displayWeapon(finalWeapon) : undefined;
  const headline = story.mapName + " · " + (terminalOutcomeFact && finish
    ? time(terminalOutcomeFact.timeSeconds) + " 2위 상대 자기장 사망 · " + time(finish.timeSeconds) + " " + winnerLabel(finishLabel ?? "1위")
    : finalSecondKills.length > 1
    ? "마지막 교전에서 " + finalSecondKills.length + "명 처치 후 " + (finishLabel ?? "경기 종료")
    : firstZone?.phase === 1 && firstZone.firstInsideSeconds !== null
    ? "첫 원 이동부터 " + (finalWeaponLabel === "무기 미확인" ? "마지막 교전까지" : finalWeaponLabel ? finalWeaponLabel + " 킬까지" : "경기 종료까지")
    : (finalWeaponLabel === "무기 미확인" ? "마지막 교전" : finalWeaponLabel ? finalWeaponLabel + " 킬 이후" : "경기 기록") + (finishLabel ? " " + finishLabel : ""));
  const carepackage = finds.find(({ source, player, timeSeconds }) => source === "carepackage" && player === story.nickname && inMatch(timeSeconds));
  const summary: string[] = [];
  if (firstZone) {
    const opening = firstZone.phase + "번째 원 공개 때 안전 구역에서 약 " + distanceLabel(firstZone.outsideMeters!) + " 떨어져";
    if (story.mode !== "solo" && firstZone.firstInsideSeconds !== null) {
      const earlyKills = teamKills.filter(({ timeSeconds }) => timeSeconds >= firstZone.observedSeconds
        && timeSeconds < firstZone.firstInsideSeconds!).length;
      const earlyFight = encounters.flatMap(({ actions }) => actions.filter((event) =>
        (event.kind === "first_hit" || event.kind === "knock" || event.kind === "kill")
        && event.timeSeconds >= firstZone.observedSeconds && event.timeSeconds < firstZone.firstInsideSeconds!))
        .sort((a, b) => a.timeSeconds - b.timeSeconds)[0];
      summary.push(earlyKills && earlyFight
        ? opening + " 있었고, 원 안 위치 관측 전 초반 교전에서 팀 " + earlyKills + "킬을 기록했습니다."
        : opening + (firstZone.firstInsideSeconds !== null ? " 있었고 이후 원 안 위치가 관측됐습니다." : " 있었습니다."));
    } else summary.push(opening + (firstZone.firstInsideSeconds !== null ? " 있었고 이후 원 안 위치가 관측됐습니다." : " 있었습니다."));
  } else if (firstKill) summary.push("첫 킬은 " + displayWeapon(firstKill.weapon) + "으로 기록됐습니다.");
  if (ownLifeCycles.length) {
    const lifeText = ownLifeCycles.map(({ death, returned, finalDeath }) => time(death.timeSeconds)
      + "에 사망한 뒤 " + time(returned.timeSeconds) + "에 재등장"
      + (finalDeath ? "했고, " + time(finalDeath.timeSeconds) + "에 다시 사망했습니다" : "했습니다"));
    summary.push("본인은 " + lifeText.join("; ") + ".");
  }
  const recoveryPairs = facts.filter((fact) => fact.kind === "revive" && fact.victimId && inMatch(fact.timeSeconds))
    .map((revive) => ({ revive, down: facts.filter((fact) => fact.kind === "down" && fact.victimId === revive.victimId
      && fact.timeSeconds < revive.timeSeconds).at(-1) }))
    .filter((pair) => pair.down && (!terminalOutcomeFact || pair.revive.timeSeconds < terminalOutcomeFact.timeSeconds))
    .sort((a, b) => Number(b.revive.victimId === rankerId) - Number(a.revive.victimId === rankerId)
      || b.revive.timeSeconds - a.revive.timeSeconds);
  const selfRecoveryCount = recoveryPairs.filter(({ revive }) => revive.victimId === rankerId).length;
  const teammateRecoveryCount = recoveryPairs.length - selfRecoveryCount;
  const hasPostReviveKill = recoveryPairs.some(({ revive }) => facts.some((fact) =>
    (fact.kind === "kill" || fact.kind === "teammate_kill") && fact.actorId === revive.victimId
      && fact.timeSeconds > revive.timeSeconds));
  if (terminalDown || recoveryPairs.length) {
    const recoverySentence = terminalDown
      ? (teammateRecoveryCount ? "후반 팀원 소생과 본인 기절도 기록됐고" : "후반 본인 기절이 기록됐고")
      : selfRecoveryCount > 1 ? "본인은 두 번 기절했지만 팀원이 모두 살렸고"
        : selfRecoveryCount ? "본인은 기절 후 소생됐고"
          : "팀원이 기절 후 소생됐고";
    summary.push(recoverySentence + (hasPostReviveKill ? ", 이후에도 킬을 올렸습니다."
      : terminalDown && terminalOutcomeFact ? "," : "."));
  }
  const finalKill = lastTeamKill ?? lastPersonalKill;
  if (terminalOutcomeFact && finish) {
    const lastLifeDeath = ownLifeCycles.flatMap(({ finalDeath }) => finalDeath ? [finalDeath.timeSeconds] : []).at(-1);
    const interveningTeamKill = lastLifeDeath === undefined ? undefined : teamKills.filter(({ timeSeconds }) =>
      timeSeconds > lastLifeDeath && timeSeconds < terminalOutcomeFact.timeSeconds).at(-1);
    summary.push(ownLifeCycles.length
      ? (interveningTeamKill ? time(interveningTeamKill.timeSeconds) + " 팀 킬 기록이 있었고, " : "")
        + time(terminalOutcomeFact.timeSeconds) + " 2위 상대가 자기장으로 사망한 뒤 " + time(finish.timeSeconds) + " "
        + winnerLabel(finishLabel ?? "1위") + "로 경기를 마쳤습니다."
      : "2위 상대가 자기장으로 사망한 뒤 " + winnerLabel(finishLabel ?? "1위") + "로 경기를 마쳤습니다.");
  } else if (finish && finishLinkedToKill && finalKill) {
    const finalVictims = unique(finalSecondKills.map(({ victim }) => victim));
    const finalWeapons = unique(finalSecondKills.map(({ weapon }) => displayWeapon(weapon)).filter((weapon) => weapon !== "무기 미확인"));
    const result = winnerLabel(finishLabel ?? "경기 종료");
    summary.push(finalVictims.length === 2 && finalWeapons.length
      ? "마지막 두 상대 처치 무기는 " + finalWeapons.join("·") + ", 경기 결과는 " + result + "입니다."
      : "마지막 킬 직후 경기 종료 결과는 " + result + "입니다.");
  } else if (finish) summary.push("경기 종료 결과는 " + winnerLabel(finishLabel ?? "경기 종료") + "입니다.");
  else if (finalKill) summary.push("마지막 처치 무기는 " + (finalWeaponLabel === "무기 미확인" ? "확인 불가" : finalWeaponLabel ?? "확인 불가") + "입니다.");

  const takeaways: { title: string; text: string; evidenceIds: string[] }[] = [];
  if (firstZone && firstZone.firstInsideSeconds !== null) {
    const evidenceIds = unique([factAt("zone", firstZone.observedSeconds)?.id, factAt("route", firstZone.firstInsideSeconds)?.id].filter((id): id is string => Boolean(id)));
    takeaways.push({ title: "원 이동 기록", text: firstZone.phase + "번째 원 경계 밖 약 " + distanceLabel(firstZone.outsideMeters!)
      + "에서 " + time(firstZone.firstInsideSeconds) + " 원 안 위치를 관측했습니다. 실제 진입 시각은 다를 수 있습니다.", evidenceIds });
  }
  if (carepackage) {
    const laterKills = personalKills.filter(({ timeSeconds, weapon }) => timeSeconds > carepackage.timeSeconds && weapon === carepackage.weapon);
    if (laterKills.length) {
      const findFact = factAt("weapon_find", carepackage.timeSeconds);
      const killFacts = laterKills.map(({ timeSeconds }) => factAt("kill", timeSeconds)?.id).filter((id): id is string => Boolean(id));
      takeaways.push({ title: "보급 무기 기록", text: displayWeapon(carepackage.weapon) + " 획득 뒤 같은 무기로 " + laterKills.length + "킬을 기록했습니다.",
      evidenceIds: unique([findFact?.id, ...killFacts].filter((id): id is string => Boolean(id))) });
    }
  }
  if (lastPersonalKill) {
    const killFact = factAt("kill", lastPersonalKill.timeSeconds);
    takeaways.push({ title: "마지막 개인 킬 기록", text: displayWeapon(lastPersonalKill.weapon)
      + (lastPersonalKill.distanceMeters === undefined ? "" : " · 약 " + distanceLabel(lastPersonalKill.distanceMeters)) + "에서 기록했습니다.",
      evidenceIds: unique([killFact?.id].filter((id): id is string => Boolean(id))) });
  }

  const overviewSamples: Sample[] = [];
  overviewSamples.push(...teamLandingSamples);
  if (landing && landing.position && validPoint(landing.position) && inMatch(landing.timeSeconds)) {
    overviewSamples.push({ ...landing.position, timeSeconds: landing.positionTimeSeconds ?? landing.timeSeconds,
      evidenceId: landing.id, side: "ally", ranker: true, label: time(landing.positionTimeSeconds ?? landing.timeSeconds) + " 착지 기록된 위치" });
  }
  for (const point of route.filter(({ timeSeconds }) => inMatch(timeSeconds))) {
    const fact = factAt("route", point.timeSeconds);
    if (fact) overviewSamples.push({ x: point.x, y: point.y, timeSeconds: point.timeSeconds, evidenceId: fact.id,
      side: "ally", ranker: true, label: time(point.timeSeconds) + " 기록된 위치" });
    if (fact) overviewSamples.push(...routeTeamSamples(point, fact));
  }
  for (const encounter of encounters) {
    const fact = facts.find(({ id, kind }) => id === encounter.id && kind === "encounter");
    if (!fact) continue;
    for (const point of encounter.snapshots?.find(({ offsetSeconds }) => offsetSeconds === 0)?.points ?? []) {
      if (!inMatch(point.sampleTimeSeconds)) continue;
      overviewSamples.push({ x: point.x / 100, y: point.y / 100, timeSeconds: point.sampleTimeSeconds, evidenceId: fact.id,
        side: point.side, ranker: point.player === story.nickname, playerId: point.playerId, playerName: point.player,
        label: time(point.sampleTimeSeconds) + " " + participantLabel(point.player, point.playerId, point.side) + " 관측 위치",
        sourceIndices: point.sourceIndices });
    }
  }
  for (const zone of zones) overviewSamples.push(...phaseSamples(zone, matchStart, matchEnd));
  const circlePositionAt = (zone: Zone | undefined, at: number) => {
    if (!zone?.center || !validPoint(zone.center) || !Number.isFinite(zone.radius) || zone.radius! <= 0) return undefined;
    const nextReveal = zones.find(({ observedSeconds }) => observedSeconds > zone.observedSeconds)?.observedSeconds;
    const sample = overviewSamples.filter((point) => point.ranker && validPoint(point)
      && point.timeSeconds <= at && at - point.timeSeconds <= 20
      && point.timeSeconds >= zone.observedSeconds - 15 && (nextReveal === undefined || point.timeSeconds < nextReveal))
      .sort((a, b) => b.timeSeconds - a.timeSeconds)[0];
    if (!sample) return undefined;
    const outsideMeters = Math.hypot(sample.x - zone.center.x, sample.y - zone.center.y) - zone.radius!;
    const relation = outsideMeters > 8 ? zone.phase + "번째 원 밖 약 " + Math.round(outsideMeters) + "m"
      : outsideMeters >= -8 ? zone.phase + "번째 원 경계 근처" : zone.phase + "번째 원 안";
    const shrink = phaseShrink(zone);
    return { sample, text: time(sample.timeSeconds) + " 본인 위치 · " + relation
      + (shrink === undefined ? "" : shrink <= at ? " · 축소 시작 확인 후" : " · 축소 시작 확인 전") };
  };
  const friendly = (event: { actorId?: string; actorTeamId?: number }) => Boolean(event.actorId)
    && (event.actorId === rankerId || rankerTeam !== undefined && event.actorTeamId === rankerTeam);
  const inRange = (seconds: number, start: number, end: number) => inMatch(seconds) && seconds >= start && seconds <= end;
  const makeHighlight = (
    scene: Omit<DailyWalkthroughChapter, "evidenceIds" | "sourceIndices" | "mapSnapshot" | "situation" | "action" | "outcome">
      & { brief: NonNullable<DailyWalkthroughChapter["brief"]> },
    refs: Fact[], samples = overviewSamples, zone?: Zone,
  ): DailyWalkthroughChapter => {
    const snapshot = mapSnapshot(samples.filter(({ timeSeconds }) => inRange(timeSeconds, scene.startSeconds, scene.endSeconds)), zone,
      ownLifeIntervals, ownLifeFacts.length > 0);
    const zoneFact = zone && factAt("zone", zone.observedSeconds);
    if (zoneFact) refs = [...refs, zoneFact];
    const evidenceIds = unique([...refs.map(({ id }) => id), ...(snapshot?.observations?.map(({ evidenceId }) => evidenceId) ?? [])]);
    return { ...scene, ...scene.brief, evidenceIds,
      sourceIndices: unique([...refs.flatMap(({ sourceIndices }) => sourceIndices ?? []),
        ...(snapshot?.observations?.flatMap(({ sourceIndices }) => sourceIndices ?? []) ?? [])]),
      ...(snapshot ? { mapSnapshot: snapshot } : {}),
    };
  };

  // The opening uses only the designated landing and the same phase's observations.
  const openingZone = zones.find((zone) => factAt("zone", zone.observedSeconds));
  let openingHighlight: DailyWalkthroughChapter | undefined;
  let firstZoneMovement: { zone: Zone; zoneFact: Fact; fightSeconds: number; movementStartSeconds: number;
    insideSeconds: number; fightEndedBeforeEntry: boolean; boarding?: Fact } | undefined;
  if (openingZone && landing) {
    const zoneFact = factAt("zone", openingZone.observedSeconds)!;
    const nextReveal = zones.find((zone) => zone.observedSeconds > openingZone.observedSeconds)?.observedSeconds;
    const inside = (openingZone.outsideMeters ?? 0) > 0 && openingZone.firstInsideSeconds !== null
      && (nextReveal === undefined || openingZone.firstInsideSeconds < nextReveal) ? openingZone.firstInsideSeconds : null;
    const combatBeforeInside = inside === null ? [] : [
      ...encounters.flatMap((encounter) => encounter.actions
        .filter((event) => ["first_hit", "knock", "kill"].includes(event.kind)
          && event.timeSeconds >= openingZone.observedSeconds && event.timeSeconds < inside)
        .map(({ timeSeconds }) => timeSeconds)),
      ...teamKills.filter(({ timeSeconds }) => timeSeconds >= openingZone.observedSeconds && timeSeconds < inside)
        .map(({ timeSeconds }) => timeSeconds),
    ].sort((a, b) => a - b);
    const splitAt = combatBeforeInside[0];
    const phaseTimes = overviewSamples.filter((sample) => sample.ranker && inMatch(sample.timeSeconds)
      && sample.timeSeconds >= openingZone.observedSeconds && (nextReveal === undefined || sample.timeSeconds < nextReveal)).map(({ timeSeconds }) => timeSeconds);
    const shrink = openingZone.shrinkObservedSeconds;
    if (shrink != null && inMatch(shrink) && shrink >= openingZone.observedSeconds && (nextReveal === undefined || shrink < nextReveal)) phaseTimes.push(shrink);
    const end = inside !== null && splitAt !== undefined ? splitAt
      : inside ?? ((openingZone.outsideMeters ?? 0) > 0 ? Math.max(openingZone.observedSeconds, ...phaseTimes) : openingZone.observedSeconds);
    const phaseBoarding = rankerId ? facts.find((fact) => fact.kind === "vehicle"
      && fact.actorId === rankerId && fact.vehicleName
      && inRange(fact.timeSeconds, openingZone.observedSeconds, inside ?? end)) : undefined;
    const boarding = phaseBoarding && phaseBoarding.timeSeconds <= end ? phaseBoarding : undefined;
    if (splitAt !== undefined && inside !== null) {
      const fight = encounters.find(({ startSeconds, endSeconds }) => startSeconds <= splitAt && endSeconds >= splitAt);
      const fightEndedBeforeEntry = Boolean(fight && fight.endSeconds < inside);
      firstZoneMovement = {
        zone: openingZone, zoneFact, fightSeconds: splitAt,
        movementStartSeconds: fightEndedBeforeEntry ? fight!.endSeconds : splitAt,
        insideSeconds: inside, fightEndedBeforeEntry,
        boarding: phaseBoarding && phaseBoarding.timeSeconds >= (fightEndedBeforeEntry ? fight!.endSeconds : splitAt)
          ? phaseBoarding : undefined,
      };
    }
    const movement = movementFor(openingZone, end, true)!;
    const openingEvents = [
      { seconds: openingZone.observedSeconds, text: time(openingZone.observedSeconds) + " " + openingZone.phase + "번째 원 공개"
        + ((openingZone.outsideMeters ?? 0) > 0 ? " · 약 " + distanceLabel(openingZone.outsideMeters!) + " 밖" : "") },
      ...(shrink != null && shrink <= end && inMatch(shrink) && shrink >= openingZone.observedSeconds
        && (nextReveal === undefined || shrink < nextReveal) ? [{ seconds: shrink, text: time(shrink) + " 원 수축 확인" }] : []),
      ...(boarding ? [{ seconds: boarding.timeSeconds, text: time(boarding.timeSeconds) + " " + boarding.vehicleName + " 탑승" }] : []),
    ].sort((a, b) => a.seconds - b.seconds);
    const brief = {
      situation: time(landing.timeSeconds) + (landingPlace ? " " + landingPlace : "") + " 착지",
      action: openingEvents.map(({ text }) => text).join(" → "),
      outcome: firstZoneMovement ? "원 안 위치는 다음 이동 장면에서 처음 확인"
        : inside !== null ? time(inside) + " 원 안 위치 첫 기록 · 실제 진입 시각은 다를 수 있음"
        : openingZone.outsideMeters === 0 ? "공개 때 원 안 위치 확인"
          : openingZone.outsideMeters !== null ? "이 원 안의 위치는 확인되지 않음" : "원 공개 때 위치 미확인",
    };
    const movementSamples = [
      ...overviewSamples.filter((sample) => inRange(sample.timeSeconds, landing.timeSeconds, end)),
      ...phaseSamples(openingZone, landing.timeSeconds, end),
    ];
    if (boarding?.position && validPoint(boarding.position) && boarding.positionTimeSeconds != null
      && inRange(boarding.positionTimeSeconds, openingZone.observedSeconds, boarding.timeSeconds)) {
      movementSamples.push({ ...boarding.position, timeSeconds: boarding.positionTimeSeconds, evidenceId: boarding.id,
        sourceIndices: boarding.sourceIndices, ranker: true, side: "ally", label: time(boarding.positionTimeSeconds) + " 탑승 때 기록된 위치" });
    }
    openingHighlight = makeHighlight({
      id: "highlight-opening", kind: "opening", title: "착지와 " + openingZone.phase + "번째 원",
      startSeconds: landing.timeSeconds, anchorSeconds: openingZone.observedSeconds, endSeconds: end,
      brief, movement,
      ...((openingZone.outsideMeters ?? 0) > 0 ? { lesson: time(openingZone.observedSeconds) + " "
        + openingZone.phase + "번째 원 공개 때 경계 밖 약 " + distanceLabel(openingZone.outsideMeters!) } : {}),
    }, [landing, zoneFact, ...(boarding ? [boarding] : [])], movementSamples, openingZone);
    openingHighlight.action = brief.action + (openingZone.outsideMeters === 0 ? " · 공개 때 원 안" : "");
  }

  // Event identity comes from structured facts/actions, never their display prose.
  const killFacts = facts.filter((fact) => (fact.kind === "kill" || fact.kind === "teammate_kill")
    && fact.victimId && friendly(fact) && inMatch(fact.timeSeconds));
  const closingFact = lastRecordedKill && killFacts.find((fact) => fact.timeSeconds === lastRecordedKill.timeSeconds
    && (lastRecordedKill.weapon === fact.weapon || !fact.weapon));
  const closingEncounter = closingFact && encounters.find((encounter) => encounter.actions.some((event) =>
    event.kind === "kill" && event.actorId === closingFact.actorId && event.victimId === closingFact.victimId
    && event.timeSeconds === closingFact.timeSeconds));
  let finalHighlight: DailyWalkthroughChapter | undefined;
  if (closingFact && closingEncounter) {
    const encounterFact = facts.find(({ id }) => id === closingEncounter.id);
    const events = closingEncounter.actions.filter((event) => event.actorId && event.victimId
      && inRange(event.timeSeconds, closingEncounter.startSeconds, Math.min(closingEncounter.endSeconds, matchEnd)))
      .sort((a, b) => a.timeSeconds - b.timeSeconds);
    const kills = events.filter((event) => event.kind === "kill" && friendly(event)
      && killFacts.some((fact) => fact.actorId === event.actorId && fact.victimId === event.victimId && fact.timeSeconds === event.timeSeconds));
    const final = kills.find((event) => event.timeSeconds === closingFact.timeSeconds
      && event.actorId === closingFact.actorId && event.victimId === closingFact.victimId);
    if (encounterFact && final) {
      const chains = kills.map((kill) => {
        const before = events.filter((event) => (event.kind === "first_hit" || event.kind === "knock")
          && event.victimId === kill.victimId && event.timeSeconds <= kill.timeSeconds && friendly(event)
          && (event.actorId === kill.actorId || event.actorTeamId !== undefined && event.actorTeamId === kill.actorTeamId && event.actor !== kill.actor));
        return { kill, before: before.find((event) => event.kind === "knock") ?? before[0] };
      });
      const chain = chains.find(({ kill, before }) => kill === final && before)
        ?? chains.find(({ before }) => before) ?? { kill: final, before: undefined };
      const other = chain.kill.victimId !== final.victimId ? final : undefined;
      const role = (actorId: string | undefined, name: string) => rankerId && actorId === rankerId
        ? "본인" : participantLabel(name, actorId, "ally");
      const start = chain.before?.timeSeconds ?? chain.kill.timeSeconds;
      const finalZone = zones.filter(({ observedSeconds }) => observedSeconds <= start).at(-1);
      const finalCircle = circlePositionAt(finalZone, start);
      const action = other && chain.before
        ? time(start) + "~" + time(final.timeSeconds) + " " + role(chain.before.actorId, chain.before.actor) + " "
          + displayWeapon(chain.before.weapon) + (chain.before.kind === "knock" ? " 기절" : " 피해를 줌")
          + "·" + (chain.before.actorId !== chain.kill.actorId ? role(chain.kill.actorId, chain.kill.actor) + " " : "")
          + (chain.before.weapon !== chain.kill.weapon ? displayWeapon(chain.kill.weapon) + " " : "")
          + "킬, " + role(other.actorId, other.actor) + " " + displayWeapon(other.weapon) + " 다른 상대 킬"
        : (chain.before ? time(start) + " " + role(chain.before.actorId, chain.before.actor) + " " + displayWeapon(chain.before.weapon)
          + (chain.before.kind === "knock" ? " 기절 → " : " 피해 → ") : "")
          + time(chain.kill.timeSeconds) + " " + role(chain.kill.actorId, chain.kill.actor) + " " + displayWeapon(chain.kill.weapon) + " 킬";
      const brief = {
        situation: finalCircle ? finalCircle.text : other ? "서로 다른 상대 두 명과의 교전"
          : chain.before?.distanceMeters != null ? (chain.before.kind === "knock" ? "기절 거리 약 " : "피해를 준 거리 약 ") + distanceLabel(chain.before.distanceMeters)
            : story.mode === "solo" ? "마지막으로 기록된 킬" : "마지막으로 기록된 팀 킬",
        action: finalSecondKills.length > 1
          ? time(finalSecondKills[0].timeSeconds) + " " + simultaneousKillLabel(finalSecondKills) : action,
        outcome: time(final.timeSeconds) + " " + role(final.actorId, final.actor) + " 킬 확인",
      };
      const refs = [encounterFact, ...killFacts.filter((fact) => kills.some((kill) => kill.actorId === fact.actorId
        && kill.victimId === fact.victimId && kill.timeSeconds === fact.timeSeconds)), ...(finishLinkedToKill && finish ? [finish] : []),
      ...(finalCircle ? facts.filter(({ id }) => id === finalCircle.sample.evidenceId) : [])];
      finalHighlight = makeHighlight({
        id: "highlight-" + closingEncounter.id, kind: "combat",
        title: "마지막으로 기록된 " + (story.mode === "solo" ? "개인 킬" : "팀 킬"),
        startSeconds: Math.min(start, finalCircle?.sample.timeSeconds ?? start), anchorSeconds: start,
        endSeconds: final.timeSeconds, brief,
      }, refs, overviewSamples, finalZone);
      if (finalCircle?.sample.sourceIndices) finalHighlight.sourceIndices = unique([...(finalHighlight.sourceIndices ?? []), ...finalCircle.sample.sourceIndices]);
      if (finalCircle) {
        finalHighlight.evidenceIds = unique([...finalHighlight.evidenceIds, finalCircle.sample.evidenceId]);
      }
      finalHighlight.action = [...(finalCircle ? ["흰 원(다음 안전 구역) 기준 · " + finalCircle.text] : []), ...events.filter((event) => event.timeSeconds >= start && event.timeSeconds <= final.timeSeconds)
        .map((event) => time(event.timeSeconds) + " " + event.actor + " → " + event.victim + " · " + displayWeapon(event.weapon)
          + " " + ({ first_hit: "피해", knock: "기절", kill: "킬", ally_down: "팀원 기절" }[event.kind]))].join("\n");
    }
  }

  const secondary: DailyWalkthroughChapter[] = [];
  const nameForId = (id: string) => {
    if (id === rankerId) return "본인";
    const names = unique(encounters.flatMap(({ actions }) => actions.flatMap((event) =>
      [event.actorId === id ? event.actor : undefined, event.victimId === id ? event.victim : undefined].filter((name): name is string => Boolean(name)))));
    return participantLabel(names[0] ?? "", id, participants.find((item) => item.id === id)?.side);
  };
  const terminalDeathFact = terminalOutcomeFact;
  const terminalHighlight: DailyWalkthroughChapter | undefined = terminalDeathFact && finish
    ? makeHighlight({
      id: "highlight-terminal-outcome", kind: "finish", title: "우승 직전",
      startSeconds: terminalDown?.timeSeconds ?? terminalDeathFact.timeSeconds,
      anchorSeconds: terminalDeathFact.timeSeconds, endSeconds: finish.timeSeconds,
      brief: {
        situation: terminalDown ? time(terminalDown.timeSeconds) + " 본인 기절 기록" : time(terminalDeathFact.timeSeconds) + " 2위 상대 사망 기록",
        action: [terminalDown ? time(terminalDown.timeSeconds) + " 본인 기절" : "",
          time(terminalDeathFact.timeSeconds) + " " + nameForId(terminalDeathFact.victimId!) + " 자기장 사망",
          time(finish.timeSeconds) + " " + winnerLabel(finish.text.match(/\d+위/)?.[0] ?? "1위")].filter(Boolean).join(" · "),
        outcome: time(finish.timeSeconds) + " 경기 종료 기록 · " + winnerLabel(finish.text.match(/\d+위/)?.[0] ?? "1위"),
      },
    }, [terminalDown, terminalDeathFact, finish].filter((fact): fact is Fact => Boolean(fact)), overviewSamples,
    zones.filter(({ observedSeconds }) => observedSeconds <= terminalDeathFact.timeSeconds).at(-1)) : undefined;
  if (terminalHighlight?.mapSnapshot && terminalDeathFact?.position
    && validPoint(terminalDeathFact.position) && terminalDeathFact.positionTimeSeconds === terminalDeathFact.timeSeconds) {
    terminalHighlight.mapSnapshot.kills = [...(terminalHighlight.mapSnapshot.kills ?? []), {
      ...terminalDeathFact.position,
      label: time(terminalDeathFact.timeSeconds) + " " + nameForId(terminalDeathFact.victimId!) + " 자기장 사망",
    }];
  }
  for (const life of ownLifeCycles) {
    const endSeconds = life.finalDeath?.timeSeconds ?? life.returned.timeSeconds;
    const zone = zones.filter(({ observedSeconds }) => observedSeconds <= life.returned.timeSeconds).at(-1);
    secondary.push(makeHighlight({
      id: "highlight-player-return-" + life.returned.id, kind: "recovery",
      title: time(life.returned.timeSeconds) + " 본인 재등장",
      startSeconds: life.death.timeSeconds, anchorSeconds: life.returned.timeSeconds, endSeconds,
      brief: {
        situation: time(life.death.timeSeconds) + " 본인 사망 기록",
        action: time(life.returned.timeSeconds) + " 본인 재등장 기록",
        outcome: life.finalDeath ? time(life.finalDeath.timeSeconds) + " 본인 사망 기록"
          : "확인된 후속 사망 기록 없음",
      },
      lesson: time(life.death.timeSeconds) + " 본인 사망 → " + time(life.returned.timeSeconds) + " 재등장"
        + (life.finalDeath ? " → " + time(life.finalDeath.timeSeconds) + " 다시 사망" : ""),
    }, [life.death, life.returned, ...(life.finalDeath ? [life.finalDeath] : [])], overviewSamples, zone));
  }
  for (const revive of facts.filter((fact) => fact.kind === "revive" && fact.actorId && fact.victimId
    && friendly(fact) && fact.actorTeamId !== undefined && fact.actorTeamId === fact.victimTeamId && inMatch(fact.timeSeconds))) {
    const previous = facts.filter((fact) => fact.victimId === revive.victimId && inRange(fact.timeSeconds, matchStart, revive.timeSeconds)
      && (fact.kind === "down" || fact.kind === "revive" || fact.kind === "teammate_death")).at(-2);
    // The revive itself is the last item; a previous revive/death cannot be reused as a knock.
    if (!previous || previous.kind !== "down" || previous.timeSeconds >= revive.timeSeconds) continue;
    const actor = nameForId(revive.actorId!);
    const recipient = nameForId(revive.victimId!);
    const resumedKill = killFacts.find((kill) => kill.actorId === revive.victimId && kill.timeSeconds > revive.timeSeconds);
    const brief = {
      situation: time(previous.timeSeconds) + " " + recipient + " 기절",
      action: time(revive.timeSeconds) + " 소생 기록: " + actor + " → " + recipient,
      outcome: recipient === "본인" ? "본인 소생 완료" : recipient + " 소생 완료",
    };
    secondary.push(makeHighlight({
      id: "highlight-" + revive.id, kind: "recovery", title: time(revive.timeSeconds) + (recipient === "본인" ? " 본인 소생" : " 팀원 소생"),
      startSeconds: previous.timeSeconds, anchorSeconds: revive.timeSeconds, endSeconds: revive.timeSeconds, brief,
      lesson: resumedKill ? recipient + "은 " + time(revive.timeSeconds) + " 소생 뒤 "
        + time(resumedKill.timeSeconds) + " " + displayWeapon(resumedKill.weapon ?? "") + " 킬을 기록했습니다."
        : recipient + "은 " + time(previous.timeSeconds) + " 기절 후 " + time(revive.timeSeconds) + " 소생됐습니다.",
    }, [previous, revive, ...(resumedKill ? [resumedKill] : [])]));
  }
  if (firstZoneMovement) {
    const { zone, zoneFact, fightSeconds, movementStartSeconds, insideSeconds, fightEndedBeforeEntry } = firstZoneMovement;
    const movementFight = fightEndedBeforeEntry && encounters.find(({ startSeconds, endSeconds }) =>
      startSeconds <= fightSeconds && endSeconds < insideSeconds && endSeconds >= fightSeconds);
    const fightFact = movementFight && facts.find((fact) => fact.id === movementFight.id && fact.kind === "encounter");
    const boardingFact = firstZoneMovement.boarding;
    const boarding = boardingFact && boardingFact.timeSeconds >= movementStartSeconds ? boardingFact : undefined;
    const entryFact = factAt("route", insideSeconds);
    const shrink = phaseShrink(zone);
    const brief = {
      situation: time(movementStartSeconds) + (fightEndedBeforeEntry ? " 교전 뒤 첫 원 이동" : " 첫 교전 기록 뒤 원 이동"),
      action: boarding ? time(boarding.timeSeconds) + " " + boarding.vehicleName + " 탑승 → "
        + time(insideSeconds) + " 원 안 위치 확인" : time(insideSeconds) + " 원 안 위치 확인",
      outcome: shrink !== undefined && shrink <= insideSeconds ? "축소 시작 확인 후 원 안 위치 기록"
        : shrink !== undefined ? "축소 시작 확인 전 원 안 위치 기록" : "원 안 위치 확인",
    };
    secondary.push(makeHighlight({
      id: "highlight-opening-movement", kind: "movement", title: zone.phase + "번째 원 진입",
      startSeconds: movementStartSeconds, anchorSeconds: movementStartSeconds, endSeconds: insideSeconds, brief,
      movement: movementFor(zone, insideSeconds),
      lesson: boarding ? time(boarding.timeSeconds) + " " + boarding.vehicleName + " 탑승 → "
        + time(insideSeconds) + " 원 안 위치 기록" : time(insideSeconds) + " 원 안 위치 기록",
    }, [zoneFact, ...(fightFact ? [fightFact] : []), ...(boarding ? [boarding] : []), ...(entryFact ? [entryFact] : [])], overviewSamples, zone));
  }
  for (const find of finds.filter((find) => find.source === "carepackage" && find.playerId === rankerId && rankerId && inMatch(find.timeSeconds))) {
    const findFact = facts.find((fact) => fact.kind === "weapon_find" && fact.actorId === find.playerId
      && fact.weapon === find.weapon && fact.timeSeconds === find.timeSeconds);
    const kill = killFacts.find((fact) => fact.actorId === find.playerId && fact.weapon === find.weapon && fact.timeSeconds > find.timeSeconds);
    if (!findFact || !kill) continue;
    const brief = { situation: "보급품에서 무기를 얻은 뒤의 교전",
      action: time(find.timeSeconds) + " " + displayWeapon(find.weapon) + " 획득",
      outcome: time(kill.timeSeconds) + " 같은 무기로 개인 킬",
    };
    secondary.push(makeHighlight({
      id: "highlight-" + findFact.id, kind: "combat", title: "보급 무기의 후속 교전",
      startSeconds: find.timeSeconds, anchorSeconds: find.timeSeconds, endSeconds: kill.timeSeconds, brief,
      lesson: time(find.timeSeconds) + " " + displayWeapon(find.weapon) + " 획득 → "
        + time(kill.timeSeconds) + " 같은 무기로 개인 킬",
    }, [findFact, kill]));
  }
  for (const zone of zones.filter((zone) => zone !== openingZone && (zone.outsideMeters ?? 0) > 0 && zone.firstInsideSeconds !== null)) {
    const zoneFact = factAt("zone", zone.observedSeconds);
    const end = zone.firstInsideSeconds!;
    const boarding = rankerId && facts.find((fact) => fact.kind === "vehicle" && fact.actorId === rankerId && fact.vehicleName
      && inRange(fact.timeSeconds, zone.observedSeconds, end));
    if (!zoneFact) continue;
    const samples = phaseSamples(zone, Math.max(matchStart, zone.observedSeconds - 15), end);
    const start = Math.min(zone.observedSeconds, ...samples.map(({ timeSeconds }) => timeSeconds));
    const shrink = phaseShrink(zone);
    const positionSamples = samples.filter((sample) => sample.ranker && validPoint(sample)
      && sample.timeSeconds >= zone.observedSeconds - 15 && sample.timeSeconds <= end)
      .sort((a, b) => a.timeSeconds - b.timeSeconds)
      .filter((sample, index, all) => index === 0 || sample.timeSeconds !== all[index - 1].timeSeconds
        || sample.x !== all[index - 1].x || sample.y !== all[index - 1].y);
    const positionStatus = (sample: Sample) => {
      if (!zone.center || !validPoint(zone.center) || !Number.isFinite(zone.radius) || zone.radius! <= 0) return null;
      const outside = Math.hypot(sample.x - zone.center.x, sample.y - zone.center.y) - zone.radius!;
      return outside > 0 ? { label: "원 밖 약 " + Math.round(outside) + "m", outside: true }
        : outside >= -8 ? { label: "원 안쪽 경계", outside: false } : { label: "원 안", outside: false };
    };
    const firstInsideIndex = positionSamples.findIndex((sample) => positionStatus(sample)?.outside === false);
    const lastOutside = firstInsideIndex > 0
      ? positionSamples.slice(0, firstInsideIndex).findLast((sample) => positionStatus(sample)?.outside === true) : undefined;
    const firstInside = firstInsideIndex >= 0 ? positionSamples[firstInsideIndex] : undefined;
    const transition = lastOutside && firstInside ? [
      { at: lastOutside.timeSeconds, text: time(lastOutside.timeSeconds) + " " + positionStatus(lastOutside)!.label },
      { at: firstInside.timeSeconds, text: time(firstInside.timeSeconds) + " " + positionStatus(firstInside)!.label },
    ] : [];
    const lonePosition = !transition.length && positionSamples.length
      ? [{ at: positionSamples.at(-1)!.timeSeconds,
        text: time(positionSamples.at(-1)!.timeSeconds) + " "
          + (positionStatus(positionSamples.at(-1)!)?.label
            ? positionStatus(positionSamples.at(-1)!)!.label + " 위치 기록" : "위치 기록") }] : [];
    const brief = {
      situation: time(zone.observedSeconds) + " " + zone.phase + "번째 원 공개 · 경계까지 직선거리 약 " + distanceLabel(zone.outsideMeters!),
      action: (boarding ? [
        { at: boarding.timeSeconds, text: time(boarding.timeSeconds) + " " + boarding.vehicleName + " 탑승" },
        ...(firstInside ? [{ at: firstInside.timeSeconds, text: time(firstInside.timeSeconds) + " " + positionStatus(firstInside)!.label + " 위치 확인" }] : []),
      ] : [...transition, ...lonePosition]).sort((a, b) => a.at - b.at).map(({ text }) => text).join(" → ")
        || "이동을 보여주는 위치 기록 없음",
      outcome: time(end) + (shrink === undefined ? "" : shrink <= end ? " 축소 시작 확인 후" : " 축소 시작 확인 전")
        + " 원 안 위치 기록" };
    secondary.push(makeHighlight({
      id: "highlight-" + zoneFact.id, kind: "movement", title: zone.phase + "번째 원 이동",
      startSeconds: start, anchorSeconds: zone.observedSeconds, endSeconds: end, brief, movement: movementFor(zone, end),
      ...(positionSamples.length || boarding ? { lesson: brief.action } : {}),
    }, [zoneFact, ...(boarding ? [boarding] : [])], [...samples, ...overviewSamples], zone));
  }
  // One encounter card per recorded fight. Allocate each team kill to one card even when
  // encounter intervals overlap; facts stay attached to the event that actually occurred.
  const assigned = new Set<number>();
  const encounterScenes = encounters.filter((encounter) => inMatch(encounter.startSeconds) && inMatch(encounter.endSeconds))
    .sort((a, b) => a.startSeconds - b.startSeconds || a.id.localeCompare(b.id))
    .map((encounter) => {
      const encounterFact = facts.find((fact) => fact.id === encounter.id && fact.kind === "encounter");
      const actions = encounter.actions.filter((event) => inMatch(event.timeSeconds)
        && event.timeSeconds >= encounter.startSeconds && event.timeSeconds <= encounter.endSeconds)
        .sort((a, b) => a.timeSeconds - b.timeSeconds);
      const allocated: { index: number; action: DailyEncounterAction }[] = [];
      for (const action of actions.filter((event) => event.kind === "kill")) {
        const index = teamKills.findIndex((kill, candidate) => !assigned.has(candidate)
          && kill.timeSeconds === action.timeSeconds && kill.victim === action.victim && kill.killer === action.actor);
        if (index < 0) continue;
        assigned.add(index);
        allocated.push({ index, action });
      }
      if (!actions.some((event) => event.kind === "first_hit" || event.kind === "knock" || event.kind === "kill") && !allocated.length) return null;
      const zone = zones.filter(({ observedSeconds }) => observedSeconds <= encounter.startSeconds).at(-1);
      const circlePosition = circlePositionAt(zone, encounter.startSeconds);
      const circleContext = circlePosition?.text;
      const combatZone = zone ? {
        phase: zone.phase, observedSeconds: zone.observedSeconds, outsideMeters: zone.outsideMeters,
        ...(zone.shrinkObservedSeconds != null && zone.shrinkObservedSeconds <= encounter.startSeconds
          ? { shrinkObservedSeconds: zone.shrinkObservedSeconds } : {}),
        ...(zone.center && validPoint(zone.center) ? { center: zone.center } : {}),
        ...(zone.radius && Number.isFinite(zone.radius) ? { radius: zone.radius } : {}),
      } : undefined;
      const own = allocated.filter(({ index }) => teamKills[index].killer === story.nickname).length;
      const playerLabel = (player: string, id?: string, side?: "ally" | "opponent", inVehicle?: boolean) =>
        participantLabel(player, id, side) + (inVehicle === true ? "(차량 탑승)" : "");
      const eventVerb = (event: DailyEncounterAction) => event.kind === "first_hit" ? "피해 기록"
        : event.kind === "knock" ? "기절" : event.kind === "ally_down" ? "기절" : "처치";
      const describeEvent = (event: DailyEncounterAction) => time(event.timeSeconds) + " "
        + playerLabel(event.actor, event.actorId, friendly(event) ? "ally" : "opponent", event.actorInVehicle) + " → "
        + playerLabel(event.victim, event.victimId, friendly({ actorId: event.victimId, actorTeamId: event.victimTeamId }) ? "ally" : "opponent", event.victimInVehicle)
        + " · " + displayWeapon(event.weapon) + " · " + eventVerb(event)
        + (event.distanceMeters != null && Number.isFinite(event.distanceMeters) ? " · " + distanceLabel(event.distanceMeters) : "");
      const firstHit = actions.find((event) => event.kind === "first_hit");
      const returnHits = actions.filter((event) => event.kind === "first_hit" && event !== firstHit
        && !friendly(event) && friendly({ actorId: event.victimId, actorTeamId: event.victimTeamId })
        && actions.some((prior) => prior.kind === "first_hit" && friendly(prior)
          && prior.timeSeconds < event.timeSeconds
          && (prior.victimId === event.actorId || prior.victimTeamId !== undefined
            && prior.victimTeamId === event.actorTeamId)));
      const counterHits = actions.filter((event) => event.kind === "first_hit" && event !== firstHit
        && friendly(event) && !friendly({ actorId: event.victimId, actorTeamId: event.victimTeamId })
        && firstHit && event.timeSeconds > firstHit.timeSeconds
        && (event.actorId === firstHit.victimId && event.victimId === firstHit.actorId
          || event.actorTeamId !== undefined && event.actorTeamId === firstHit.victimTeamId
            && event.victimTeamId === firstHit.actorTeamId));
      const knockEvents = actions.filter((event) => event.kind === "knock");
      const knockGroups: DailyEncounterAction[][] = [];
      for (const event of knockEvents) {
        const current = knockGroups.at(-1);
        const prior = current?.at(-1);
        const sameActor = prior && prior.actorId && event.actorId
          ? prior.actorId === event.actorId : prior?.actor === event.actor;
        if (prior && sameActor && prior.actorInVehicle === event.actorInVehicle && prior.weapon === event.weapon
          && event.timeSeconds - prior.timeSeconds <= 10
          && (prior.distanceMeters ?? Infinity) <= 15 && (event.distanceMeters ?? Infinity) <= 15) current!.push(event);
        else knockGroups.push([event]);
      }
      const knockClauses = knockGroups.slice(0, 2).map((group) => {
        const first = group[0];
        const distances = group.map(({ distanceMeters }) => distanceMeters).filter((value): value is number =>
          typeof value === "number" && Number.isFinite(value));
        const range = distances.length ? " · " + (Math.min(...distances) === Math.max(...distances)
          ? distanceLabel(distances[0]) : distanceLabel(Math.min(...distances)) + "–" + distanceLabel(Math.max(...distances))) : "";
        return time(first.timeSeconds) + " " + playerLabel(first.actor, first.actorId, friendly(first) ? "ally" : "opponent", first.actorInVehicle) + " · "
          + displayWeapon(first.weapon) + " · " + group.map((event) => playerLabel(event.victim, event.victimId,
            friendly({ actorId: event.victimId, actorTeamId: event.victimTeamId }) ? "ally" : "opponent")).join("·") + " 기절" + range;
      });
      if (knockGroups.length > 2) knockClauses.push("그 밖의 기절 " + (knockGroups.length - 2) + "건은 상세 기록 참조");
      const returnClause = returnHits.length ? "상대 팀 반격 기록: " + returnHits.slice(0, 3).map((event) =>
        playerLabel(event.actor, event.actorId, "opponent", event.actorInVehicle) + " → " + playerLabel(event.victim, event.victimId, "ally", event.victimInVehicle)
          + " (" + displayWeapon(event.weapon) + (event.distanceMeters != null ? ", " + distanceLabel(event.distanceMeters) : "") + ")"
      ).join(", ") + (returnHits.length > 3 ? " 외" : "") : "";
      const counterClause = counterHits.length ? "아군 반격 사격 기록: " + counterHits.slice(0, 2).map((event) =>
        playerLabel(event.actor, event.actorId, "ally", event.actorInVehicle) + " → " + playerLabel(event.victim, event.victimId, "opponent", event.victimInVehicle)
          + " (" + displayWeapon(event.weapon) + (event.distanceMeters != null ? ", " + distanceLabel(event.distanceMeters) : "") + ")"
      ).join(", ") : "";
      const allyDowns = actions.filter((event) => event.kind === "ally_down");
      const downClause = allyDowns.length ? "아군 기절 기록: " + allyDowns.slice(0, 2).map((event) =>
        playerLabel(event.actor, event.actorId, "opponent", event.actorInVehicle) + " → " + playerLabel(event.victim, event.victimId, "ally", event.victimInVehicle)
      ).join(", ") : "";
      const actionClauses = [
        ...knockClauses.map((text, index) => ({ at: knockGroups[index]?.[0]?.timeSeconds ?? encounter.startSeconds, text })),
        ...(returnClause ? [{ at: returnHits[0].timeSeconds, text: returnClause }] : []),
        ...(counterClause ? [{ at: counterHits[0].timeSeconds, text: counterClause }] : []),
        ...(downClause ? [{ at: allyDowns[0].timeSeconds, text: downClause }] : []),
      ].sort((a, b) => a.at - b.at).slice(0, 3).map(({ text }) => text);
      const finishGroups: { actor: string; actions: DailyEncounterAction[] }[] = [];
      for (const { action } of allocated) {
        const group = finishGroups.at(-1);
        const prior = group?.actions.at(-1);
        if (group?.actor === action.actor && prior && action.timeSeconds - prior.timeSeconds <= 10) group.actions.push(action);
        else finishGroups.push({ actor: action.actor, actions: [action] });
      }
      const finishText = finishGroups.map(({ actor, actions: finishes }) => {
        const first = finishes[0].timeSeconds;
        const last = finishes.at(-1)!.timeSeconds;
        return (time(first) === time(last) ? time(first) : time(first) + "–" + time(last)) + " "
          + participantLabel(actor, finishes[0].actorId, "ally") + " 처치: " + finishes.map(({ victim, victimId }) =>
            participantLabel(victim, victimId, "opponent")).join("·");
      }).join(", ");
      const encounterTally = story.mode === "solo" ? "이 교전: " + own + "킬"
        : "팀 " + allocated.length + "킬 (개인 " + own + "킬)";
      const opponentRoster = encounter.opponentIdentity?.players ?? [];
      const priorDeadIds = new Set(opponentRoster.filter(({ id, deathTimeSeconds }) => deathTimeSeconds !== undefined
        && deathTimeSeconds < encounter.startSeconds
        && !encounter.actions.some((event) => event.actorId === id && event.timeSeconds > deathTimeSeconds
          && event.timeSeconds <= encounter.endSeconds)
        && !encounter.snapshots?.some((snapshot) => snapshot.points.some((point) => point.playerId === id
          && point.sampleTimeSeconds > deathTimeSeconds))).map(({ id }) => id));
      const opponentRosterIds = new Set(opponentRoster.map(({ id }) => id));
      const allyKillIds = new Set(actions.filter((event) => event.kind === "kill" && event.victimId
        && opponentRosterIds.has(event.victimId) && event.victimTeamId === encounter.opponentIdentity?.teamId
        && event.actorTeamId === rankerTeam)
        .map(({ victimId }) => victimId!));
      const currentDead = opponentRoster.filter(({ deathTimeSeconds }) => deathTimeSeconds !== undefined
        && deathTimeSeconds >= encounter.startSeconds && deathTimeSeconds <= encounter.endSeconds);
      const otherDeadIds = new Set(currentDead.filter(({ id, deathKillerTeamId }) => !allyKillIds.has(id)
        && deathKillerTeamId !== undefined && deathKillerTeamId !== rankerTeam).map(({ id }) => id));
      const unattributedDeadIds = new Set(currentDead.filter(({ id, deathKillerTeamId }) => !allyKillIds.has(id)
        && deathKillerTeamId === undefined).map(({ id }) => id));
      const priorOpponentDeaths = priorDeadIds.size;
      const encounterOpponentDeaths = allyKillIds.size;
      const otherOpponentDeaths = otherDeadIds.size;
      const unattributedOpponentDeaths = unattributedDeadIds.size;
      const unconfirmedOpponentDeaths = Math.max(0, opponentRoster.length - priorOpponentDeaths - encounterOpponentDeaths
        - otherOpponentDeaths - unattributedOpponentDeaths);
      const knownOpponents = encounter.opponents ?? [];
      const rosterOutcome = opponentRoster.length ? [
        `상대 팀 ${opponentRoster.length}명 중 ${encounterOpponentDeaths}명 처치`,
        unconfirmedOpponentDeaths ? `${unconfirmedOpponentDeaths}명은 처치 기록 없음` : "",
        otherOpponentDeaths ? `교전 중 타팀 처치 ${otherOpponentDeaths}명` : "",
        unattributedOpponentDeaths ? `교전 중 처치 귀속 불가 ${unattributedOpponentDeaths}명` : "",
        priorOpponentDeaths ? `교전 전 ${priorOpponentDeaths}명 사망` : "",
        priorOpponentDeaths + encounterOpponentDeaths + otherOpponentDeaths + unattributedOpponentDeaths === opponentRoster.length
          ? "전원 사망 기록 확인" : "",
      ].filter(Boolean).join(" · ") : "";
      const observedSnapshot = encounter.snapshots?.find(({ offsetSeconds }) => offsetSeconds === 0);
      const explicitDeadIds = observedSnapshot?.deadPlayerIds;
      const observedOpponents = observedSnapshot?.points.filter(({ side }) => side === "opponent") ?? [];
      const observedOpponentIds = new Set(observedOpponents.flatMap(({ playerId }) => playerId ? [playerId] : []));
      const observedOpponentNames = new Set(observedOpponents.map(({ player }) => player));
      const deadBeforeSnapshot = opponentRoster.filter(({ id, name }) => priorDeadIds.has(id)
        && (Array.isArray(explicitDeadIds) ? explicitDeadIds.includes(id)
          : !observedOpponentIds.has(id) && !observedOpponentNames.has(name)));
      const unknownPositions = opponentRoster.filter(({ id, name }) =>
        !observedOpponentIds.has(id) && !observedOpponentNames.has(name)
        && !deadBeforeSnapshot.some((player) => player.id === id));
      const opponentAliases = (players: typeof opponentRoster) => players.map(({ id, name }) => participantLabel(name, id, "opponent"));
      const shortNames = (names: string[]) => names.length > 4 ? names.slice(0, 4).join("·") + " 외 " + (names.length - 4) + "명" : names.join("·");
      const rosterSituation = opponentRoster.length
        ? [`교전 시작 전후 15초 내 위치: ${observedOpponents.length}/${opponentRoster.length}명`,
          unknownPositions.length ? `${shortNames(opponentAliases(unknownPositions))} 위치 미확인` : "",
          deadBeforeSnapshot.length ? `교전 전 사망: ${shortNames(opponentAliases(deadBeforeSnapshot))}` : "",
          observedOpponents.some(({ ageSeconds }) => ageSeconds > 0)
            ? `표본 시각 최대 ${Math.round(Math.max(...observedOpponents.map(({ ageSeconds }) => ageSeconds)))}초 차이` : "",
        ].filter(Boolean).join(" · ")
        : [`상대 팀 전체 인원 확인 불가`, ...(knownOpponents.length
          ? [`확인된 상대 ${knownOpponents.length}명 중 위치 기록 ${observedOpponents.length}명`] : [])].join(" · ");
      const situation = firstHit
        ? time(firstHit.timeSeconds) + " " + playerLabel(firstHit.actor, firstHit.actorId,
          friendly(firstHit) ? "ally" : "opponent", firstHit.actorInVehicle) + "의 "
          + displayWeapon(firstHit.weapon) + " 공격 → " + playerLabel(firstHit.victim, firstHit.victimId,
            friendly({ actorId: firstHit.victimId, actorTeamId: firstHit.victimTeamId }) ? "ally" : "opponent", firstHit.victimInVehicle) + " 피해 기록"
          + (firstHit.distanceMeters != null ? " (약 " + distanceLabel(firstHit.distanceMeters) + ")" : "")
        : time(encounter.startSeconds) + " 교전";
      const legacyVehicleNames = encounter.vehicle?.match(/^첫 피해 때 (.+)이\(가\) 차량에 타고 있었습니다\.$/u)?.[1].split("·");
      const legacyVehicleContext = encounter.vehicle && !encounter.vehicle.includes("않았습니다")
        ? legacyVehicleNames?.length
          ? legacyVehicleNames.map((name) => participantLabel(name, undefined, "ally") + " 차량 탑승 기록(첫 피해 시점)").join(" · ")
          : "첫 피해 시 차량 탑승 기록 확인"
        : undefined;
      const brief = {
        situation: [situation, rosterSituation, circleContext, ...(!firstHit?.actorInVehicle && legacyVehicleContext ? [legacyVehicleContext] : [])].filter(Boolean).join(" · "),
        action: actionClauses.join(" · ") || (allocated.length ? "기절 기록 없이 처치로 마무리" : "기록된 교전 행동"),
        outcome: [allocated.length ? finishText + " · " + encounterTally : "이 교전에서 처치 기록 없음", rosterOutcome].filter(Boolean).join(" · "),
      };
      const killFacts = allocated.flatMap(({ index, action }) => {
        const kill = teamKills[index];
        const fact = facts.find((item) => item.timeSeconds === kill.timeSeconds
          && item.kind === (kill.killer === story.nickname ? "kill" : "teammate_kill")
          && (!item.actorId || !action.actorId || item.actorId === action.actorId)
          && (!item.victimId || !action.victimId || item.victimId === action.victimId));
        return fact ? [fact] : [];
      });
      const priorSample = overviewSamples.filter((sample) => sample.ranker
        && sample.timeSeconds <= encounter.startSeconds && encounter.startSeconds - sample.timeSeconds <= 30)
        .sort((a, b) => b.timeSeconds - a.timeSeconds)[0];
      const sceneStart = priorSample?.timeSeconds ?? encounter.startSeconds;
      const sceneEnd = Math.min(matchEnd, Math.max(encounter.endSeconds, ...actions.map(({ timeSeconds }) => timeSeconds)));
      const opponentIds = new Set(encounter.opponentIdentity?.playerIds ?? []);
      const opponentNames = new Set(knownOpponents);
      const belongsToEncounter = (sample: Sample) => sample.side !== "opponent"
        || (sample.playerId ? opponentIds.has(sample.playerId)
          : sample.evidenceId === encounter.id && Boolean(sample.playerName && opponentNames.has(sample.playerName)));
      const samples = overviewSamples.filter((sample) => inRange(sample.timeSeconds, sceneStart, sceneEnd)
        && belongsToEncounter(sample));
      const encounterSnapshot = encounter.snapshots?.find(({ offsetSeconds }) => offsetSeconds === 0);
      if (encounterSnapshot && inRange(encounterSnapshot.targetTimeSeconds, sceneStart, sceneEnd)) {
        for (const point of encounterSnapshot.points) {
          if (!inMatch(point.sampleTimeSeconds) || point.side === "opponent"
            && !(point.playerId ? opponentIds.has(point.playerId) : opponentNames.has(point.player))) continue;
          const ageLabel = point.ageSeconds > 0 ? ` · 기준보다 ${Math.round(point.ageSeconds)}초 ${point.sampleTimeSeconds <= encounterSnapshot.targetTimeSeconds ? "전" : "후"} 표본` : "";
          samples.push({ x: point.x / 100, y: point.y / 100, timeSeconds: point.sampleTimeSeconds,
            evidenceId: encounterFact?.id ?? encounter.id, side: point.side, ranker: point.player === story.nickname,
            playerId: point.playerId, playerName: point.player,
            label: time(point.sampleTimeSeconds) + " " + participantLabel(point.player, point.playerId, point.side) + " 관측 위치" + ageLabel,
            sourceIndices: point.sourceIndices });
        }
      }
      const snapshot = mapSnapshot(samples, zone, ownLifeIntervals, ownLifeFacts.length > 0);
      const evidenceIds = unique([...(encounterFact ? [encounterFact.id] : []), ...killFacts.map(({ id }) => id),
        ...(circlePosition ? [circlePosition.sample.evidenceId] : []),
        ...(snapshot?.observations?.map(({ evidenceId }) => evidenceId) ?? []),
        ...(zone ? [factAt("zone", zone.observedSeconds)?.id].filter((id): id is string => Boolean(id)) : [])]);
      const details = actions.map((event) => describeEvent(event));
      const context = [
        ...(circlePosition ? ["흰 원(다음 안전 구역) 기준 · " + circlePosition.text] : []),
        ...(encounter.arrival ? [encounter.arrival] : []),
        ...(legacyVehicleContext ? [legacyVehicleContext] : []),
      ];
      const participantLookup = unique(actions.flatMap((event) => [
        { name: event.actor, id: event.actorId, side: friendly(event) ? "ally" as const : "opponent" as const },
        { name: event.victim, id: event.victimId,
          side: friendly({ actorId: event.victimId, actorTeamId: event.victimTeamId }) ? "ally" as const : "opponent" as const },
      ]).flatMap(({ name, id, side }) => {
        const label = participantLabel(name, id, side);
        return label !== name ? [label + "=" + name] : [];
      }));
      if (participantLookup.length) context.push("참가자 이름: " + participantLookup.join(", "));
      const scene: DailyWalkthroughChapter = {
        id: "combat-" + encounter.id, kind: "combat" as const,
        title: time(encounter.startSeconds) + " 교전" + (allocated.length
          ? " · " + (story.mode === "solo" ? "" : "팀 ") + allocated.length + "킬" : ""),
        startSeconds: sceneStart, anchorSeconds: encounter.startSeconds, endSeconds: sceneEnd,
        evidenceIds, sourceIndices: unique([...(encounterFact?.sourceIndices ?? []), ...(encounter.sourceIndices ?? []),
          ...(circlePosition?.sample.sourceIndices ?? []),
          ...killFacts.flatMap(({ sourceIndices }) => sourceIndices ?? []),
          ...(snapshot?.observations?.flatMap(({ sourceIndices }) => sourceIndices ?? []) ?? [])]),
        brief, situation: brief.situation,
        action: [...context, ...details].join("\n") || brief.action,
        outcome: brief.outcome,
        ...(combatZone ? { combatZone } : {}),
        ...(snapshot ? { mapSnapshot: snapshot } : {}),
      };
      return scene;
    }).filter((scene): scene is DailyWalkthroughChapter => scene !== null);
  // If structured fight grouping is incomplete, retain each unmatched kill as its own
  // clearly labeled scene. Personal kills already present in the team stream stay singular.
  const fallbackScenes = teamKills.flatMap((kill, index): DailyWalkthroughChapter[] => {
    if (assigned.has(index)) return [];
    const fact = facts.find((item) => item.timeSeconds === kill.timeSeconds
      && item.kind === (kill.killer === story.nickname ? "kill" : "teammate_kill"));
    const zone = zones.filter(({ observedSeconds }) => observedSeconds <= kill.timeSeconds).at(-1);
    const text = time(kill.timeSeconds) + " " + participantLabel(kill.killer, undefined, "ally")
      + " " + displayWeapon(kill.weapon) + " 킬";
    const snapshot = mapSnapshot(overviewSamples.filter(({ timeSeconds }) => timeSeconds === kill.timeSeconds), zone,
      ownLifeIntervals, ownLifeFacts.length > 0);
    return [{
      id: "combat-ungrouped-team-" + index, kind: "combat", title: text,
      startSeconds: kill.timeSeconds, anchorSeconds: kill.timeSeconds, endSeconds: kill.timeSeconds,
      evidenceIds: fact ? [fact.id] : [], sourceIndices: fact?.sourceIndices ?? [],
      brief: { situation: "교전 연결 기록 없음", action: text, outcome: "이 킬의 교전 구간은 확인되지 않음" },
      situation: "교전 연결 기록 없음", action: text, outcome: "이 킬의 교전 구간은 확인되지 않음",
      ...(zone ? { combatZone: { phase: zone.phase, observedSeconds: zone.observedSeconds, outsideMeters: zone.outsideMeters,
        ...(zone.shrinkObservedSeconds != null && zone.shrinkObservedSeconds <= kill.timeSeconds
          ? { shrinkObservedSeconds: zone.shrinkObservedSeconds } : {}),
        ...(zone.center && validPoint(zone.center) ? { center: zone.center } : {}),
        ...(zone.radius && Number.isFinite(zone.radius) ? { radius: zone.radius } : {}) } } : {}),
      ...(snapshot ? { mapSnapshot: snapshot } : {}),
    }];
  });
  const missingPersonal = personalKills.flatMap((kill, index): DailyWalkthroughChapter[] => {
    if (teamKills.some((teamKill) => teamKill.killer === story.nickname
      && teamKill.timeSeconds === kill.timeSeconds && teamKill.victim === kill.victim)) return [];
    const fact = facts.find((item) => item.kind === "kill" && item.timeSeconds === kill.timeSeconds);
    const zone = zones.filter(({ observedSeconds }) => observedSeconds <= kill.timeSeconds).at(-1);
    const text = time(kill.timeSeconds) + " 본인 " + displayWeapon(kill.weapon) + " 킬";
    return [{
      id: "combat-ungrouped-personal-" + index, kind: "combat", title: text,
      startSeconds: kill.timeSeconds, anchorSeconds: kill.timeSeconds, endSeconds: kill.timeSeconds,
      evidenceIds: fact ? [fact.id] : [], sourceIndices: fact?.sourceIndices ?? [],
      brief: { situation: story.mode === "solo" ? "교전 연결 기록 없음" : "팀 킬 목록에 없는 개인 킬",
        action: text, outcome: "교전 구간은 확인되지 않음" },
      situation: story.mode === "solo" ? "교전 연결 기록 없음" : "팀 킬 목록에 없는 개인 킬",
      action: text, outcome: "교전 구간은 확인되지 않음",
      ...(zone ? { combatZone: { phase: zone.phase, observedSeconds: zone.observedSeconds, outsideMeters: zone.outsideMeters,
        ...(zone.shrinkObservedSeconds != null && zone.shrinkObservedSeconds <= kill.timeSeconds
          ? { shrinkObservedSeconds: zone.shrinkObservedSeconds } : {}),
        ...(zone.center && validPoint(zone.center) ? { center: zone.center } : {}),
        ...(zone.radius && Number.isFinite(zone.radius) ? { radius: zone.radius } : {}) } } : {}),
    }];
  });
  const combatScenes = [...encounterScenes, ...fallbackScenes, ...missingPersonal]
    .sort((a, b) => a.anchorSeconds - b.anchorSeconds || a.id.localeCompare(b.id));
  const finalEncounterScene = closingEncounter && combatScenes.find(({ id }) => id === "combat-" + closingEncounter.id);
  if (finalHighlight && finalEncounterScene?.brief) {
    const finishSummary = finalHighlight.brief?.outcome;
    finalHighlight.brief = { ...finalEncounterScene.brief,
      outcome: [finalEncounterScene.brief.outcome, finishSummary].filter(Boolean).join(" · ") };
    finalHighlight.situation = finalEncounterScene.situation;
    finalHighlight.action = finalEncounterScene.action;
    finalHighlight.outcome = finalHighlight.brief.outcome;
    finalHighlight.startSeconds = finalEncounterScene.startSeconds;
    finalHighlight.anchorSeconds = finalEncounterScene.anchorSeconds;
    finalHighlight.mapSnapshot = finalEncounterScene.mapSnapshot;
    finalHighlight.combatZone = finalEncounterScene.combatZone;
    finalHighlight.evidenceIds = unique([...finalHighlight.evidenceIds, ...finalEncounterScene.evidenceIds]);
    finalHighlight.sourceIndices = unique([...(finalHighlight.sourceIndices ?? []), ...(finalEncounterScene.sourceIndices ?? [])]);
  }
  const primary = [openingHighlight, finalHighlight, terminalHighlight].filter((scene): scene is DailyWalkthroughChapter => Boolean(scene));
  const baseCap = teamKills.length >= 20 ? 8 : teamKills.length >= 8 ? 6 : teamKills.length >= 3 ? 5 : 4;
  const closingAnchor = terminalHighlight?.anchorSeconds ?? finalHighlight?.anchorSeconds;
  const recoveryImpact = (scene: DailyWalkthroughChapter) => {
    if (ownLifeCycles.some((life) => scene.id === "highlight-player-return-" + life.returned.id)) return 3;
    const revive = facts.find((fact) => fact.kind === "revive" && fact.timeSeconds === scene.anchorSeconds);
    if (!revive?.victimId) return 0;
    return (revive.victimId === rankerId ? 1 : 0)
      + (killFacts.some((kill) => kill.actorId === revive.victimId && kill.timeSeconds > revive.timeSeconds) ? 2 : 0);
  };
  const prioritizedRecoveries = secondary.filter((scene) => scene.kind === "recovery")
    .sort((a, b) => recoveryImpact(b) - recoveryImpact(a) || b.anchorSeconds - a.anchorSeconds)
    .filter((scene) => recoveryImpact(scene) >= 2).slice(0, 2);
  const recoveryBeforeFinal = prioritizedRecoveries[0] ?? secondary.filter((scene) => scene.kind === "recovery"
    && (closingAnchor === undefined || scene.endSeconds < closingAnchor))
    .sort((a, b) => (terminalOutcomeFact ? b.endSeconds - a.endSeconds : a.endSeconds - b.endSeconds))[0];
  const earlyMovement = secondary.filter((scene) => scene.kind === "movement"
    && scene.endSeconds <= (recoveryBeforeFinal?.endSeconds ?? matchEnd))
    .sort((a, b) => a.startSeconds - b.startSeconds)[0];
  const lateMovement = secondary.filter((scene) => scene.kind === "movement"
    && scene.id !== "highlight-opening-movement"
    && scene.endSeconds > (recoveryBeforeFinal?.endSeconds ?? matchStart)
    && (!finalHighlight || scene.endSeconds < finalHighlight.anchorSeconds))
    .sort((a, b) => Number(Boolean(b.movement?.shrinkObservedSeconds != null && b.movement.insideObservedSeconds != null
      && b.movement.shrinkObservedSeconds <= b.movement.insideObservedSeconds))
      - Number(Boolean(a.movement?.shrinkObservedSeconds != null && a.movement.insideObservedSeconds != null
        && a.movement.shrinkObservedSeconds <= a.movement.insideObservedSeconds))
      || (b.movement?.outsideMeters ?? 0) - (a.movement?.outsideMeters ?? 0)
      || (b.endSeconds - b.startSeconds) - (a.endSeconds - a.startSeconds))[0];
  const preserveTwoRecoveriesAndMovements = prioritizedRecoveries.length >= 2 && earlyMovement && lateMovement;
  const cap = preserveTwoRecoveriesAndMovements ? Math.max(baseCap, 8) : lateMovement ? Math.max(baseCap, 7) : baseCap;
  const recoveryPriorityIds = prioritizedRecoveries.map(({ id }) => id);
  const secondaryPriority = (scene: DailyWalkthroughChapter) => {
    const recoveryPriority = recoveryPriorityIds.indexOf(scene.id);
    return recoveryPriority >= 0 ? recoveryPriority
      : scene.id === recoveryBeforeFinal?.id ? recoveryPriorityIds.length
        : scene.id === lateMovement?.id ? recoveryPriorityIds.length + 1
          : scene.id === earlyMovement?.id ? recoveryPriorityIds.length + 2 : recoveryPriorityIds.length + 3;
  };
  const preferred = secondary.toSorted((a, b) => secondaryPriority(a) - secondaryPriority(b));
  const secondarySlots = preserveTwoRecoveriesAndMovements ? 4 : lateMovement ? 3 : cap >= 6 ? 2 : 1;
  const selectedSecondary: DailyWalkthroughChapter[] = [];
  for (const distinctOnly of [true, false]) {
    for (const candidate of preferred) {
      if (selectedSecondary.length >= secondarySlots) break;
      if (primary.some((scene) => scene.id === candidate.id)) continue;
      if (selectedSecondary.some((scene) => scene.id === candidate.id
        || scene.evidenceIds.some((id) => candidate.evidenceIds.includes(id)
          && killFacts.some((fact) => fact.id === id)))) continue;
      if (distinctOnly && selectedSecondary.some((scene) => scene.kind === candidate.kind)
        && candidate.id !== earlyMovement?.id && candidate.id !== lateMovement?.id
        && !recoveryPriorityIds.includes(candidate.id)) continue;
      selectedSecondary.push(candidate);
    }
  }
  const shownKillIds = new Set([...primary, ...selectedSecondary].flatMap(({ evidenceIds }) =>
    evidenceIds.filter((id) => killFacts.some((fact) => fact.id === id))));
  const finalFightId = finalHighlight?.id.replace(/^highlight-/, "combat-");
  const fightCandidates = combatScenes.filter((scene) => scene.id !== finalFightId
    && scene.evidenceIds.some((id) => killFacts.some((fact) => fact.id === id))
    && !scene.evidenceIds.some((id) => shownKillIds.has(id)));
  const chosenFights: DailyWalkthroughChapter[] = [];
  const firstFight = fightCandidates[0];
  if (firstFight && primary.length + selectedSecondary.length < cap) chosenFights.push(firstFight);
  const remaining = fightCandidates.filter((scene) => scene !== firstFight);
  const slots = cap - primary.length - selectedSecondary.length - chosenFights.length;
  // Pick one substantial encounter from each part of the remaining match, then fill gaps.
  const afterFirst = remaining.filter((scene) => !firstFight || scene.anchorSeconds > firstFight.anchorSeconds);
  const spanStart = firstFight?.anchorSeconds ?? matchStart;
  const spanEnd = finalHighlight?.anchorSeconds ?? matchEnd;
  for (let part = 0; part < slots; part++) {
    const left = spanStart + (spanEnd - spanStart) * part / slots;
    const right = spanStart + (spanEnd - spanStart) * (part + 1) / slots;
    const picked = afterFirst.filter((scene) => !chosenFights.includes(scene)
      && scene.anchorSeconds >= left && (part === slots - 1 ? scene.anchorSeconds <= right : scene.anchorSeconds < right))
      .sort((a, b) => b.evidenceIds.filter((id) => killFacts.some((fact) => fact.id === id)).length
        - a.evidenceIds.filter((id) => killFacts.some((fact) => fact.id === id)).length
        || a.anchorSeconds - b.anchorSeconds)[0];
    if (picked) chosenFights.push(picked);
  }
  for (const scene of remaining.toSorted((a, b) =>
    b.evidenceIds.filter((id) => killFacts.some((fact) => fact.id === id)).length
    - a.evidenceIds.filter((id) => killFacts.some((fact) => fact.id === id)).length
    || a.anchorSeconds - b.anchorSeconds)) {
    if (primary.length + selectedSecondary.length + chosenFights.length >= cap) break;
    if (!chosenFights.includes(scene)) chosenFights.push(scene);
  }
  const highlights = [...primary, ...selectedSecondary, ...chosenFights]
    .sort((a, b) => a.startSeconds - b.startSeconds || a.anchorSeconds - b.anchorSeconds);
  const durationLabel = (seconds: number) => {
    const totalSeconds = Math.round(seconds);
    return totalSeconds >= 60
      ? "약 " + Math.floor(totalSeconds / 60) + "분" + (totalSeconds % 60 ? " " + (totalSeconds % 60) + "초" : "")
      : "약 " + totalSeconds + "초";
  };
  const operatingPointFor = (scene: DailyWalkthroughChapter): DailyWalkthroughChapter["operatingPoint"] => {
    const zone = scene.movement?.phase === undefined ? undefined : zones.find((item) => item.phase === scene.movement!.phase
      && item.observedSeconds === scene.movement!.revealedSeconds);
    const zoneFact = zone && factAt("zone", zone.observedSeconds);
    const baseline = zone?.positions?.filter((position) => validPoint(position)
      && Number.isFinite(position.timeSeconds) && position.timeSeconds <= zone.observedSeconds
      && zone.observedSeconds - position.timeSeconds <= 15).at(-1);
    const entryPosition = zone?.positions?.find((position) => position.timeSeconds === zone.firstInsideSeconds
      && validPoint(position) && Number.isFinite(position.timeSeconds));
    const validGeometry = Boolean(zone?.center && validPoint(zone.center) && Number.isFinite(zone.radius) && zone.radius! > 0);
    const baselineOutside = baseline && validGeometry
      ? Math.max(0, Math.hypot(baseline.x - zone!.center!.x, baseline.y - zone!.center!.y) - zone!.radius!) : undefined;
    const entryInside = entryPosition && validGeometry
      && Math.hypot(entryPosition.x - zone!.center!.x, entryPosition.y - zone!.center!.y) <= zone!.radius!;
    const insideSeconds = zone?.firstInsideSeconds;
    if (scene.kind === "movement" && zone && zoneFact && scene.evidenceIds.includes(zoneFact.id)
      && insideSeconds !== null && insideSeconds !== undefined && Number.isFinite(insideSeconds)
      && insideSeconds >= zone.observedSeconds && baseline && entryInside
      && baselineOutside !== undefined && Number.isFinite(baselineOutside)) {
      const shrink = phaseShrink(zone);
      const nextReveal = zones.find((item) => item.observedSeconds > zone.observedSeconds)?.observedSeconds;
      const insideInPhase = nextReveal === undefined || insideSeconds < nextReveal;
      const shrinkInPhase = shrink !== undefined && (nextReveal === undefined || shrink < nextReveal);
      const conditions = time(zone.observedSeconds) + " " + zone.phase + "번째 원 공개 기준 기록 거리 "
        + (baselineOutside > 0 ? "약 " + distanceLabel(baselineOutside) + " 밖" : "원 안")
        + (shrinkInPhase ? " · 관측된 축소 시작까지 " + durationLabel(shrink - zone.observedSeconds) : "") + ".";
      const delta = shrinkInPhase ? insideSeconds - shrink : undefined;
      const entryFact = factAt("route", insideSeconds);
      const boarding = facts.find((fact) => fact.kind === "vehicle" && fact.actorId === rankerId && fact.vehicleName
        && fact.timeSeconds >= zone.observedSeconds && fact.timeSeconds <= insideSeconds
        && scene.evidenceIds.includes(fact.id));
      const movementLead = boarding ? "차량 탑승 뒤 "
        : scene.brief?.situation.includes("교전 뒤") ? "교전 뒤 " : "";
      const point = delta !== undefined
        ? time(insideSeconds) + " " + movementLead + "원 안 위치 확인 · 관측된 축소 시작 약 "
          + durationLabel(Math.abs(delta)).replace(/^약 /, "") + (delta < 0 ? " 전." : " 뒤.")
        : entryFact && scene.evidenceIds.includes(entryFact.id)
          ? time(insideSeconds) + " " + movementLead + "원 안 위치 확인 · 공개 "
            + durationLabel(insideSeconds - zone.observedSeconds) + " 뒤."
          : undefined;
      if (point && insideInPhase) return { conditions, point,
        evidenceIds: unique([zoneFact.id, ...(entryFact && scene.evidenceIds.includes(entryFact.id) ? [entryFact.id] : []),
          ...(boarding ? [boarding.id] : [])]) };
    }
    if (scene.kind === "recovery") {
      const life = ownLifeCycles.find((item) => item.returned.timeSeconds === scene.anchorSeconds
        && scene.evidenceIds.includes(item.returned.id));
      if (life) return {
        conditions: time(life.death.timeSeconds) + " 본인 사망 후 재등장 기록 시점.",
        point: time(life.returned.timeSeconds) + " 본인 재등장 기록"
          + (life.finalDeath ? " · " + time(life.finalDeath.timeSeconds) + " 이후 사망 기록" : ""),
        evidenceIds: unique([life.death.id, life.returned.id, ...(life.finalDeath ? [life.finalDeath.id] : [])]),
      };
      const revive = facts.find((fact) => fact.kind === "revive" && fact.timeSeconds === scene.anchorSeconds
        && fact.victimId && scene.evidenceIds.includes(fact.id));
      const down = revive && facts.find((fact) => fact.kind === "down" && fact.victimId === revive.victimId
        && fact.timeSeconds < revive.timeSeconds && scene.evidenceIds.includes(fact.id));
      if (!revive || !down) return undefined;
      const resumedKill = killFacts.find((fact) => fact.actorId === revive.victimId && fact.timeSeconds > revive.timeSeconds
        && scene.evidenceIds.includes(fact.id));
      const who = revive.victimId === rankerId ? "본인" : nameForId(revive.victimId!);
      return { conditions: time(revive.timeSeconds) + " " + who + " 소생 시점 · 직전 기절 기록 "
          + time(down.timeSeconds) + " (간격 " + durationLabel(revive.timeSeconds - down.timeSeconds) + ").",
        point: resumedKill ? "소생한 " + who + "은 " + time(resumedKill.timeSeconds) + " "
          + displayWeapon(resumedKill.weapon ?? "") + " 킬을 기록했습니다."
          : "기절 기록 후 " + durationLabel(revive.timeSeconds - down.timeSeconds) + "에 소생이 기록됐습니다.",
        evidenceIds: unique([down.id, revive.id, ...(resumedKill ? [resumedKill.id] : [])]) };
    }
    if (scene.kind === "combat") {
      const encounter = encounters.find((item) => "combat-" + item.id === scene.id || "highlight-" + item.id === scene.id);
      const firstAction = encounter?.actions[0];
      const encounterFact = encounter && facts.find((fact) => fact.id === encounter.id && fact.kind === "encounter");
      const kills = encounter?.actions.filter((event) => event.kind === "kill" && event.actorTeamId === rankerTeam).length ?? 0;
      const knocks = encounter?.actions.filter((event) => event.kind === "knock" && event.victimTeamId === encounter.opponentIdentity?.teamId).length ?? 0;
      const allyDowns = encounter?.actions.filter((event) => event.kind === "ally_down" && event.victimTeamId === rankerTeam).length ?? 0;
      if (encounter && encounterFact && scene.evidenceIds.includes(encounterFact.id) && (kills || knocks || allyDowns)) {
        const outcomes = [kills ? (story.mode === "solo" ? "개인 " : "팀 ") + kills + "킬" : "", knocks ? "상대 " + knocks + "명 기절" : "",
          allyDowns ? "아군 " + allyDowns + "명 기절" : ""].filter(Boolean).join(" · ");
        const related = encounter.actions.flatMap((event) => facts.filter((fact) =>
          (fact.kind === "kill" || fact.kind === "teammate_kill" || fact.kind === "knock" || fact.kind === "down")
          && fact.timeSeconds === event.timeSeconds && fact.actorId === event.actorId && fact.victimId === event.victimId
          && fact.sourceIndices?.length));
        return { conditions: time(scene.anchorSeconds) + (firstAction?.distanceMeters == null
          ? " 교전 행동 기록" : " 첫 기록 교전 거리 약 " + distanceLabel(firstAction.distanceMeters) + "."),
          point: time(encounter.endSeconds) + " 교전 결과: " + outcomes + ".",
          evidenceIds: unique([encounterFact.id, ...related.map(({ id }) => id)]) };
      }
    }
    return undefined;
  };
  const movementCandidates = highlights.filter((scene) => scene.kind === "movement")
    .map((scene) => ({ scene, point: operatingPointFor(scene)
      ?? (scene.lesson && !scene.lesson.endsWith("위치 기록")
        ? { conditions: "", point: scene.lesson, evidenceIds: scene.evidenceIds }
        : scene.brief?.action.includes("탑승") && scene.brief.action.includes("원 안")
          ? { conditions: "관측된 탑승과 원 안 위치", point: scene.brief.action, evidenceIds: scene.evidenceIds }
          : undefined) }))
    .filter((candidate): candidate is { scene: DailyWalkthroughChapter; point: NonNullable<DailyWalkthroughChapter["operatingPoint"]> } => Boolean(candidate.point))
    .sort((a, b) => Number(b.scene.id === earlyMovement?.id) - Number(a.scene.id === earlyMovement?.id)
      || Number((b.scene.movement?.outsideMeters ?? 0) > 0) - Number((a.scene.movement?.outsideMeters ?? 0) > 0)
      || b.scene.anchorSeconds - a.scene.anchorSeconds);
  const recoveryCandidates = highlights.filter((scene) => scene.kind === "recovery")
    .map((scene) => ({ scene, point: operatingPointFor(scene) }))
    .filter((candidate): candidate is { scene: DailyWalkthroughChapter; point: NonNullable<DailyWalkthroughChapter["operatingPoint"]> } => Boolean(candidate.point))
    .sort((a, b) => recoveryImpact(b.scene) - recoveryImpact(a.scene) || b.scene.anchorSeconds - a.scene.anchorSeconds);
  const combatCandidates = highlights.filter((scene) => scene.kind === "combat")
    .map((scene) => ({ scene, point: operatingPointFor(scene) }))
    .filter((candidate): candidate is { scene: DailyWalkthroughChapter; point: NonNullable<DailyWalkthroughChapter["operatingPoint"]> } => Boolean(candidate.point));
  const consequentialRecoveries = recoveryCandidates.filter(({ scene }) => recoveryImpact(scene) >= 2);
  const operatingCandidates = [...movementCandidates.slice(0, consequentialRecoveries.length >= 2 ? 1 : 2),
    ...(consequentialRecoveries.length >= 2 ? consequentialRecoveries.slice(0, 2) : recoveryCandidates.slice(0, 1))]
    .slice(0, 3);
  if (!operatingCandidates.length) operatingCandidates.push(...combatCandidates.slice(0, 3));
  for (const { scene, point } of operatingCandidates) scene.operatingPoint = point;
  const operatingTakeaways = operatingCandidates
    .sort((a, b) => a.scene.anchorSeconds - b.scene.anchorSeconds);
  const legacyOperatingScenes = [selectedSecondary.find((scene) => scene.kind === "recovery" && scene.lesson),
    selectedSecondary.filter((scene) => scene.kind === "movement" && scene.lesson).at(-1)]
    .filter((scene): scene is DailyWalkthroughChapter => Boolean(scene))
    .sort((a, b) => a.anchorSeconds - b.anchorSeconds);
  const resultTakeaways = operatingTakeaways.length
    ? operatingTakeaways.map(({ scene, point }) => ({ title: scene.title, text: point.point, evidenceIds: point.evidenceIds }))
    : legacyOperatingScenes.length
      ? legacyOperatingScenes.map((scene) => ({ title: scene.title, text: scene.lesson!, evidenceIds: scene.evidenceIds }))
      : takeaways.slice(0, 2);
  for (const life of ownLifeCycles) {
    const lifeChain = time(life.death.timeSeconds) + " 본인 사망 기록 → "
      + time(life.returned.timeSeconds) + " 본인 재등장 기록"
      + (life.finalDeath ? " → " + time(life.finalDeath.timeSeconds) + " 본인 사망 기록" : "");
    const chapterAtEnd = chapters.find((chapter) => life.finalDeath
      ? life.finalDeath.timeSeconds >= chapter.startSeconds && life.finalDeath.timeSeconds <= chapter.endSeconds
      : life.returned.timeSeconds >= chapter.startSeconds && life.returned.timeSeconds <= chapter.endSeconds)
      ?? chapters.at(-1);
    const visibleChapter = chapterAtEnd && (chapterAtEnd.kind === "opening" || chapterAtEnd.kind === "finish"
      || chapterAtEnd.brief?.action !== "이 구간은 기록 없음")
      ? chapterAtEnd
      : chapters.filter(({ kind, brief }) => kind === "opening" || kind === "finish"
        || brief?.action !== "이 구간은 기록 없음").at(-1);
    if (!visibleChapter || visibleChapter.action.includes(lifeChain)) continue;
    visibleChapter.action = [visibleChapter.action, "본인 생존 기록: " + lifeChain].filter(Boolean).join("\n\n");
    visibleChapter.evidenceIds = unique([...visibleChapter.evidenceIds,
      life.death.id, life.returned.id, ...(life.finalDeath ? [life.finalDeath.id] : [])]);
    visibleChapter.sourceIndices = unique([...(visibleChapter.sourceIndices ?? []),
      ...(life.death.sourceIndices ?? []), ...(life.returned.sourceIndices ?? []), ...(life.finalDeath?.sourceIndices ?? [])]);
  }
  const overviewZone = zones.filter(({ observedSeconds }) => observedSeconds <= matchEnd).at(-1);
  const overview = mapSnapshot(overviewSamples.filter(({ timeSeconds }) => inMatch(timeSeconds)), overviewZone,
    ownLifeIntervals, ownLifeFacts.length > 0);
  const withBlue = (scene: DailyWalkthroughChapter): DailyWalkthroughChapter => {
    if (!scene.mapSnapshot) return scene;
    const blueZone = blueAt(scene.anchorSeconds);
    return blueZone ? { ...scene, mapSnapshot: { ...scene.mapSnapshot, blueZone } } : scene;
  };
  const overviewBlue = overview && blueAt(matchEnd);
  return {
    headline,
    summary: summary.join(" ") || "확인 가능한 경기 기록이 없습니다.",
    chapters: chapters.filter(({ kind, brief }) => kind === "opening" || kind === "finish"
      || brief?.action !== "이 구간은 기록 없음").map(withBlue),
    highlights: highlights.map(withBlue),
    combatScenes: combatScenes.map(withBlue),
    takeaways: resultTakeaways,
    ...(overview ? { overview: overviewBlue ? { ...overview, blueZone: overviewBlue } : overview } : {}),
  };
}
