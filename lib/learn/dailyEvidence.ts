import { MAP_NAMES, getTranslatedWeaponName } from "../pubg-analysis/constants";
import { hasMatchingTelemetryDefinition } from "../pubg-analysis/telemetrySource";
import { buildDailyCombatStory, type DailyEncounter, type DailyWeaponFind } from "./dailyCombatStory";

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
  roster?: { name: string; kills: number; isRanker: boolean }[];
  encounters?: DailyEncounter[];
  weaponFinds?: DailyWeaponFind[];
  facts: DailyEvidenceFact[];
  weapons: { name: string; kills: number }[];
  killEvents: { timeSeconds: number; victim: string; weapon: string; distanceMeters?: number }[];
  teamKillEvents: { timeSeconds: number; killer: string; victim: string; weapon: string; attackId: number | null; distanceMeters?: number }[];
  route: { timeSeconds: number; x: number; y: number; place: string | null; spreadMeters: number; players: { name: string; x: number; y: number }[] }[];
  aircraft: { timeSeconds: number; x: number; y: number }[];
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
const timeLabel = (seconds: number) => {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60).toString().padStart(2, "0")}:${(whole % 60).toString().padStart(2, "0")}`;
};
const placeName = (value: string) => ({ lacobreria: "라 코브레리아", cruzdelvalle: "크루즈 델 바예" })[value.toLowerCase()] ?? value;
const creditedWeapon = (event: AnyRecord, accountId: string) => {
  const rawWeapon = event.killerDamageInfo?.damageCauserName
    ?? event.dBNODamageInfo?.damageCauserName
    ?? (characterId(event, "finisher") === accountId ? event.finishDamageInfo?.damageCauserName : undefined);
  const translated = rawWeapon ? getTranslatedWeaponName(String(rawWeapon)) : "무기 확인 불가";
  return /^(Weap|Player|Proj|Item_|Damage_)/.test(translated) ? "무기 확인 불가" : translated;
};
const eventPosition = (event: AnyRecord) => {
  const location = event.character?.location;
  return record(location) && finite(location.x) && finite(location.y)
    ? { x: location.x / 100, y: location.y / 100 } : null;
};
const characterDistance = (first: AnyRecord | undefined, second: AnyRecord | undefined) => {
  const a = first?.location;
  const b = second?.location;
  return record(a) && record(b) && finite(a.x) && finite(a.y) && finite(b.x) && finite(b.y)
    ? Math.round(Math.hypot(a.x - b.x, a.y - b.y) / 100) : null;
};

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
      const victim = typeof event.victim?.name === "string" ? event.victim.name : "알 수 없는 상대";
      const weapon = creditedWeapon(event, candidate.accountId);
      const distanceMeters = characterDistance(event.killer, event.victim);
      return { timeSeconds, victim, weapon, ...(distanceMeters === null ? {} : { distanceMeters }) };
    })
    .filter((event: { timeSeconds: number; victim: string; weapon: string; distanceMeters?: number } | null): event is { timeSeconds: number; victim: string; weapon: string; distanceMeters?: number } => event !== null)
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
    text: `${event.victim} 처치 · ${event.weapon}${"distanceMeters" in event ? ` · 상대와 약 ${event.distanceMeters}m` : ""}`,
  }));

  const winningRoster = participants.filter((entry: AnyRecord) => entry.attributes.stats.winPlace === 1);
  const rosterIds = new Set<string>(winningRoster.map((entry: AnyRecord) => entry.attributes.stats.playerId).filter((id: unknown): id is string => typeof id === "string"));
  const teammateIds = new Set([...rosterIds].filter((id) => id !== candidate.accountId));
  const roster = winningRoster.map((entry: AnyRecord) => ({ name: String(entry.attributes.stats.name ?? "이름 확인 불가"),
    kills: Number(entry.attributes.stats.kills ?? 0), isRanker: entry.attributes.stats.playerId === candidate.accountId }));
  const participantNames = new Map<string, string>(participants.map((entry: AnyRecord) => [
    entry.attributes.stats.playerId, String(entry.attributes.stats.name ?? "이름 확인 불가"),
  ]));
  const { encounters, weaponFinds } = buildDailyCombatStory(events as AnyRecord[], startMs,
    candidate.accountId, rosterIds, participantNames);
  const rosterKills = winningRoster.reduce((sum: number, entry: AnyRecord) => {
    const count = entry.attributes.stats.kills;
    return sum + (finite(count) && count >= 0 ? count : 0);
  }, 0);
  const teamKillEvents = (events as AnyRecord[])
    .filter((event) => event._T === "LogPlayerKillV2" && rosterIds.has(characterId(event, "killer")))
    .flatMap((event) => {
      const timeSeconds = relativeSeconds(event, startMs);
      if (timeSeconds === null) return [];
      const distanceMeters = characterDistance(event.killer, event.victim);
      return [{ timeSeconds, killer: String(event.killer?.name ?? "알 수 없는 팀원"),
        victim: String(event.victim?.name ?? "알 수 없는 상대"),
        weapon: creditedWeapon(event, characterId(event, "killer")), attackId: finite(event.attackId) ? event.attackId : null,
        ...(distanceMeters === null ? {} : { distanceMeters }) }];
    }).sort((a, b) => a.timeSeconds - b.timeSeconds);
  if (teamKillEvents.length !== rosterKills) throw new Error(`telemetry team kill count mismatch: api=${rosterKills}, telemetry=${teamKillEvents.length}`);
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
          text: `아군 ${event.killer?.name ?? "알 수 없는 팀원"} → 상대 ${event.victim?.name ?? "알 수 없는 상대"} 처치 · ${creditedWeapon(event, characterId(event, "killer"))}${characterDistance(event.killer, event.victim) === null ? "" : ` · 상대와 약 ${characterDistance(event.killer, event.victim)}m`}`,
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
  encounters.forEach((encounter) => {
    const first = encounter.actions.find((action) => action.kind === "first_hit");
    facts.push({ id: encounter.id, timeSeconds: encounter.startSeconds, kind: "encounter",
      text: `상대 팀(${encounter.opponents.join("·")})과 교전 · 첫 확인 피해 ${first ? `${first.actor}의 ${first.weapon} → ${first.victim}${first.distanceMeters === null ? "" : ` (약 ${first.distanceMeters}m)`}` : "확인 불가"} · 아군 ${encounter.teamKills}킬${encounter.rankerWeapons.length ? ` · 랭커가 쏜 총 ${encounter.rankerWeapons.join(" → ")}` : ""}` });
  });
  weaponFinds.filter((find) => find.source === "carepackage" || find.source === "lootbox")
    .forEach((find, index) => facts.push({ id: `weapon-find-${index + 1}`, timeSeconds: find.timeSeconds,
      kind: "weapon_find", text: `${find.player} · ${find.weapon} 획득 · ${find.source === "carepackage" ? "보급 상자" : `${find.owner ?? "다른 선수"}의 전리품 상자`}` }));

  const playerIds = mode === "squad" ? rosterIds : new Set([candidate.accountId]);
  const positionEvents = (events as AnyRecord[]).filter((event) => event._T === "LogPlayerPosition"
    && playerIds.has(characterId(event, "character")) && eventPosition(event));
  const targetPositions = positionEvents.filter((event) => characterId(event, "character") === candidate.accountId);
  const aircraft = targetPositions.filter((event) => /TransportAircraft/i.test(String(event.vehicle?.vehicleId ?? "")))
    .flatMap((event) => {
      const timeSeconds = relativeSeconds(event, startMs);
      const position = eventPosition(event);
      return timeSeconds === null || !position ? [] : [{ timeSeconds, ...position }];
    }).slice(0, 12);
  if (aircraft.length) facts.push({ id: "aircraft", timeSeconds: aircraft[0].timeSeconds, kind: "aircraft",
    text: `비행기 위치가 ${aircraft.length}번 기록됐습니다. 전체 비행 경로는 확인할 수 없습니다.` });
  for (const event of events as AnyRecord[]) {
    if (event._T !== "LogParachuteLanding" || !playerIds.has(characterId(event, "character"))) continue;
    const timeSeconds = relativeSeconds(event, startMs);
    const position = eventPosition(event);
    if (timeSeconds === null || !position) continue;
    const immediatePosition = positionEvents.find((item) => characterId(item, "character") === characterId(event, "character")
      && (relativeSeconds(item, startMs) ?? Infinity) >= timeSeconds
      && (relativeSeconds(item, startMs) ?? Infinity) <= timeSeconds + 15
      && Array.isArray(item.character?.zone) && item.character.zone.length);
    const zone = Array.isArray(event.character?.zone) && event.character.zone.length
      ? event.character.zone : immediatePosition?.character?.zone;
    const place = Array.isArray(zone) && zone.length ? zone.map(placeName).join(", ") : null;
    facts.push({
      id: characterId(event, "character") === candidate.accountId ? "landing" : `landing-${characterId(event, "character")}`,
      timeSeconds,
      kind: "landing",
      text: `${mode === "squad" ? `${event.character?.name ?? "팀원"} ` : ""}${place ? `${place} 근처에 ` : ""}착지`,
    });
  }
  const route: DailyEvidence["route"] = [];
  if (targetPositions.length) {
    const timed = targetPositions.flatMap((event) => {
      const timeSeconds = relativeSeconds(event, startMs);
      return timeSeconds === null ? [] : [{ event, timeSeconds }];
    }).sort((a, b) => a.timeSeconds - b.timeSeconds);
    const firstLanding = facts.find((fact) => fact.id === "landing")?.timeSeconds ?? timed[0].timeSeconds;
    const lastSeconds = timed.at(-1)!.timeSeconds;
    const anchors = [firstLanding, ...Array.from({ length: Math.floor(lastSeconds / 180) }, (_, index) => (index + 1) * 180), lastSeconds];
    for (const anchor of anchors) {
      const sample = timed.reduce((best, current) => Math.abs(current.timeSeconds - anchor) < Math.abs(best.timeSeconds - anchor) ? current : best);
      if (Math.abs(sample.timeSeconds - anchor) > 20 || route.some((point) => Math.abs(point.timeSeconds - sample.timeSeconds) < 25)) continue;
      const target = eventPosition(sample.event)!;
      const nearby = positionEvents.filter((event) => Math.abs((relativeSeconds(event, startMs) ?? Infinity) - sample.timeSeconds) <= 15);
      const players = [...playerIds].flatMap((id) => {
        const selected = nearby.filter((event) => characterId(event, "character") === id)
          .sort((a, b) => Math.abs((relativeSeconds(a, startMs) ?? Infinity) - sample.timeSeconds)
            - Math.abs((relativeSeconds(b, startMs) ?? Infinity) - sample.timeSeconds))[0];
        const position = selected && eventPosition(selected);
        return position ? [{ name: String(selected.character?.name ?? "팀원"), ...position }] : [];
      });
      const spreadMeters = Math.max(0, ...players.map((player) => Math.hypot(player.x - target.x, player.y - target.y)));
      const zone = sample.event.character?.zone;
      route.push({ timeSeconds: sample.timeSeconds, ...target,
        place: Array.isArray(zone) && zone.length ? zone.map(placeName).join(", ") : null,
        spreadMeters, players });
    }
  }
  route.forEach((point, index) => facts.push({ id: `route-${index + 1}`, timeSeconds: point.timeSeconds, kind: "route",
    text: `${mode === "squad" ? `팀 ${point.players.length}명 위치 표본` : "위치 표본"}: 대상 (${Math.round(point.x)}, ${Math.round(point.y)})m${point.place ? ` · ${point.place}` : ""}${mode === "squad" ? ` · 대상과 관측 팀원 최대 거리 약 ${Math.round(point.spreadMeters)}m` : ""}` }));
  if (mode === "squad" && route.length) {
    const timedPositions = positionEvents.flatMap((event) => {
      const timeSeconds = relativeSeconds(event, startMs);
      const position = eventPosition(event);
      return timeSeconds === null || !position ? [] : [{ timeSeconds, accountId: characterId(event, "character"), ...position }];
    });
    let stableWindow: { start: number; end: number; maxDrift: number } | null = null;
    const lastTime = route.at(-1)!.timeSeconds;
    for (let windowStart = 300; windowStart + 180 <= lastTime; windowStart += 30) {
      const drifts = [...playerIds].map((id) => {
        const samples = timedPositions.filter((item) => item.accountId === id && item.timeSeconds >= windowStart && item.timeSeconds <= windowStart + 180);
        if (samples.length < 8 || samples.at(-1)!.timeSeconds - samples[0].timeSeconds < 150) return Infinity;
        return Math.max(...samples.map((item) => Math.hypot(item.x - samples[0].x, item.y - samples[0].y)));
      });
      const maxDrift = Math.max(...drifts);
      if (maxDrift <= 150) stableWindow = { start: windowStart, end: windowStart + 180, maxDrift };
    }
    if (stableWindow) facts.push({ id: "stable-position", timeSeconds: stableWindow.start, kind: "hold",
      text: `${timeLabel(stableWindow.start)}~${timeLabel(stableWindow.end)}에는 팀원 ${playerIds.size}명이 각자의 첫 위치에서 최대 약 ${Math.round(stableWindow.maxDrift)}m 안에서 움직였습니다. 왜 그곳에 머물렀는지는 알 수 없습니다.` });
  }
  let lastRide: { seconds: number; vehicle: string } | null = null;
  for (const event of (events as AnyRecord[]).filter((item) => item._T === "LogVehicleRide"
    && characterId(item, "character") === candidate.accountId)) {
    const timeSeconds = relativeSeconds(event, startMs);
    if (timeSeconds === null) continue;
    const vehicleId = String(event.vehicle?.vehicleId ?? "");
    if (/TransportAircraft/i.test(vehicleId)) {
      if (!facts.some((fact) => fact.id === "aircraft-board")) {
        facts.push({ id: "aircraft-board", timeSeconds, kind: "aircraft", text: "비행기 탑승" });
      }
      continue;
    }
    if (lastRide && lastRide.vehicle === vehicleId && timeSeconds - lastRide.seconds < 3) continue;
    lastRide = { seconds: timeSeconds, vehicle: vehicleId };
    const vehicle = vehicleName(event.vehicle?.vehicleId);
    facts.push({ id: `vehicle-${timeSeconds.toFixed(3)}`, timeSeconds, kind: "vehicle", text: `${vehicle} 탑승` });
  }
  for (const event of events as AnyRecord[]) {
    const timeSeconds = relativeSeconds(event, startMs);
    if (timeSeconds === null) continue;
    if (event._T === "LogPlayerMakeGroggy" && playerIds.has(characterId(event, "attacker"))
      && !playerIds.has(characterId(event, "victim"))) {
      facts.push({ id: `knock-${timeSeconds.toFixed(3)}-${characterId(event, "victim")}`, timeSeconds, kind: "knock",
        text: `${event.attacker?.name ?? "팀원"} → ${event.victim?.name ?? "상대"} 기절` });
    }
    if (event._T === "LogPlayerMakeGroggy" && playerIds.has(characterId(event, "victim"))) {
      facts.push({ id: `down-${timeSeconds.toFixed(3)}-${characterId(event, "victim")}`, timeSeconds, kind: "down",
        text: `${event.victim?.name ?? "팀원"} 기절${event.attacker?.name ? ` (가해자 ${event.attacker.name})` : ""}` });
    }
    if (event._T === "LogPlayerRevive" && playerIds.has(characterId(event, "reviver"))
      && playerIds.has(characterId(event, "victim"))) {
      facts.push({ id: `revive-${timeSeconds.toFixed(3)}`, timeSeconds, kind: "revive",
        text: `${event.reviver?.name ?? "팀원"} → ${event.victim?.name ?? "팀원"} 소생` });
    }
  }
  const teamDamageByAttack = new Map<number, AnyRecord[]>();
  for (const event of events as AnyRecord[]) {
    if (event._T !== "LogPlayerTakeDamage" || !finite(event.attackId) || !finite(event.damage) || event.damage <= 0
      || !playerIds.has(characterId(event, "attacker")) || playerIds.has(characterId(event, "victim"))) continue;
    const group = teamDamageByAttack.get(event.attackId) ?? [];
    group.push(event);
    teamDamageByAttack.set(event.attackId, group);
  }
  for (const event of events as AnyRecord[]) {
    if (event._T !== "LogPlayerUseThrowable" || !playerIds.has(characterId(event, "attacker")) || !finite(event.attackId)) continue;
    const timeSeconds = relativeSeconds(event, startMs);
    const damageEvents = (teamDamageByAttack.get(event.attackId) ?? []).filter((hit) => {
      const hitSeconds = relativeSeconds(hit, startMs);
      return timeSeconds !== null && hitSeconds !== null && hitSeconds >= timeSeconds && hitSeconds - timeSeconds <= 20;
    });
    if (timeSeconds === null || !damageEvents.length) continue;
    const weapon = getTranslatedWeaponName(String(event.weapon?.itemId ?? event.weapon?.weaponId ?? ""));
    const totalDamage = Math.round(damageEvents.reduce((sum, hit) => sum + hit.damage, 0));
    const victims = [...new Set(damageEvents.map((hit) => String(hit.victim?.name ?? "상대")))];
    facts.push({ id: `throwable-${timeSeconds.toFixed(3)}-${event.attackId}`, timeSeconds, kind: "throwable",
      text: `${event.attacker?.name ?? "팀원"} ${/^(Item_|Weap|Proj)/.test(weapon) ? "투척물" : weapon} 사용 후 상대 ${victims.length}명에게 총 약 ${totalDamage} 피해` });
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
        damageIn: playerIds.has(victimId) && !playerIds.has(attackerId) ? damage : 0, kills: 0,
        firstDamage: damage > 0 ? `${event.attacker?.name ?? "공격자"} → ${event.victim?.name ?? "피해자"}` : null }];
    }
    if (event._T === "LogPlayerKillV2") {
      const killerId = characterId(event, "killer") ?? characterId(event, "finisher");
      const victimId = characterId(event, "victim");
      if (!playerIds.has(killerId) && !playerIds.has(victimId)) return [];
      return [{ timeSeconds, damageOut: 0, damageIn: 0, kills: playerIds.has(killerId) && !playerIds.has(victimId) ? 1 : 0, firstDamage: null }];
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
    const firstDamage = fight.find((event) => event.firstDamage)?.firstDamage;
    facts.push({
      id: `fight-${index + 1}`,
      timeSeconds: fight[0].timeSeconds,
      kind: "fight",
      text: `${mode === "squad" ? "팀 교전 관측: 팀" : "교전 관측:"} ${kills}킬, ${mode === "squad" ? "팀 " : ""}준 피해 ${Math.round(damageOut)}, ${mode === "squad" ? "팀 " : ""}받은 피해 ${Math.round(damageIn)} (${timeLabel(fight[fight.length - 1].timeSeconds)}까지)${firstDamage ? ` · 이 묶음의 첫 기록된 피해: ${firstDamage}` : ""}`,
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
    text: `${zone.phase}번째 자기장 공개${zone.outsideMeters === null ? " · 당시 위치 확인 불가" : zone.outsideMeters > 0 ? ` · 안전지대까지 약 ${Math.round(zone.outsideMeters)}m` : " · 이미 안전지대 안"}`,
  }));

  const limitations = [
    "위치·피해·처치·기절·소생·투척 기록으로 행동을 재구성합니다. 시야, 엄폐, 이동 의도, 교전 선택의 이유나 푸시·방어 전술은 확정할 수 없습니다.",
    "위치 기록은 간헐적인 표본입니다. 표본 사이의 정확한 경로와 자리 선정 이유, 비행기 전체 항로는 확인할 수 없습니다.",
    "처음 확인된 피해가 실제 첫 발사와 다를 수 있습니다. 투척과 피해는 같은 공격 기록으로 연결될 때만 한 행동으로 봅니다. 처치 기록까지 연결되지 않으면 마지막 처치에 사용한 투척물은 특정할 수 없습니다.",
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
    roster,
    encounters,
    weaponFinds,
    facts: facts.sort((a, b) => a.timeSeconds - b.timeSeconds || a.id.localeCompare(b.id)),
    weapons,
    killEvents,
    teamKillEvents,
    route,
    aircraft,
    zones,
    limitations,
  };
}
