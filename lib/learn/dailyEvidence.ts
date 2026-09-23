import { MAP_NAMES, getTranslatedWeaponName } from "../pubg-analysis/constants";
import { hasMatchingTelemetryDefinition } from "../pubg-analysis/telemetrySource";

export type DailyEvidenceFact = {
  id: string;
  timeSeconds: number;
  kind: string;
  text: string;
};

export type DailyEvidence = {
  dayKst: string;
  matchId: string;
  accountId: string;
  nickname: string;
  mode: "solo" | "squad";
  mapName: string;
  leaderboardRank: number;
  playedAt: string;
  kills: number;
  damage: number;
  teamKills: number;
  facts: DailyEvidenceFact[];
  weapons: { name: string; kills: number }[];
  killEvents: { timeSeconds: number; victim: string; weapon: string }[];
  zones: { phase: number; observedSeconds: number; outsideMeters: number | null; firstInsideSeconds: number | null }[];
  limitations: string[];
};

type Candidate = { accountId: string; nickname: string; rank: number };
type Input = { match: unknown; events: unknown; candidate: Candidate; dayKst: string };
type AnyRecord = Record<string, any>;

const record = (value: unknown): value is AnyRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isoMs = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
};
const kstDate = (ms: number) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const relativeSeconds = (event: AnyRecord, startMs: number) => {
  const ms = isoMs(event._D);
  return ms === null ? null : Math.max(0, (ms - startMs) / 1000);
};
const characterId = (event: AnyRecord, role: string) => record(event[role]) ? event[role].accountId : undefined;
const vehicleName = (id: unknown) => {
  if (typeof id !== "string") return "차량";
  if (/motorbike|scooter|dirtbike/i.test(id)) return "오토바이";
  if (/buggy/i.test(id)) return "버기";
  if (/mirado/i.test(id)) return "미라도";
  if (/pickup|truck/i.test(id)) return "픽업트럭";
  return "차량";
};
const timeLabel = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;

