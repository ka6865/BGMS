import { getTranslatedWeaponName } from "../pubg-analysis/constants";

type Event = Record<string, any>;

export type DailyEncounterAction = {
  timeSeconds: number;
  kind: "first_hit" | "knock" | "kill" | "ally_down";
  actor: string;
  victim: string;
  weapon: string;
  distanceMeters: number | null;
  sourceIndices?: number[];
  actorId?: string;
  victimId?: string;
  actorTeamId?: number;
  victimTeamId?: number;
  actorInVehicle?: boolean;
  victimInVehicle?: boolean;
};

export type DailyEncounterSnapshotPoint = {
  playerId?: string;
  player: string;
  side: "ally" | "opponent";
  directlyInvolved: boolean;
  x: number;
  y: number;
  sampleTimeSeconds: number;
  ageSeconds: number;
  sourceIndices?: number[];
};

export type DailyEncounterSnapshot = {
  offsetSeconds: -30 | 0 | 30;
  anchorLabel: "처음 기록된 피해" | "처음 기록된 교전 행동";
  targetTimeSeconds: number;
  points: DailyEncounterSnapshotPoint[];
  missingPlayers: string[];
  deadPlayerIds?: string[];
};

export type DailyEncounter = {
  id: string;
  sourceIndices?: number[];
  startSeconds: number;
  endSeconds: number;
  opponents: string[];
  allies: string[];
  /** Stable telemetry identity used to group this opponent team across cards. */
  opponentIdentity?: { key: string; teamId: number | null; playerIds: string[]; players?: { id: string; name: string; deathTimeSeconds?: number; deathKillerTeamId?: number }[] };
  /** Roster members observed directly in combat, separate from the full allied roster. */
  involvedAllies?: string[];
  rosterAllies?: string[];
  /** A later, separate card for the same opponent identity. */
  reengagement?: { isReengagement: boolean; previousEncounterId: string | null; gapSeconds: number | null };
  /** Other encounter intervals that intersect this card's observed event interval. */
  overlapsWith?: string[];
  /** Sparse relative position samples around the first recorded damage/action. */
  snapshots?: DailyEncounterSnapshot[];
  teamKills: number;
  rankerWeapons: string[];
  firstRankerShot: { timeSeconds: number; weapon: string; sourceIndices?: number[]; actorId?: string; actorTeamId?: number } | null;
  precontactMovement: { player: string; meters: number }[];
  arrival: string | null;
  vehicle: string | null;
  actions: DailyEncounterAction[];
};

export type DailyWeaponFind = {
  timeSeconds: number;
  player: string;
  weapon: string;
  source: "ground" | "lootbox" | "carepackage" | "vehicle";
  owner: string | null;
  sourceIndices?: number[];
  playerId?: string;
  teamId?: number;
};

const seconds = (event: Event, startMs: number) => {
  const value = Date.parse(String(event._D ?? ""));
  return Number.isFinite(value) ? Math.max(0, (value - startMs) / 1000) : null;
};
const id = (character: Event | undefined) => character?.accountId;
const name = (character: Event | undefined) => String(character?.name ?? "이름 확인 불가");
const distance = (first: Event | undefined, second: Event | undefined) => {
  const a = first?.location;
  const b = second?.location;
  return Number.isFinite(a?.x) && Number.isFinite(a?.y) && Number.isFinite(b?.x) && Number.isFinite(b?.y)
    ? Math.round(Math.hypot(a.x - b.x, a.y - b.y) / 100) : null;
};

type DailyLifeState = { dead: boolean; life: number; deathTimeSeconds?: number; killerTeamId?: number };

