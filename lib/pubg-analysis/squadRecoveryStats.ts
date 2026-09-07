import type { TimelineEvent } from "./types";
import { normalizeName } from "./utils";
import { MAP_NAMES, MAP_SIZES } from "./constants";

const SMOKE_RESCUE_SMOKE_WINDOW_MS = 15_000;
const SMOKE_RESCUE_REVIVE_WINDOW_MS = 30_000;
const SMOKE_RESCUE_MAX_DISTANCE_M = 100;

export interface SquadSmokeRescueCandidate {
  id: string;
  victim: string;
  knockTs: number;
  smokeTs: number;
  reviveTs: number;
  smokeUser?: string;
  reviver?: string;
  smokeDeltaMs: number;
  reviveDeltaMs: number;
  smokeDistanceM: number | null;
}

export interface SquadRecoveryStats {
  squadRevives: number;
  squadSmokeRescues: number | null;
  smokeRescueCandidates: SquadSmokeRescueCandidate[];
}

function isSmokeEvent(event: TimelineEvent): boolean {
  if (event.type !== "ITEM_USE") return false;
  const weapon = (event.weapon || "").toLowerCase();
  return weapon.includes("smoke") || weapon.includes("m79") || weapon.includes("연막");
}

export function hasSquadRecoveryTimelineSignals(timeline: TimelineEvent[] = []): boolean {
  return timeline.some(event =>
    event.type === "TEAM_KNOCK" ||
    event.type === "DOWNED" ||
    event.type === "REVIVE" ||
    event.type === "TEAM_REVIVE" ||
    isSmokeEvent(event)
  );
}

function getEventPoint(event: TimelineEvent): { x: number; y: number } | null {
  const x = typeof event.x === "number" ? event.x : event.victimX;
  const y = typeof event.y === "number" ? event.y : event.victimY;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x === 0 && y === 0) return null;
  return { x, y };
}

function getDistanceM(a: TimelineEvent, b: TimelineEvent, mapName?: string): number | null {
  const pointA = getEventPoint(a);
  const pointB = getEventPoint(b);
  if (!pointA || !pointB) return null;

  const dx = pointA.x - pointB.x;
  const dy = pointA.y - pointB.y;
  // Timeline coordinates are scaled to 8192 for map rendering, not meters.
  const canonicalMap = Object.keys(MAP_NAMES).find((key) => MAP_NAMES[key] === mapName) || mapName;
  const mapSizeCm = canonicalMap ? MAP_SIZES[canonicalMap.toLowerCase().split("_")[0]] : 819200;
  return mapSizeCm ? Math.hypot(dx, dy) * mapSizeCm / 8192 / 100 : null;
}

function getActorName(event: TimelineEvent): string | undefined {
  return event.playerName || event.attacker;
}

export function deriveSquadRecoveryStatsFromTimeline(timeline: TimelineEvent[] = [], mapName?: string): SquadRecoveryStats {
  const sortedTimeline = timeline.filter((event) => Number.isFinite(event.ts)).sort((a, b) => a.ts - b.ts);
  const knockEvents = sortedTimeline.filter(event =>
    (event.type === "TEAM_KNOCK" || event.type === "DOWNED") && normalizeName(event.victim || "")
  );
  const smokeEvents = sortedTimeline.filter(isSmokeEvent);
  const reviveEvents = sortedTimeline.filter(event =>
    (event.type === "REVIVE" || event.type === "TEAM_REVIVE") && normalizeName(event.victim || "")
  );

  const uniqueReviveKeys = new Set<string>();
  reviveEvents.forEach(event => {
    uniqueReviveKeys.add(`${normalizeName(event.victim || "")}:${event.ts}`);
  });

  const smokeRescueCandidates: SquadSmokeRescueCandidate[] = [];
  const usedRevives = new Set<string>();

  let incompleteSmokeEvidence = false;
  knockEvents.forEach(knock => {
    const victimName = normalizeName(knock.victim || "");
    // A death, repeated knock or first revive closes this victim's episode.
    // Never attach a later life's revive to a previous knock.
    const closure = sortedTimeline.find(event => event !== knock && event.ts >= knock.ts
      && normalizeName(event.victim || "") === victimName
      && ["REVIVE", "TEAM_REVIVE", "DIED", "TEAM_DIED", "TEAM_KNOCK", "DOWNED"].includes(event.type)
      && !(event.ts === knock.ts && ["TEAM_KNOCK", "DOWNED"].includes(event.type)));
    if (!closure || !["REVIVE", "TEAM_REVIVE"].includes(closure.type)
      || closure.ts - knock.ts > SMOKE_RESCUE_REVIVE_WINDOW_MS) return;
    const revive = closure;
    if (usedRevives.has(`${victimName}:${revive.ts}`)) return;
    let unknownDistance = false;
    const smoke = smokeEvents.find(event => {
      if (event.ts < knock.ts || event.ts > revive.ts || event.ts - knock.ts > SMOKE_RESCUE_SMOKE_WINDOW_MS) return false;
      const distance = getDistanceM(event, knock, mapName);
      if (distance === null) unknownDistance = true;
      return distance !== null && distance <= SMOKE_RESCUE_MAX_DISTANCE_M;
    });
    if (!smoke) {
      if (unknownDistance) incompleteSmokeEvidence = true;
      return;
    }

    const rescueKey = `${victimName}:${knock.ts}`;
    usedRevives.add(`${victimName}:${revive.ts}`);

    smokeRescueCandidates.push({
      id: rescueKey,
      victim: knock.victim || victimName,
      knockTs: knock.ts,
      smokeTs: smoke.ts,
      reviveTs: revive.ts,
      smokeUser: getActorName(smoke),
      reviver: getActorName(revive),
      smokeDeltaMs: smoke.ts - knock.ts,
      reviveDeltaMs: revive.ts - knock.ts,
      smokeDistanceM: getDistanceM(smoke, knock, mapName)
    });
  });

  return {
    squadRevives: uniqueReviveKeys.size,
    squadSmokeRescues: incompleteSmokeEvidence ? null : smokeRescueCandidates.length,
    smokeRescueCandidates
  };
}