/** Build only measured facts for a verified Steam competitive win. */
export function buildDailyEvidence({ match, events, candidate, dayKst }: Input): DailyEvidence {
  if (!record(match) || !record(match.data) || !record(match.data.attributes) || !Array.isArray(match.included)) {
    throw new Error("invalid PUBG match response");
  }
  if (!candidate || typeof candidate.accountId !== "string" || !candidate.accountId.trim()
    || typeof candidate.nickname !== "string" || !candidate.nickname.trim()
    || !finite(candidate.rank) || candidate.rank < 1) throw new Error("invalid leaderboard candidate");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKst) || kstDate(Date.parse(`${dayKst}T00:00:00+09:00`)) !== dayKst) {
    throw new Error("invalid KST day");
  }

  const matchData = match.data;
  const attributes = matchData.attributes;
  const matchId = matchData.id;
  if (typeof matchId !== "string" || !matchId) throw new Error("match id missing");
  if (attributes.shardId !== "steam") throw new Error("match is not Steam");
  const rawMode = String(attributes.gameMode ?? "").toLowerCase();
  const mode = rawMode === "solo" ? "solo" : rawMode === "squad" ? "squad" : null;
  if (!mode || attributes.matchType !== "competitive" || attributes.isCustomMatch === true) {
    throw new Error("match is not competitive solo/squad");
  }
  const createdMs = isoMs(attributes.createdAt);
  if (createdMs === null || kstDate(createdMs) !== dayKst) throw new Error("match is not from requested KST day");
  if (!Array.isArray(events) || !hasMatchingTelemetryDefinition(events, matchId, "steam")) {
    throw new Error("telemetry definition does not match match id and platform");
  }

  const participants = match.included.filter((entry: unknown) => record(entry) && entry.type === "participant" && record(entry.attributes) && record(entry.attributes.stats));
  const matches = participants.filter((entry: AnyRecord) => entry.attributes.stats.playerId === candidate.accountId);
  if (matches.length !== 1) throw new Error("candidate account identity does not match exactly one participant");
  const stats = matches[0].attributes.stats;
  if (typeof stats.name !== "string" || (candidate.nickname && stats.name !== candidate.nickname)) {
    throw new Error("candidate nickname does not match account participant");
  }
  if (stats.winPlace !== 1) throw new Error("candidate did not win the match");
  if (!finite(stats.kills) || stats.kills < 0 || !finite(stats.damageDealt) || !finite(stats.teamKills ?? 0)) {
    throw new Error("participant kill/damage statistics missing");
  }

  const start = events.find((event: unknown) => record(event) && event._T === "LogMatchStart");
  const startMs = start && record(start) ? isoMs(start._D) : null;
  if (startMs === null) throw new Error("match start timestamp missing");
  const killEvents = events
    .filter((event: unknown) => record(event) && event._T === "LogPlayerKillV2" && characterId(event, "killer") === candidate.accountId)
    .map((event: AnyRecord) => {
      const timeSeconds = relativeSeconds(event, startMs);
      if (timeSeconds === null) return null;
      // A teammate can finish this player's knock with a different weapon. The
      // credited killer's damage info describes the weapon behind this kill.
      const rawWeapon = event.killerDamageInfo?.damageCauserName
        ?? event.dBNODamageInfo?.damageCauserName
        ?? (characterId(event, "finisher") === candidate.accountId ? event.finishDamageInfo?.damageCauserName : undefined);
      const victim = typeof event.victim?.name === "string" ? event.victim.name : "알 수 없는 상대";
      const translated = rawWeapon ? getTranslatedWeaponName(String(rawWeapon)) : "무기 확인 불가";
      const weapon = /^(Weap|Player|Proj|Item_|Damage_)/.test(translated) ? "무기 확인 불가" : translated;
      return { timeSeconds, victim, weapon };
    })
    .filter((event: { timeSeconds: number; victim: string; weapon: string } | null): event is { timeSeconds: number; victim: string; weapon: string } => event !== null)
    .sort((a: { timeSeconds: number }, b: { timeSeconds: number }) => a.timeSeconds - b.timeSeconds);
  if (killEvents.length !== stats.kills) throw new Error(`telemetry kill count mismatch: api=${stats.kills}, telemetry=${killEvents.length}`);

  const weapons = [...killEvents.reduce((counts: Map<string, number>, event: { weapon: string }) => {
    counts.set(event.weapon, (counts.get(event.weapon) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()).entries()]
    .map(([name, kills]) => ({ name, kills }))
    .sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name));
  const facts: DailyEvidenceFact[] = killEvents.map((event: { timeSeconds: number; victim: string; weapon: string }, index: number) => ({
    id: `kill-${index + 1}`,
    timeSeconds: event.timeSeconds,
    kind: "kill",
    text: `${event.victim} 처치 (${event.weapon})`,
  }));

  const winningRoster = participants.filter((entry: AnyRecord) => entry.attributes.stats.winPlace === 1);
  const rosterIds = new Set<string>(winningRoster.map((entry: AnyRecord) => entry.attributes.stats.playerId).filter((id: unknown): id is string => typeof id === "string"));
  const teammateIds = new Set([...rosterIds].filter((id) => id !== candidate.accountId));
  const rosterKills = winningRoster.reduce((sum: number, entry: AnyRecord) => {
    const count = entry.attributes.stats.kills;
    return sum + (finite(count) && count >= 0 ? count : 0);
  }, 0);
  if (mode === "squad") {
    const teamEvents = events.filter((event: unknown) => record(event) && event._T === "LogPlayerKillV2");
    for (const event of teamEvents as AnyRecord[]) {
      const eventSeconds = relativeSeconds(event, startMs);
      if (eventSeconds === null) continue;
      if (teammateIds.has(characterId(event, "killer"))) {
        facts.push({
          id: `teammate-kill-${eventSeconds.toFixed(3)}`,
          timeSeconds: eventSeconds,
          kind: "teammate_kill",
          text: `팀원 ${event.killer?.name ?? "알 수 없는 팀원"} 처치: ${event.victim?.name ?? "알 수 없는 상대"}`,
        });
      }
      if (teammateIds.has(characterId(event, "victim"))) {
        facts.push({
          id: `teammate-death-${eventSeconds.toFixed(3)}`,
          timeSeconds: eventSeconds,
          kind: "teammate_death",
          text: `팀원 ${event.victim?.name ?? "알 수 없는 팀원"} 사망 이벤트${event.killer?.name ? ` (처치자 ${event.killer.name})` : ""}`,
        });
      }
    }
  }

  const playerIds = mode === "squad" ? rosterIds : new Set([candidate.accountId]);
  for (const event of events as AnyRecord[]) {
    if (event._T !== "LogParachuteLanding" || characterId(event, "character") !== candidate.accountId) continue;
    const timeSeconds = relativeSeconds(event, startMs);
    const location = event.character?.location;
    if (timeSeconds === null || !record(location) || !finite(location.x) || !finite(location.y)) continue;
    const place = Array.isArray(event.character.zone) && event.character.zone.length
      ? `, ${event.character.zone.join(", ")}`
      : "";
    facts.push({
      id: "landing",
      timeSeconds,
      kind: "landing",
      text: `착지: (${(location.x / 100).toFixed(0)}, ${(location.y / 100).toFixed(0)})m${place}`,
    });
  }
  for (const [index, event] of (events as AnyRecord[]).filter((item) => item._T === "LogVehicleRide"
    && characterId(item, "character") === candidate.accountId).entries()) {
    const timeSeconds = relativeSeconds(event, startMs);
    if (timeSeconds === null) continue;
    const vehicle = vehicleName(event.vehicle?.vehicleId);
    facts.push({ id: `vehicle-${index + 1}`, timeSeconds, kind: "vehicle", text: `${vehicle} 탑승 이벤트` });
  }

  const combatEvents = (events as AnyRecord[]).flatMap((event) => {
    const timeSeconds = relativeSeconds(event, startMs);
    if (timeSeconds === null) return [];
    if (event._T === "LogPlayerTakeDamage") {
      const attackerId = characterId(event, "attacker");
      const victimId = characterId(event, "victim");
      if (typeof attackerId !== "string" || typeof victimId !== "string"
        || attackerId === victimId || (playerIds.has(attackerId) === playerIds.has(victimId))) return [];
      const damage = finite(event.damage) ? event.damage : 0;
      return [{ timeSeconds, damageOut: playerIds.has(attackerId) && !playerIds.has(victimId) ? damage : 0,
        damageIn: playerIds.has(victimId) && !playerIds.has(attackerId) ? damage : 0, kills: 0 }];
    }
    if (event._T === "LogPlayerKillV2") {
      const killerId = characterId(event, "killer") ?? characterId(event, "finisher");
      const victimId = characterId(event, "victim");
      if (!playerIds.has(killerId) && !playerIds.has(victimId)) return [];
      return [{ timeSeconds, damageOut: 0, damageIn: 0, kills: playerIds.has(killerId) && !playerIds.has(victimId) ? 1 : 0 }];
    }
    return [];
  }).sort((a, b) => a.timeSeconds - b.timeSeconds);
  const fights: typeof combatEvents[] = [];
  for (const event of combatEvents) {
    const group = fights.at(-1);
    if (!group || event.timeSeconds - group[group.length - 1].timeSeconds > 30) fights.push([event]);
    else group.push(event);
  }
  fights.forEach((fight, index) => {
    const damageOut = fight.reduce((sum, event) => sum + event.damageOut, 0);
    const damageIn = fight.reduce((sum, event) => sum + event.damageIn, 0);
    const kills = fight.reduce((sum, event) => sum + event.kills, 0);
    facts.push({
      id: `fight-${index + 1}`,
      timeSeconds: fight[0].timeSeconds,
      kind: "fight",
      text: `${mode === "squad" ? "팀 교전 관측: 팀" : "교전 관측:"} ${kills}킬, ${mode === "squad" ? "팀 " : ""}준 피해 ${Math.round(damageOut)}, ${mode === "squad" ? "팀 " : ""}받은 피해 ${Math.round(damageIn)} (${timeLabel(fight[fight.length - 1].timeSeconds)}까지)`,
    });
  });

  const phaseEvents = events.filter((event: unknown) => record(event) && event._T === "LogPhaseChange" && Number.isInteger(event.phase)) as AnyRecord[];
  const periodic = events.filter((event: unknown) => record(event) && event._T === "LogGameStatePeriodic" && record(event.gameState)) as AnyRecord[];
  const positions = events.filter((event: unknown) => record(event) && event._T === "LogPlayerPosition" && record(event.character)
    && event.character.accountId === candidate.accountId && record(event.character.location)) as AnyRecord[];
  const killTime = events
    .filter((event: unknown) => record(event) && event._T === "LogPlayerKillV2" && characterId(event, "victim") === candidate.accountId)
    .map((event: AnyRecord) => relativeSeconds(event, startMs))
    .filter((seconds: number | null): seconds is number => seconds !== null)
    .sort((a: number, b: number) => a - b)[0] ?? Infinity;
  const zoneObservations: Array<{ phase: number; observedSeconds: number; center: { x: number; y: number }; radius: number }> = [];
  let previousCircle = "";
  for (const sample of periodic) {
    const seconds = relativeSeconds(sample, startMs);
    const state = sample.gameState;
    const position = state.poisonGasWarningPosition;
    const radius = state.poisonGasWarningRadius;
    if (seconds === null || seconds > killTime || !record(position) || !finite(radius) || radius <= 0
      || !finite(position.x) || !finite(position.y)) continue;
    const key = [position.x, position.y, radius].map(Math.round).join(":");
    if (key === previousCircle) continue;
    previousCircle = key;
    const phase = phaseEvents
      .filter((event) => (relativeSeconds(event, startMs) ?? Infinity) <= seconds)
      .at(-1)?.phase;
    if (!Number.isInteger(phase)) continue;
    zoneObservations.push({ phase, observedSeconds: seconds, center: { x: position.x / 100, y: position.y / 100 }, radius: radius / 100 });
  }
  const playerPositions = positions.map((event) => ({ event, seconds: relativeSeconds(event, startMs) }))
    .filter((item): item is { event: AnyRecord; seconds: number } => item.seconds !== null)
    .sort((a, b) => a.seconds - b.seconds);
  const distance = (event: AnyRecord, center: { x: number; y: number }) => Math.hypot(
    event.character.location.x / 100 - center.x,
    event.character.location.y / 100 - center.y,
  );
  const zones: DailyEvidence["zones"] = zoneObservations.map((zone, index) => {
    const endSeconds = zoneObservations[index + 1]?.observedSeconds ?? Infinity;
    const previous = playerPositions.filter((item) => item.seconds <= zone.observedSeconds).at(-1);
    const recentPrevious = previous && zone.observedSeconds - previous.seconds <= 15 ? previous : null;
    const futurePositions = playerPositions.filter((item) => item.seconds >= zone.observedSeconds && item.seconds < endSeconds && item.seconds <= killTime);
    const firstInside = futurePositions.find((item) => distance(item.event, zone.center) <= zone.radius);
    return {
      phase: zone.phase,
      observedSeconds: zone.observedSeconds,
      outsideMeters: recentPrevious ? Math.max(0, distance(recentPrevious.event, zone.center) - zone.radius) : null,
      firstInsideSeconds: firstInside?.seconds ?? null,
    };
  });
  zones.forEach((zone) => facts.push({
    id: `zone-${zone.phase}`,
    timeSeconds: zone.observedSeconds,
    kind: "zone",
    text: `자기장 ${zone.phase}페이즈 관측${zone.outsideMeters === null ? " (위치 근거 없음)" : zone.outsideMeters > 0 ? `: 원 경계 밖 약 ${Math.round(zone.outsideMeters)}m` : ": 관측 시 원 안"}`,
  }));

  const limitations = [
    "텔레메트리는 위치·킬·자기장 이벤트만 직접 확인합니다. 시야, 엄폐, 이동 의도, 교전 선택의 이유는 판정하지 않습니다.",
    "자기장 거리는 원 공개 후 확인된 독성 가스 경고 원과 직전 15초 내 위치로 계산한 직선거리이며, 실제 이동 경로와 지형은 반영하지 않습니다.",
    ...(mode === "squad" ? ["개인 처치 무기는 킬 귀속자의 공격 기록 기준입니다. 팀원이 다른 무기로 마무리한 경우 그 무기와 다를 수 있습니다."] : []),
  ];
  return {
    dayKst,
    matchId,
    accountId: candidate.accountId,
    nickname: stats.name,
    mode,
    mapName: MAP_NAMES[String(attributes.mapName)] ?? String(attributes.mapName ?? "알 수 없는 맵"),
    leaderboardRank: candidate.rank,
    playedAt: new Date(createdMs).toISOString(),
    kills: stats.kills,
    damage: Math.round(stats.damageDealt),
    teamKills: mode === "squad" ? rosterKills : stats.kills,
    facts: facts.sort((a, b) => a.timeSeconds - b.timeSeconds || a.id.localeCompare(b.id)),
    weapons,
    killEvents,
    zones,
    limitations,
  };
}