export function buildDailyLifeStateAt(events: Event[], startMs: number) {
  const lifeEvents = new Map<string, { timeSeconds: number; sourceIndex: number; dead: boolean; life: number; killerTeamId?: number }[]>();
  const survivalActor = (event: Event) => event._T === "LogPlayerTakeDamage"
    ? Number(event.attacker?.health) > 0 ? event.attacker : undefined
    : event._T === "LogPlayerKillV2" ? Number(event.killer?.health) > 0 ? event.killer : undefined
      : event._T === "LogPlayerMakeGroggy" || event._T === "LogPlayerAttack" ? event.attacker
        : event._T === "LogPlayerRevive" ? event.reviver
          : event._T?.startsWith("LogItemPickup") || event._T === "LogPlayerUseThrowable"
            ? event.character ?? event.attacker : undefined;
  for (const [sourceIndex, event] of events.entries()) {
    const timeSeconds = seconds(event, startMs);
    if (timeSeconds === null) continue;
    const deadPlayerId = event._T === "LogPlayerKillV2" ? id(event.victim) : undefined;
    const positionPlayerId = event._T === "LogPlayerPosition" && Number(event.character?.health) > 0
      ? id(event.character) : undefined;
    const createdPlayerId = event._T === "LogPlayerCreate" ? id(event.character) : undefined;
    const revivedPlayerId = event._T === "LogPlayerRevive" ? id(event.victim) : undefined;
    const survivalPlayerId = id(survivalActor(event));
    const transition = (playerId: string | undefined, dead: boolean) => {
      if (!playerId) return;
      const history = lifeEvents.get(playerId) ?? [];
      history.push({ timeSeconds, sourceIndex, dead, life: 0,
        ...(dead && Number.isInteger(event.killer?.teamId) ? { killerTeamId: event.killer.teamId } : {}) });
      lifeEvents.set(playerId, history);
    };
    if (deadPlayerId) transition(deadPlayerId, true);
    transition(positionPlayerId, false);
    transition(createdPlayerId, false);
    transition(revivedPlayerId, false);
    if (survivalPlayerId !== deadPlayerId) transition(survivalPlayerId, false);
  }
  for (const history of lifeEvents.values()) {
    history.sort((a, b) => a.timeSeconds - b.timeSeconds || a.sourceIndex - b.sourceIndex);
    let dead = false;
    let life = 0;
    for (let i = 0; i < history.length; i += 1) {
      const transition = history[i];
      if (transition.dead) dead = true;
      else if (dead) { dead = false; life += 1; }
      else { history.splice(i--, 1); continue; }
      transition.dead = dead;
      transition.life = life;
      if (!dead) transition.killerTeamId = undefined;
    }
  }
  return (playerId: string, timeSeconds: number, sourceIndex = Infinity): DailyLifeState => {
    const history = lifeEvents.get(playerId) ?? [];
    let low = 0;
    let high = history.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const transition = history[mid];
      if (transition.timeSeconds < timeSeconds
        || transition.timeSeconds === timeSeconds && transition.sourceIndex <= sourceIndex) low = mid + 1;
      else high = mid;
    }
    const state = history[low - 1];
    return state ? { dead: state.dead, life: state.life,
      deathTimeSeconds: state.dead ? state.timeSeconds : undefined,
      killerTeamId: state.dead ? state.killerTeamId : undefined }
      : { dead: false, life: 0 };
  };
}
export const dailyWeaponName = (raw: unknown) => {
  if (typeof raw !== "string" || !raw) return "무기 확인 불가";
  const weaponId = raw.startsWith("Item_Weapon_") ? `Weap${raw.slice("Item_Weapon_".length)}` : raw;
  const normalized = weaponId === "WeapThompson_C" ? "WeapTommyGun_C" : weaponId;
  const translated = getTranslatedWeaponName(normalized);
  return /^(Item_|Weap|Proj|Damage_)/.test(translated) ? "무기 확인 불가" : translated;
};
const weaponName = dailyWeaponName;

type CombatEvent = {
  source: Event;
  sourceIndex: number;
  timeSeconds: number;
  opponentKey: string;
  opponentTeamId: number | null;
  ally: Event;
  opponent: Event;
  kind: "hit" | "knock" | "kill";
};

