import { MAP_NAMES, getTranslatedWeaponName } from "../pubg-analysis/constants";
import { hasMatchingTelemetryDefinition } from "../pubg-analysis/telemetrySource";
import { buildDailyCombatStory, buildDailyLifeStateAt, dailyWeaponName, type DailyEncounter, type DailyWeaponFind } from "./dailyCombatStory";

export type DailyEvidenceFact = {
  id: string;
  timeSeconds: number;
  kind: string;
  text: string;
  sourceIndices?: number[];
  eventType?: string;
  actorId?: string;
  victimId?: string;
  actorTeamId?: number;
  victimTeamId?: number;
  weapon?: string;
  position?: { x: number; y: number };
  positionTimeSeconds?: number;
  place?: string | null;
  vehicleName?: string;
  deathCause?: "blue_zone";
};

export const DAILY_EVIDENCE_VERSION = 7;

export type DailyEvidence = {
  dayKst: string;
  matchId: string;
  accountId: string;
  nickname: string;
  mode: "solo" | "duo" | "squad";
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
  zones: { phase: number; observedSeconds: number; outsideMeters: number | null; firstInsideSeconds: number | null; shrinkObservedSeconds?: number | null; positions?: { timeSeconds: number; x: number; y: number; sourceIndices?: number[] }[]; center?: { x: number; y: number }; radius?: number; sourceIndices?: number[] }[];
  blueZoneSamples?: { timeSeconds: number; center: { x: number; y: number }; radius: number; sourceIndex: number }[];
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
const placeName = (value: string) => ({ lacobreria: "라 코브레리아", cruzdelvalle: "크루즈 델 바예", school: "학교",
  stadium: "경기장", palace: "궁전", boatyard: "조선소", georgopol: "게오르고폴" })[value.toLowerCase()] ?? value;
const creditedWeapon = (event: AnyRecord, accountId: string) => {
  const rawWeapon = event.killerDamageInfo?.damageCauserName
    ?? event.dBNODamageInfo?.damageCauserName
    ?? (characterId(event, "finisher") === accountId ? event.finishDamageInfo?.damageCauserName : undefined);
  const translated = rawWeapon ? getTranslatedWeaponName(String(rawWeapon)) : "무기 확인 불가";
  return /^(Weap|Player|Proj|Item_|Damage_)/.test(translated) ? "무기 확인 불가" : translated;
};
const eventPosition = (event: AnyRecord, characterField = "character") => {
  const location = event[characterField]?.location;
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
  const mode = rawMode === "solo" ? "solo" : rawMode === "duo" ? "duo" : rawMode === "squad" ? "squad" : null;
  if (!mode || attributes.matchType !== "competitive" || attributes.isCustomMatch !== false) {
    throw new Error("match is not competitive solo/duo/squad");
  }
  const createdMs = isoMs(attributes.createdAt);
  if (createdMs === null || kstDate(createdMs) !== dayKst) throw new Error("match is not from requested KST day");
  if (!Array.isArray(events) || !hasMatchingTelemetryDefinition(events, matchId, "steam")) {
    throw new Error("telemetry definition does not match match id and platform");
  }
  const sourceIndexByEvent = new Map(events.map((event, index) => [event, index]));

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
  const lifeStateAt = buildDailyLifeStateAt(events as AnyRecord[], startMs);
  const killEvents = events
    .flatMap((event: unknown, sourceIndex: number) => {
      if (!record(event) || event._T !== "LogPlayerKillV2" || characterId(event, "killer") !== candidate.accountId) return [];
      const timeSeconds = relativeSeconds(event, startMs);
      if (timeSeconds === null) return [];
      // A teammate can finish this player's knock with a different weapon. The
      // credited killer's damage info describes the weapon behind this kill.
      const victim = typeof event.victim?.name === "string" ? event.victim.name : "알 수 없는 상대";
      const weapon = creditedWeapon(event, candidate.accountId);
      const distanceMeters = characterDistance(event.killer, event.victim);
      return [{ timeSeconds, victim, weapon, sourceIndex, event, ...(distanceMeters === null ? {} : { distanceMeters }) }];
    })
    .sort((a: { timeSeconds: number }, b: { timeSeconds: number }) => a.timeSeconds - b.timeSeconds);
  if (killEvents.length !== stats.kills) throw new Error(`telemetry kill count mismatch: api=${stats.kills}, telemetry=${killEvents.length}`);

  const weapons = [...killEvents.reduce((counts: Map<string, number>, event: { weapon: string }) => {
    counts.set(event.weapon, (counts.get(event.weapon) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()).entries()]
    .map(([name, kills]) => ({ name, kills }))
    .sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name));
  const winningRoster = participants.filter((entry: AnyRecord) => entry.attributes.stats.winPlace === 1);
  const rosterIds = new Set<string>(winningRoster.map((entry: AnyRecord) => entry.attributes.stats.playerId).filter((id: unknown): id is string => typeof id === "string"));
  const facts: DailyEvidenceFact[] = killEvents.map((event: { timeSeconds: number; victim: string; weapon: string; sourceIndex: number; event: AnyRecord }, index: number) => ({
    id: `kill-${index + 1}`,
    timeSeconds: event.timeSeconds,
    kind: "kill",
    text: `${event.victim} 처치 · ${event.weapon}${"distanceMeters" in event ? ` · 상대와 약 ${event.distanceMeters}m` : ""}`,
    sourceIndices: [event.sourceIndex], eventType: "LogPlayerKillV2",
    actorId: characterId(event.event, "killer"), victimId: characterId(event.event, "victim"),
    actorTeamId: event.event.killer?.teamId, victimTeamId: event.event.victim?.teamId, weapon: event.weapon,
  }));

  for (const [arrayIndex, event] of events.entries()) {
    if (!record(event)) continue;
    const sourceIndex = arrayIndex;
    const timeSeconds = relativeSeconds(event, startMs);
    if (timeSeconds === null) continue;
    const actorRole = event._T === "LogPlayerKillV2" ? "killer"
      : event._T === "LogPlayerRevive" ? "reviver"
        : event._T === "LogItemPickup" || /^LogItemPickupFrom/.test(String(event._T)) ? "character" : "attacker";
    const actor = event[actorRole];
    const victim = event.victim;
    const actorId = characterId(event, actorRole);
    const victimId = characterId(event, "victim");
    const crossTeamAction = actorId && victimId && rosterIds.has(actorId) !== rosterIds.has(victimId);
    let kind: string | null = null;
    let action = "";
    let weapon: string | undefined;
    if (event._T === "LogPlayerTakeDamage" && crossTeamAction && finite(event.damage) && event.damage > 0) {
      kind = "damage"; action = `피해 ${Math.round(event.damage)}`;
      weapon = dailyWeaponName(String(event.damageCauserName ?? ""));
    } else if (event._T === "LogPlayerAttack" && rosterIds.has(actorId)) {
      kind = "shot"; action = "공격 기록"; weapon = dailyWeaponName(event.weapon?.itemId);
    } else if (event._T === "LogPlayerUseThrowable" && rosterIds.has(actorId)) {
      kind = "throwable_use"; action = "투척물 사용"; weapon = dailyWeaponName(event.weapon?.itemId);
    }
    if (!kind) continue;
    const safeWeapon = weapon && weapon !== "무기 확인 불가" ? weapon : undefined;
    facts.push({
      id: `event-${sourceIndex}`, timeSeconds, kind,
      text: `${actor?.name ?? "선수"}${victim?.name ? ` → ${victim.name}` : ""} ${action}${safeWeapon ? ` · ${safeWeapon}` : ""}`,
      sourceIndices: [sourceIndex], eventType: String(event._T),
      ...(typeof actorId === "string" ? { actorId } : {}), ...(typeof victimId === "string" ? { victimId } : {}),
      ...(Number.isInteger(actor?.teamId) ? { actorTeamId: actor.teamId } : {}),
      ...(Number.isInteger(victim?.teamId) ? { victimTeamId: victim.teamId } : {}),
      ...(safeWeapon ? { weapon: safeWeapon } : {}),
      ...(record(actor?.location) && finite(actor.location.x) && finite(actor.location.y)
        ? { position: { x: actor.location.x / 100, y: actor.location.y / 100 }, positionTimeSeconds: timeSeconds } : {}),
    });
  }
  const matchEnd = events.find((event: unknown) => record(event) && event._T === "LogMatchEnd") as AnyRecord | undefined;
  const matchEndIndex = matchEnd ? sourceIndexByEvent.get(matchEnd) : undefined;
  const finalCharacter = matchEnd?.characters?.find((entry: AnyRecord) => characterId(entry, "character") === candidate.accountId)?.character;
  if (matchEnd && finalCharacter) {
    const finishSeconds = relativeSeconds(matchEnd, startMs);
    if (finishSeconds === null) throw new Error("match end timestamp missing");
    if (!Number.isFinite(finalCharacter.ranking) || finalCharacter.ranking !== stats.winPlace) {
      throw new Error("match end result disagrees with match winner");
    }
    if (matchEndIndex !== undefined) facts.push({ id: "finish", timeSeconds: finishSeconds, kind: "finish",
      text: `경기 종료 기록 · ${finalCharacter.ranking}위`, sourceIndices: [matchEndIndex], eventType: "LogMatchEnd",
      actorId: candidate.accountId, ...(Number.isInteger(finalCharacter.teamId) ? { actorTeamId: finalCharacter.teamId } : {}) });
    const secondPlace = matchEnd.characters?.find((entry: AnyRecord) => entry.character?.ranking === 2)?.character;
    const terminalDeath = mode !== "solo" && secondPlace && events.flatMap((event: unknown, sourceIndex: number) => {
      if (!record(event) || event._T !== "LogPlayerKillV2" || characterId(event, "victim") !== characterId({ victim: secondPlace }, "victim")) return [];
      const seconds = relativeSeconds(event, startMs);
      return seconds !== null && finishSeconds - seconds >= 0 && finishSeconds - seconds <= 30
        && event.victimGameResult?.rank === 2
        && event.finishDamageInfo?.damageTypeCategory === "Damage_BlueZone"
        && !event.killer?.accountId
        ? [{ event, sourceIndex, seconds }] : [];
    }).at(-1);
    if (secondPlace && terminalDeath && matchEndIndex !== undefined) facts.push({
      id: "terminal-opponent-death", timeSeconds: terminalDeath.seconds, kind: "terminal_opponent_death",
      text: `2위 상대 ${secondPlace.name ?? "이름 확인 불가"} 자기장 사망 · 1위 경기 종료 결과 확인`,
      sourceIndices: [terminalDeath.sourceIndex, matchEndIndex], eventType: "LogPlayerKillV2",
      victimId: characterId({ victim: secondPlace }, "victim"), victimTeamId: secondPlace.teamId,
      deathCause: "blue_zone",
      ...(eventPosition(terminalDeath.event, "victim")
        ? { position: eventPosition(terminalDeath.event, "victim")!, positionTimeSeconds: terminalDeath.seconds } : {}),
    });
  }

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
  if (mode !== "solo") {
    for (const [sourceIndex, event] of (events as AnyRecord[]).entries()) {
      if (event._T !== "LogPlayerKillV2") continue;
      const eventSeconds = relativeSeconds(event, startMs);
      if (eventSeconds === null) continue;
      if (teammateIds.has(characterId(event, "killer"))) {
        facts.push({
          id: `teammate-kill-${eventSeconds.toFixed(3)}`,
          timeSeconds: eventSeconds,
          kind: "teammate_kill",
          text: `아군 ${event.killer?.name ?? "알 수 없는 팀원"} → 상대 ${event.victim?.name ?? "알 수 없는 상대"} 처치 · ${creditedWeapon(event, characterId(event, "killer"))}${characterDistance(event.killer, event.victim) === null ? "" : ` · 상대와 약 ${characterDistance(event.killer, event.victim)}m`}`,
          sourceIndices: [sourceIndex], eventType: "LogPlayerKillV2", actorId: characterId(event, "killer"),
          victimId: characterId(event, "victim"), actorTeamId: event.killer?.teamId, victimTeamId: event.victim?.teamId,
          weapon: creditedWeapon(event, characterId(event, "killer")),
        });
      }
      if (teammateIds.has(characterId(event, "victim"))) {
        facts.push({
          id: `teammate-death-${eventSeconds.toFixed(3)}`,
          timeSeconds: eventSeconds,
          kind: "teammate_death",
          text: `팀원 ${event.victim?.name ?? "알 수 없는 팀원"} 사망 이벤트${event.killer?.name ? ` (처치자 ${event.killer.name})` : ""}`,
          sourceIndices: [sourceIndex], eventType: "LogPlayerKillV2", actorId: characterId(event, "killer"),
          victimId: characterId(event, "victim"), actorTeamId: event.killer?.teamId, victimTeamId: event.victim?.teamId,
        });
      }
    }
  }
  for (const [sourceIndex, event] of (events as AnyRecord[]).entries()) {
    if (event._T !== "LogPlayerKillV2") continue;
    const victimId = characterId(event, "victim");
    const timeSeconds = relativeSeconds(event, startMs);
    if (typeof victimId !== "string" || !rosterIds.has(victimId) || timeSeconds === null) continue;
    facts.push({ id: `player-death-${sourceIndex}`, timeSeconds, kind: "player_death",
      text: `${event.victim?.name ?? participantNames.get(victimId) ?? "팀원"} 사망 이벤트 확인`,
      sourceIndices: [sourceIndex], eventType: "LogPlayerKillV2", actorId: characterId(event, "killer"), victimId,
      ...(Number.isInteger(event.killer?.teamId) ? { actorTeamId: event.killer.teamId } : {}),
      ...(Number.isInteger(event.victim?.teamId) ? { victimTeamId: event.victim.teamId } : {}) });
  }
  for (const [sourceIndex, event] of (events as AnyRecord[]).entries()) {
    if (event._T !== "LogPlayerCreate") continue;
    const playerId = characterId(event, "character");
    if (typeof playerId !== "string" || !rosterIds.has(playerId)) continue;
    const timeSeconds = relativeSeconds(event, startMs);
    if (timeSeconds === null || !lifeStateAt(playerId, timeSeconds, sourceIndex - 1).dead) continue;
    facts.push({ id: `player-return-${sourceIndex}`, timeSeconds, kind: "player_return",
      text: `${event.character?.name ?? participantNames.get(playerId) ?? "선수"} 사망 이벤트 뒤 플레이어 생성 기록`,
      sourceIndices: [sourceIndex], eventType: "LogPlayerCreate", actorId: playerId,
      ...(Number.isInteger(event.character?.teamId) ? { actorTeamId: event.character.teamId } : {}) });
  }
  encounters.forEach((encounter) => {
    const first = encounter.actions.find((action) => action.kind === "first_hit");
    facts.push({ id: encounter.id, timeSeconds: encounter.startSeconds, kind: "encounter",
      text: `상대 팀(${encounter.opponents.join("·")})과 교전 · 첫 확인 피해 ${first ? `${first.actor}의 ${first.weapon} → ${first.victim}${first.distanceMeters === null ? "" : ` (약 ${first.distanceMeters}m)`}` : "확인 불가"} · 아군 ${encounter.teamKills}킬${encounter.rankerWeapons.length ? ` · 랭커가 쏜 총 ${encounter.rankerWeapons.join(" → ")}` : ""}`,
      sourceIndices: encounter.sourceIndices, eventType: "encounter" });
  });
  weaponFinds.forEach((find, index) => facts.push({ id: `weapon-find-${index + 1}`, timeSeconds: find.timeSeconds,
    kind: "weapon_find", text: `${find.player} · ${find.weapon} 획득${find.source === "carepackage" ? " · 보급 상자" : find.source === "lootbox" ? ` · ${find.owner ?? "다른 선수"}의 전리품 상자` : ""}`,
    sourceIndices: find.sourceIndices, eventType: "weapon_pickup", actorId: find.playerId, actorTeamId: find.teamId, weapon: find.weapon }));

  const playerIds = mode === "solo" ? new Set([candidate.accountId]) : rosterIds;
  const positionEvents = (events as AnyRecord[]).filter((event) => {
    if (event._T !== "LogPlayerPosition" || !playerIds.has(characterId(event, "character")) || !eventPosition(event)) return false;
    const playerId = characterId(event, "character");
    const timeSeconds = relativeSeconds(event, startMs);
    const sourceIndex = sourceIndexByEvent.get(event);
    return typeof playerId === "string" && timeSeconds !== null && sourceIndex !== undefined
      && !lifeStateAt(playerId, timeSeconds, sourceIndex).dead;
  });
  const targetPositions = positionEvents.filter((event) => characterId(event, "character") === candidate.accountId);
  const aircraft = targetPositions.filter((event) => /TransportAircraft/i.test(String(event.vehicle?.vehicleId ?? "")))
    .flatMap((event) => {
      const timeSeconds = relativeSeconds(event, startMs);
      const position = eventPosition(event);
      return timeSeconds === null || !position ? [] : [{ timeSeconds, ...position }];
    }).slice(0, 12);
  if (aircraft.length) facts.push({ id: "aircraft", timeSeconds: aircraft[0].timeSeconds, kind: "aircraft",
    text: `비행기 위치가 ${aircraft.length}번 기록됐습니다. 전체 비행 경로는 확인할 수 없습니다.`,
    sourceIndices: targetPositions.filter(event => aircraft.some(point => point.timeSeconds === relativeSeconds(event, startMs))).map(event => sourceIndexByEvent.get(event)!), eventType: "LogPlayerPosition" });
  for (const [sourceIndex, event] of (events as AnyRecord[]).entries()) {
    if (event._T !== "LogParachuteLanding" || !playerIds.has(characterId(event, "character"))) continue;
    const timeSeconds = relativeSeconds(event, startMs);
    const position = eventPosition(event);
    if (timeSeconds === null || !position) continue;
    const zone = Array.isArray(event.character?.zone) && event.character.zone.length ? event.character.zone : null;
    const place = Array.isArray(zone) && zone.length ? zone.map(placeName).join(", ") : null;
    facts.push({
      id: (() => { const base = characterId(event, "character") === candidate.accountId ? "landing" : `landing-${characterId(event, "character")}`; return facts.some(fact => fact.id === base) ? `${base}-${sourceIndex}` : base; })(),
      timeSeconds,
      kind: "landing",
      text: `${mode !== "solo" ? `${event.character?.name ?? "팀원"} ` : ""}${place ? `${place} 근처에 ` : ""}착지`,
      sourceIndices: [sourceIndex], eventType: "LogParachuteLanding", actorId: characterId(event, "character"),
      actorTeamId: event.character?.teamId, position: { x: position.x, y: position.y }, positionTimeSeconds: timeSeconds, place,
    });
  }
  const route: DailyEvidence["route"] = [];
  const routeSources = new Map<number, number[]>();
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
      const sources = [sourceIndexByEvent.get(sample.event)!];
      const players = [...playerIds].flatMap((id) => {
        const selected = nearby.filter((event) => characterId(event, "character") === id)
          .sort((a, b) => Math.abs((relativeSeconds(a, startMs) ?? Infinity) - sample.timeSeconds)
            - Math.abs((relativeSeconds(b, startMs) ?? Infinity) - sample.timeSeconds))[0];
        const position = selected && eventPosition(selected);
        if (position) sources.push(sourceIndexByEvent.get(selected)!);
        return position ? [{ name: String(selected.character?.name ?? "팀원"), ...position }] : [];
      });
      routeSources.set(sample.timeSeconds, [...new Set(sources)]);
      const spreadMeters = Math.max(0, ...players.map((player) => Math.hypot(player.x - target.x, player.y - target.y)));
      const zone = sample.event.character?.zone;
      route.push({ timeSeconds: sample.timeSeconds, ...target,
        place: Array.isArray(zone) && zone.length ? zone.map(placeName).join(", ") : null,
        spreadMeters, players });
    }
  }
  route.forEach((point, index) => facts.push({ sourceIndices: routeSources.get(point.timeSeconds), eventType: "LogPlayerPosition", id: `route-${index + 1}`, timeSeconds: point.timeSeconds, kind: "route",
    text: `${mode !== "solo" ? `팀 ${point.players.length}명 위치 표본` : "위치 표본"}: 대상 (${Math.round(point.x)}, ${Math.round(point.y)})m${point.place ? ` · ${point.place}` : ""}${mode !== "solo" ? ` · 대상과 관측 팀원 최대 거리 약 ${Math.round(point.spreadMeters)}m` : ""}` }));
  if (mode !== "solo" && route.length) {
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
    if (stableWindow) facts.push({ sourceIndices: positionEvents.filter(event => { const seconds = relativeSeconds(event, startMs); return seconds !== null && seconds >= stableWindow!.start && seconds <= stableWindow!.end; }).map(event => sourceIndexByEvent.get(event)!), eventType: "LogPlayerPosition", id: "stable-position", timeSeconds: stableWindow.start, kind: "hold",
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
        facts.push({ id: "aircraft-board", timeSeconds, kind: "aircraft", text: "비행기 탑승", sourceIndices: [sourceIndexByEvent.get(event)!], eventType: "LogVehicleRide",
          actorId: characterId(event, "character"), actorTeamId: event.character?.teamId, vehicleName: "비행기",
          ...(eventPosition(event) ? { position: eventPosition(event)!, positionTimeSeconds: timeSeconds } : {}) });
      }
      continue;
    }
    if (lastRide && lastRide.vehicle === vehicleId && timeSeconds - lastRide.seconds < 3) continue;
    lastRide = { seconds: timeSeconds, vehicle: vehicleId };
    const vehicle = vehicleName(event.vehicle?.vehicleId);
    facts.push({ id: `vehicle-${timeSeconds.toFixed(3)}`, timeSeconds, kind: "vehicle", text: `${vehicle} 탑승`, sourceIndices: [sourceIndexByEvent.get(event)!], eventType: "LogVehicleRide",
      actorId: characterId(event, "character"), actorTeamId: event.character?.teamId, vehicleName: vehicle,
      ...(eventPosition(event) ? { position: eventPosition(event)!, positionTimeSeconds: timeSeconds } : {}) });
  }
  for (const [sourceIndex, event] of (events as AnyRecord[]).entries()) {
    const timeSeconds = relativeSeconds(event, startMs);
    if (timeSeconds === null) continue;
    if (event._T === "LogPlayerMakeGroggy" && playerIds.has(characterId(event, "attacker"))
      && !playerIds.has(characterId(event, "victim"))) {
      facts.push({ id: `knock-${timeSeconds.toFixed(3)}-${characterId(event, "victim")}`, timeSeconds, kind: "knock",
        text: `${event.attacker?.name ?? "팀원"} → ${event.victim?.name ?? "상대"} 기절`, sourceIndices: [sourceIndex],
        eventType: "LogPlayerMakeGroggy", actorId: characterId(event, "attacker"), victimId: characterId(event, "victim"),
        actorTeamId: event.attacker?.teamId, victimTeamId: event.victim?.teamId,
        weapon: getTranslatedWeaponName(String(event.damageCauserName ?? "")) });
    }
    if (event._T === "LogPlayerMakeGroggy" && playerIds.has(characterId(event, "victim"))) {
      facts.push({ id: `down-${timeSeconds.toFixed(3)}-${characterId(event, "victim")}`, timeSeconds, kind: "down",
        text: `${event.victim?.name ?? "팀원"} 기절${event.attacker?.name ? ` (가해자 ${event.attacker.name})` : ""}`,
        sourceIndices: [sourceIndex], eventType: "LogPlayerMakeGroggy", actorId: characterId(event, "attacker"),
        victimId: characterId(event, "victim"), actorTeamId: event.attacker?.teamId, victimTeamId: event.victim?.teamId });
    }
    if (event._T === "LogPlayerRevive" && playerIds.has(characterId(event, "reviver"))
      && playerIds.has(characterId(event, "victim"))) {
      facts.push({ id: `revive-${timeSeconds.toFixed(3)}`, timeSeconds, kind: "revive",
        text: `${event.reviver?.name ?? "팀원"} → ${event.victim?.name ?? "팀원"} 소생`, sourceIndices: [sourceIndex],
        eventType: "LogPlayerRevive", actorId: characterId(event, "reviver"), victimId: characterId(event, "victim"),
        actorTeamId: event.reviver?.teamId, victimTeamId: event.victim?.teamId,
        ...(record(event.reviver?.location) && finite(event.reviver.location.x) && finite(event.reviver.location.y)
          ? { position: { x: event.reviver.location.x / 100, y: event.reviver.location.y / 100 }, positionTimeSeconds: timeSeconds } : {}) });
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
      sourceIndices: [event, ...damageEvents].map(item => sourceIndexByEvent.get(item)!), eventType: "throwable_damage",
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
      return [{ sourceIndex: sourceIndexByEvent.get(event)!, timeSeconds, damageOut: playerIds.has(attackerId) && !playerIds.has(victimId) ? damage : 0,
        damageIn: playerIds.has(victimId) && !playerIds.has(attackerId) ? damage : 0, kills: 0,
        firstDamage: damage > 0 ? `${event.attacker?.name ?? "공격자"} → ${event.victim?.name ?? "피해자"}` : null }];
    }
    if (event._T === "LogPlayerKillV2") {
      const killerId = characterId(event, "killer") ?? characterId(event, "finisher");
      const victimId = characterId(event, "victim");
      if (!playerIds.has(killerId) && !playerIds.has(victimId)) return [];
      return [{ sourceIndex: sourceIndexByEvent.get(event)!, timeSeconds, damageOut: 0, damageIn: 0, kills: playerIds.has(killerId) && !playerIds.has(victimId) ? 1 : 0, firstDamage: null }];
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
      kind: "fight", sourceIndices: fight.map(event => event.sourceIndex), eventType: "combat_summary",
      text: `${mode !== "solo" ? "팀 교전 관측: 팀" : "교전 관측:"} ${kills}킬, ${mode !== "solo" ? "팀 " : ""}준 피해 ${Math.round(damageOut)}, ${mode !== "solo" ? "팀 " : ""}받은 피해 ${Math.round(damageIn)} (${timeLabel(fight[fight.length - 1].timeSeconds)}까지)${firstDamage ? ` · 이 묶음의 첫 기록된 피해: ${firstDamage}` : ""}`,
    });
  });

  const timed = events.flatMap((event: unknown, sourceIndex: number) => {
    if (!record(event)) return [];
    const seconds = relativeSeconds(event, startMs);
    return seconds === null ? [] : [{ event, seconds, sourceIndex }];
  }).sort((a, b) => a.seconds - b.seconds || a.sourceIndex - b.sourceIndex);
  const phaseEvents = timed.filter(({ event }) => event._T === "LogPhaseChange" && Number.isInteger(event.phase));
  const phases = phaseEvents.filter((item, index) => index === 0 || item.event.phase !== phaseEvents[index - 1].event.phase);
  const endSeconds = timed.find(({ event }) => event._T === "LogMatchEnd")?.seconds ?? timed.at(-1)?.seconds ?? Infinity;
  const playerPositions = timed.filter(({ event, seconds, sourceIndex }) => event._T === "LogPlayerPosition"
    && characterId(event, "character") === candidate.accountId && eventPosition(event)
    && !lifeStateAt(candidate.accountId, seconds, sourceIndex).dead);
  const periodic = timed.filter(({ event, seconds }) => event._T === "LogGameStatePeriodic" && record(event.gameState) && seconds <= endSeconds);
  const observedBlueZones = periodic.flatMap(({ event, seconds, sourceIndex }) => {
    const { safetyZonePosition: center, safetyZoneRadius: radius } = event.gameState;
    return record(center) && finite(center.x) && finite(center.y) && finite(radius) && radius > 0
      ? [{ timeSeconds: seconds, center: { x: center.x / 100, y: center.y / 100 }, radius: radius / 100, sourceIndex }] : [];
  });
  const blueZoneSampleCount = Math.min(observedBlueZones.length, 256);
  const blueZoneSamples = blueZoneSampleCount < observedBlueZones.length
    ? Array.from({ length: blueZoneSampleCount }, (_, index) => observedBlueZones[Math.round(index * (observedBlueZones.length - 1) / (blueZoneSampleCount - 1))])
    : observedBlueZones;
  const distance = (event: AnyRecord, center: { x: number; y: number }) => Math.hypot(
    event.character.location.x / 100 - center.x, event.character.location.y / 100 - center.y,
  );
  const zones: DailyEvidence["zones"] = phases.flatMap((phase, index) => {
    const nextPhase = phases[index + 1];
    const intervalEnd = Math.min(nextPhase?.seconds ?? Infinity, endSeconds);
    const samples = periodic.filter(({ seconds }) => seconds >= phase.seconds && seconds < intervalEnd);
    const observations: Array<{ sample: typeof samples[number]; key: string; circleSamples: typeof samples }> = [];
    let current: typeof observations[number] | undefined;
    for (const sample of samples) {
      const state = sample.event.gameState;
      const warning = state.poisonGasWarningPosition;
      const warningRadius = state.poisonGasWarningRadius;
      if (!record(warning) || !finite(warning.x) || !finite(warning.y) || !finite(warningRadius) || warningRadius <= 0) continue;
      const circleKey = [warning.x, warning.y, warningRadius].map(Math.round).join(":");
      if (current?.key !== circleKey) {
        current = { sample, key: circleKey, circleSamples: [] };
        observations.push(current);
      }
      current.circleSamples.push(sample);
    }
    return observations.map(({ sample, circleSamples }, observationIndex) => {
      const nextObservation = observations[observationIndex + 1];
      const observationEnd = Math.min(nextObservation?.sample.seconds ?? Infinity, intervalEnd);
      const { x, y } = sample.event.gameState.poisonGasWarningPosition;
      const warningRadius = sample.event.gameState.poisonGasWarningRadius;
      const center = { x: x / 100, y: y / 100 };
      const radius = warningRadius / 100;
      const shrinkIndex = circleSamples.findIndex(({ event }, sampleIndex) => sampleIndex > 0
        && finite(event.gameState.safetyZoneRadius)
        && finite(circleSamples[sampleIndex - 1].event.gameState.safetyZoneRadius)
        && event.gameState.safetyZoneRadius < circleSamples[sampleIndex - 1].event.gameState.safetyZoneRadius);
      const inBounds = playerPositions.filter(({ seconds }) => seconds >= sample.seconds && seconds < observationEnd);
      const baseline = playerPositions.filter(({ seconds }) => seconds <= sample.seconds && sample.seconds - seconds <= 15).at(-1);
      const firstInside = inBounds.find(({ event }) => distance(event, center) <= radius);
      const positions = [...(baseline ? [baseline] : []), ...inBounds].map(({ event, seconds, sourceIndex }) => ({
        timeSeconds: seconds, ...eventPosition(event)!, sourceIndices: [sourceIndex],
      }));
      return { phase: phase.event.phase, observedSeconds: sample.seconds,
        outsideMeters: baseline ? Math.max(0, distance(baseline.event, center) - radius) : null,
        firstInsideSeconds: firstInside?.seconds ?? null,
        shrinkObservedSeconds: shrinkIndex > 0 ? circleSamples[shrinkIndex].seconds : null,
        positions, center, radius, sourceIndices: [sample.sourceIndex, ...[baseline, firstInside].flatMap((item) => item ? [item.sourceIndex] : []),
          ...(shrinkIndex > 0 ? [circleSamples[shrinkIndex - 1].sourceIndex, circleSamples[shrinkIndex].sourceIndex] : [])] };
    });
  });
  zones.forEach((zone, index) => facts.push({
    id: `zone-${zone.phase}-${index + 1}`,
    timeSeconds: zone.observedSeconds,
    kind: "zone",
    text: `${zone.phase}번째 자기장 공개${zone.outsideMeters === null ? " · 당시 위치 확인 불가" : zone.outsideMeters > 0 ? ` · 안전지대까지 약 ${Math.round(zone.outsideMeters)}m` : " · 이미 안전지대 안"}${zone.shrinkObservedSeconds != null ? ` · ${timeLabel(zone.shrinkObservedSeconds)} 축소 확인` : ""}`,
    sourceIndices: zone.sourceIndices, eventType: "LogGameStatePeriodic",
  }));

  const limitations = [
    "위치·피해·처치·기절·소생·투척 기록으로 행동을 재구성합니다. 시야, 엄폐, 이동 의도, 교전 선택의 이유나 푸시·방어 전술은 확정할 수 없습니다.",
    "위치 기록은 간헐적인 표본입니다. 표본 사이의 정확한 경로와 자리 선정 이유, 비행기 전체 항로는 확인할 수 없습니다.",
    "처음 확인된 피해가 실제 첫 발사와 다를 수 있습니다. 투척과 피해는 같은 공격 기록으로 연결될 때만 한 행동으로 봅니다. 처치 기록까지 연결되지 않으면 마지막 처치에 사용한 투척물은 특정할 수 없습니다.",
    "자기장 거리는 원 공개 후 확인된 독성 가스 경고 원과 직전 15초 내 위치로 계산한 직선거리이며, 실제 이동 경로와 지형은 반영하지 않습니다.",
    ...(mode !== "solo" ? ["개인 처치 무기는 킬 귀속자의 공격 기록 기준입니다. 팀원이 다른 무기로 마무리한 경우 그 무기와 다를 수 있습니다."] : []),
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
    teamKills: mode === "solo" ? stats.kills : rosterKills,
    roster,
    encounters,
    weaponFinds,
    facts: facts.sort((a, b) => a.timeSeconds - b.timeSeconds || a.id.localeCompare(b.id)),
    weapons,
    killEvents: killEvents.map(({ timeSeconds, victim, weapon, distanceMeters }) => ({
      timeSeconds, victim, weapon, ...(distanceMeters === undefined ? {} : { distanceMeters }),
    })),
    teamKillEvents,
    route,
    aircraft,
    zones,
    blueZoneSamples,
    limitations,
  };
}