/** Relate only recorded opponents and actions; never infer sight lines or intent. */
export function buildDailyCombatStory(events: Event[], startMs: number, targetId: string,
  rosterIds: Set<string>, participantNames: Map<string, string>): {
  encounters: DailyEncounter[];
  weaponFinds: DailyWeaponFind[];
} {
  const combat: CombatEvent[] = [];
  for (const [arrayIndex, event] of events.entries()) {
    const sourceIndex = arrayIndex;
    const timeSeconds = seconds(event, startMs);
    if (timeSeconds === null) continue;
    const kind = event._T === "LogPlayerTakeDamage" && Number(event.damage) > 0 ? "hit"
      : event._T === "LogPlayerMakeGroggy" ? "knock"
        : event._T === "LogPlayerKillV2" ? "kill" : null;
    if (!kind) continue;
    const attacker = kind === "kill" ? event.killer : event.attacker;
    const victim = event.victim;
    const attackerAlly = rosterIds.has(id(attacker));
    const victimAlly = rosterIds.has(id(victim));
    if (attackerAlly === victimAlly) continue;
    const ally = attackerAlly ? attacker : victim;
    const opponent = attackerAlly ? victim : attacker;
    if (!opponent || !ally) continue;
    const opponentTeamId = Number.isInteger(opponent.teamId) && opponent.teamId > 0 ? opponent.teamId : null;
    const opponentKey = opponentTeamId !== null
      ? `team-${opponentTeamId}` : `player-${id(opponent) ?? name(opponent)}`;
    combat.push({ source: event, sourceIndex, timeSeconds, opponentKey, opponentTeamId, ally, opponent, kind });
  }
  combat.sort((a, b) => a.timeSeconds - b.timeSeconds);

  const groups: CombatEvent[][] = [];
  for (const item of combat) {
    const last = [...groups].reverse().find((group) => group[0].opponentKey === item.opponentKey
      && item.timeSeconds - group.at(-1)!.timeSeconds <= 75
      && item.timeSeconds - group[0].timeSeconds <= 180);
    if (last) last.push(item);
    else groups.push([item]);
  }

  const landing = events.filter((event) => event._T === "LogParachuteLanding");
  const positions = events.flatMap((event, sourceIndex) => event._T === "LogPlayerPosition"
      && event.common?.isGame !== 0
      && typeof id(event.character) === "string"
      && Number.isFinite(event.character?.location?.x) && Number.isFinite(event.character?.location?.y)
      ? [{ event, sourceIndex, timeSeconds: seconds(event, startMs) }] : [])
    .sort((a, b) => (a.timeSeconds ?? 0) - (b.timeSeconds ?? 0));
  const positionsByPlayer = new Map<string, typeof positions>();
  const playersByTeam = new Map<number, Map<string, string>>();
  const stateAt = buildDailyLifeStateAt(events, startMs);
  for (const event of events) {
    for (const character of [event.character, event.attacker, event.victim, event.killer]) {
      const teamId = character?.teamId;
      const playerId = id(character);
      if (!Number.isInteger(teamId) || teamId <= 0 || typeof playerId !== "string") continue;
      const players = playersByTeam.get(teamId) ?? new Map<string, string>();
      players.set(playerId, participantNames.get(playerId) ?? name(character));
      playersByTeam.set(teamId, players);
    }
  }
  for (const position of positions) {
    const playerId = id(position.event.character);
    if (typeof playerId !== "string") continue;
    const samples = positionsByPlayer.get(playerId) ?? [];
    samples.push(position);
    positionsByPlayer.set(playerId, samples);
  }
  const targetLanding = landing.find((event) => id(event.character) === targetId);
  const encounters = groups.flatMap((group, index): DailyEncounter[] => {
    const first = group[0];
    const last = group.at(-1)!;
    const involvedAllies = [...new Set(group.map((item) => name(item.ally)))];
    const opponentTeam = first.opponentTeamId === null ? undefined : playersByTeam.get(first.opponentTeamId);
    const opponentPlayers = opponentTeam ? [...opponentTeam].sort(([a], [b]) => a.localeCompare(b))
      .map(([playerId, playerName]) => ({ id: playerId, name: playerName })) : [];
    for (const item of group) {
      const playerId = id(item.opponent);
      if (typeof playerId === "string" && !opponentPlayers.some((player) => player.id === playerId))
        opponentPlayers.push({ id: playerId, name: participantNames.get(playerId) ?? name(item.opponent) });
    }
    opponentPlayers.sort((a, b) => a.id.localeCompare(b.id));
    const opponents = opponentPlayers.length ? [...new Set(opponentPlayers.map(({ name }) => name))]
      : [...new Set(group.map((item) => name(item.opponent)))];
    const subjects = new Map<string, { player: string; side: "ally" | "opponent"; directlyInvolved: boolean }>();
    for (const playerId of rosterIds) {
      const playerName = participantNames.get(playerId);
      if (playerName) subjects.set(playerId, { player: playerName, side: "ally", directlyInvolved: false });
    }
    for (const item of group) {
      const allyId = id(item.ally);
      if (typeof allyId === "string") subjects.set(allyId, { player: name(item.ally), side: "ally", directlyInvolved: true });
    }
    for (const player of opponentPlayers) subjects.set(player.id, {
      player: player.name, side: "opponent", directlyInvolved: group.some((item) => id(item.opponent) === player.id),
    });
    const rosterAllies = [...rosterIds].map((playerId) => participantNames.get(playerId)).filter((value): value is string => Boolean(value));
    const firstHit = group.find((item) => item.kind === "hit");
    const anchorSeconds = firstHit?.timeSeconds ?? first.timeSeconds;
    const snapshots = ([-30, 0, 30] as const).map((offsetSeconds) => {
      const targetTimeSeconds = anchorSeconds + offsetSeconds;
      const anchorLabel: DailyEncounterSnapshot["anchorLabel"] = firstHit ? "처음 기록된 피해" : "처음 기록된 교전 행동";
      const points: DailyEncounterSnapshotPoint[] = [];
      const missingPlayers: string[] = [];
      const deadPlayerIds: string[] = [];
      for (const [playerId, subject] of subjects) {
        const targetState = stateAt(playerId, targetTimeSeconds);
        if (targetState.dead) {
          deadPlayerIds.push(playerId);
          missingPlayers.push(subject.player);
          continue;
        }
        const samples = positionsByPlayer.get(playerId) ?? [];
        let low = 0;
        let high = samples.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if ((samples[mid].timeSeconds ?? Infinity) < targetTimeSeconds) low = mid + 1;
          else high = mid;
        }
        const candidates = [samples[low - 1], samples[low]].filter((item) => item?.timeSeconds !== null && item
          && !stateAt(playerId, item.timeSeconds!, item.sourceIndex).dead
          && stateAt(playerId, item.timeSeconds!, item.sourceIndex).life === targetState.life);
        const closest = candidates.sort((a, b) => Math.abs(a.timeSeconds! - targetTimeSeconds) - Math.abs(b.timeSeconds! - targetTimeSeconds))[0];
        const ageSeconds = closest ? Math.abs(closest.timeSeconds! - targetTimeSeconds) : Infinity;
        const nearest = closest && ageSeconds <= 15
          ? { event: closest.event, sourceIndex: closest.sourceIndex, timeSeconds: closest.timeSeconds!, ageSeconds } : null;
        if (!nearest) {
          missingPlayers.push(subject.player);
          continue;
        }
        points.push({ playerId, player: subject.player, side: subject.side, directlyInvolved: subject.directlyInvolved,
          x: nearest.event.character.location.x, y: nearest.event.character.location.y,
          sampleTimeSeconds: nearest.timeSeconds, ageSeconds: nearest.ageSeconds, sourceIndices: [nearest.sourceIndex] });
      }
      return { offsetSeconds, anchorLabel, targetTimeSeconds, points, missingPlayers, deadPlayerIds };
    });
    const hitPairs = new Set<string>();
    const recordedHits = group.filter((item) => item.kind === "hit").filter((item) => {
      const key = `${id(item.source.attacker) ?? name(item.source.attacker)}>${id(item.source.victim) ?? name(item.source.victim)}`;
      if (hitPairs.has(key)) return false;
      hitPairs.add(key);
      return true;
    });
    const actions: DailyEncounterAction[] = recordedHits.map((item) => ({
      timeSeconds: item.timeSeconds, kind: "first_hit",
      actor: name(item.source.attacker), victim: name(item.source.victim),
      weapon: weaponName(item.source.damageCauserName),
      distanceMeters: distance(item.source.attacker, item.source.victim),
      sourceIndices: [item.sourceIndex], actorId: id(item.source.attacker), victimId: id(item.source.victim),
      actorTeamId: item.source.attacker?.teamId, victimTeamId: item.source.victim?.teamId,
      actorInVehicle: typeof item.source.attacker?.isInVehicle === "boolean" ? item.source.attacker.isInVehicle : undefined,
      victimInVehicle: typeof item.source.victim?.isInVehicle === "boolean" ? item.source.victim.isInVehicle : undefined,
    }));
    for (const item of group) {
      if (item.kind === "hit") continue;
      const source = item.source;
      const attacker = item.kind === "kill" ? source.killer : source.attacker;
      const victim = source.victim;
      actions.push({ timeSeconds: item.timeSeconds,
        kind: item.kind === "kill" ? "kill" : rosterIds.has(id(victim)) ? "ally_down" : "knock",
        actor: name(attacker), victim: name(victim),
        weapon: weaponName(item.kind === "kill"
          ? source.killerDamageInfo?.damageCauserName ?? source.dBNODamageInfo?.damageCauserName
          : source.damageCauserName),
        distanceMeters: distance(attacker, victim),
        sourceIndices: [item.sourceIndex], actorId: id(attacker), victimId: id(victim),
        actorTeamId: attacker?.teamId, victimTeamId: victim?.teamId,
        actorInVehicle: typeof attacker?.isInVehicle === "boolean" ? attacker.isInVehicle : undefined,
        victimInVehicle: typeof victim?.isInVehicle === "boolean" ? victim.isInVehicle : undefined,
      });
    }
    actions.sort((a, b) => a.timeSeconds - b.timeSeconds);
    const recordedShots = events.flatMap((event, sourceIndex) => event._T === "LogPlayerAttack"
      && id(event.attacker) === targetId
      && (seconds(event, startMs) ?? Infinity) >= first.timeSeconds - 3
      && (seconds(event, startMs) ?? -Infinity) <= last.timeSeconds + 1
      ? [{ event, sourceIndex }] : [])
      .map(({ event, sourceIndex }) => ({ timeSeconds: seconds(event, startMs)!, weapon: weaponName(event.weapon?.itemId), sourceIndex, event }))
      .filter((shot) => shot.weapon !== "무기 확인 불가" && !["수류탄", "화염병", "연막탄", "섬광탄"].includes(shot.weapon));
    const shots = recordedShots.map((shot) => shot.weapon);
    const rankerWeapons = shots.filter((weapon, shotIndex) => shotIndex === 0 || weapon !== shots[shotIndex - 1]);
    const nearbyLandings = targetLanding && first.timeSeconds < 300
      ? landing.filter((event) => opponents.includes(name(event.character))
        && Math.abs((seconds(event, startMs) ?? Infinity) - (seconds(targetLanding, startMs) ?? 0)) <= 60
        && (distance(targetLanding.character, event.character) ?? Infinity) <= 500) : [];
    const arrival = nearbyLandings.length
      ? `확인된 상대 ${nearbyLandings.length}명도 랭커 착지점에서 500m 안에 내렸습니다.` : null;
    const firstAttacker = firstHit?.source.attacker;
    const firstVictim = firstHit?.source.victim;
    const vehicle = firstAttacker?.isInVehicle === true || firstVictim?.isInVehicle === true
      ? `첫 피해 때 ${[firstAttacker, firstVictim].filter((person) => person?.isInVehicle === true).map(name).join("·")}이(가) 차량에 타고 있었습니다.`
      : firstAttacker?.isInVehicle === false && firstVictim?.isInVehicle === false
        ? "첫 피해를 주고받은 두 선수는 차량에 타고 있지 않았습니다." : null;
    const teamKills = group.filter((item) => item.kind === "kill" && rosterIds.has(id(item.source.killer))).length;
    if (!teamKills && !group.some((item) => item.kind === "knock") && !firstHit) return [];
    const precontactMovement = [...rosterIds].flatMap((playerId) => {
      const before = positions.filter((item) => id(item.event.character) === playerId
        && item.timeSeconds !== null && item.timeSeconds >= first.timeSeconds - 40
        && item.timeSeconds <= first.timeSeconds - 20).at(-1);
      const near = positions.filter((item) => id(item.event.character) === playerId
        && item.timeSeconds !== null && item.timeSeconds >= first.timeSeconds - 12
        && item.timeSeconds <= first.timeSeconds).at(-1);
      const meters = before && near ? distance(before.event.character, near.event.character) : null;
      return meters === null ? [] : [{ player: name(near!.event.character), meters }];
    });
    return [{ id: `encounter-${index + 1}`, sourceIndices: group.map((item) => item.sourceIndex), startSeconds: first.timeSeconds, endSeconds: last.timeSeconds,
      opponents, allies: involvedAllies, opponentIdentity: {
        key: first.opponentKey, teamId: first.opponentTeamId,
        playerIds: opponentPlayers.map(({ id }) => id), players: opponentPlayers.map((player) => {
          const death = stateAt(player.id, last.timeSeconds);
          return { ...player, ...(death.dead && death.deathTimeSeconds !== undefined ? {
            deathTimeSeconds: death.deathTimeSeconds,
            ...(death.killerTeamId === undefined ? {} : { deathKillerTeamId: death.killerTeamId }),
          } : {}) };
        }),
      }, involvedAllies, rosterAllies, teamKills, rankerWeapons, firstRankerShot: recordedShots[0] ? {
        timeSeconds: recordedShots[0].timeSeconds, weapon: recordedShots[0].weapon,
        sourceIndices: [recordedShots[0].sourceIndex], actorId: id(recordedShots[0].event.attacker),
        actorTeamId: recordedShots[0].event.attacker?.teamId,
      } : null,
      precontactMovement, arrival, vehicle, actions, snapshots }];
  });

  const previousByOpponent = new Map<string, DailyEncounter>();
  for (const encounter of encounters) {
    const key = encounter.opponentIdentity?.key;
    if (!key) continue;
    const previous = previousByOpponent.get(key);
    encounter.reengagement = previous
      ? { isReengagement: true, previousEncounterId: previous.id,
        gapSeconds: Math.max(0, encounter.startSeconds - previous.endSeconds) }
      : { isReengagement: false, previousEncounterId: null, gapSeconds: null };
    previousByOpponent.set(key, encounter);
  }
  for (const encounter of encounters) {
    encounter.overlapsWith = encounters.filter((other) => other !== encounter
      && other.startSeconds <= encounter.endSeconds && encounter.startSeconds <= other.endSeconds)
      .map((other) => other.id);
  }

  const pickupKinds = new Set(["LogItemPickup", "LogItemPickupFromLootBox", "LogItemPickupFromLootbox",
    "LogItemPickupFromCarepackage", "LogItemPickupFromVehicleTrunk"]);
  const pickups = events.flatMap((event, arrayIndex) => pickupKinds.has(event._T) && rosterIds.has(id(event.character))
    && event.item?.category === "Weapon" ? [{ event, sourceIndex: arrayIndex }] : []).flatMap(({ event, sourceIndex }) => {
    const timeSeconds = seconds(event, startMs);
    const weapon = weaponName(event.item?.itemId);
    return timeSeconds === null || weapon === "무기 확인 불가" ? [] : [{ event, sourceIndex, timeSeconds, weapon }];
  }).sort((a, b) => a.timeSeconds - b.timeSeconds);
  const weaponFinds: DailyWeaponFind[] = [];
  for (const item of pickups) {
    const player = name(item.event.character);
    const same = weaponFinds.find((find) => find.player === player && find.weapon === item.weapon
      && Math.abs(find.timeSeconds - item.timeSeconds) <= 0.5);
    const source: DailyWeaponFind["source"] = item.event._T === "LogItemPickupFromCarepackage" ? "carepackage"
      : /Loot[Bb]ox/.test(item.event._T) ? "lootbox"
        : item.event._T === "LogItemPickupFromVehicleTrunk" ? "vehicle" : "ground";
    const owner = source === "lootbox" ? participantNames.get(item.event.creatorAccountId) ?? null : null;
    if (same) {
      same.sourceIndices = [...new Set([...(same.sourceIndices ?? []), item.sourceIndex])];
      if (source !== "ground") { same.source = source; same.owner = owner; }
    } else weaponFinds.push({ timeSeconds: item.timeSeconds, player, weapon: item.weapon, source, owner,
      sourceIndices: [item.sourceIndex], playerId: id(item.event.character), teamId: item.event.character?.teamId });
  }
  return { encounters, weaponFinds };
}
