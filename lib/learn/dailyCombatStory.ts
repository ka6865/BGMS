import { getTranslatedWeaponName } from "../pubg-analysis/constants";

type Event = Record<string, any>;

export type DailyEncounterAction = {
  timeSeconds: number;
  kind: "first_hit" | "knock" | "kill" | "ally_down";
  actor: string;
  victim: string;
  weapon: string;
  distanceMeters: number | null;
};

export type DailyEncounter = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  opponents: string[];
  allies: string[];
  teamKills: number;
  rankerWeapons: string[];
  firstRankerShot: { timeSeconds: number; weapon: string } | null;
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
const weaponName = (raw: unknown) => {
  if (typeof raw !== "string" || !raw) return "무기 확인 불가";
  const normalized = raw.startsWith("Item_Weapon_") ? `Weap${raw.slice("Item_Weapon_".length)}` : raw;
  const translated = getTranslatedWeaponName(normalized);
  return /^(Item_|Weap|Proj|Damage_)/.test(translated) ? "무기 확인 불가" : translated;
};

type CombatEvent = {
  source: Event;
  timeSeconds: number;
  opponentKey: string;
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
  for (const event of events) {
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
    const opponentKey = Number.isInteger(opponent.teamId) && opponent.teamId > 0
      ? `team-${opponent.teamId}` : `player-${id(opponent) ?? name(opponent)}`;
    combat.push({ source: event, timeSeconds, opponentKey, ally, opponent, kind });
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
  const positions = events.filter((event) => event._T === "LogPlayerPosition" && rosterIds.has(id(event.character)))
    .map((event) => ({ event, timeSeconds: seconds(event, startMs) }))
    .sort((a, b) => (a.timeSeconds ?? 0) - (b.timeSeconds ?? 0));
  const targetLanding = landing.find((event) => id(event.character) === targetId);
  const encounters = groups.flatMap((group, index): DailyEncounter[] => {
    const first = group[0];
    const last = group.at(-1)!;
    const opponents = [...new Set(group.map((item) => name(item.opponent)))];
    const allies = [...new Set(group.map((item) => name(item.ally)))];
    const firstHit = group.find((item) => item.kind === "hit");
    const actions: DailyEncounterAction[] = [];
    if (firstHit) actions.push({
      timeSeconds: firstHit.timeSeconds, kind: "first_hit",
      actor: name(firstHit.source.attacker), victim: name(firstHit.source.victim),
      weapon: weaponName(firstHit.source.damageCauserName),
      distanceMeters: distance(firstHit.source.attacker, firstHit.source.victim),
    });
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
      });
    }
    const recordedShots = events.filter((event) => event._T === "LogPlayerAttack"
      && id(event.attacker) === targetId
      && (seconds(event, startMs) ?? Infinity) >= first.timeSeconds - 3
      && (seconds(event, startMs) ?? -Infinity) <= last.timeSeconds + 1)
      .map((event) => ({ timeSeconds: seconds(event, startMs)!, weapon: weaponName(event.weapon?.itemId) }))
      .filter((shot) => shot.weapon !== "무기 확인 불가" && !["수류탄", "화염병", "연막탄", "섬광탄"].includes(shot.weapon));
    const recentShots = recordedShots.filter((shot) => shot.timeSeconds >= last.timeSeconds - 30);
    const shots = (recentShots.length ? recentShots : recordedShots).map((shot) => shot.weapon);
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
    if (!teamKills && !group.some((item) => item.kind === "knock")) return [];
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
    return [{ id: `encounter-${index + 1}`, startSeconds: first.timeSeconds, endSeconds: last.timeSeconds,
      opponents, allies, teamKills, rankerWeapons, firstRankerShot: recordedShots[0] ?? null,
      precontactMovement, arrival, vehicle, actions }];
  });

  const pickupKinds = new Set(["LogItemPickup", "LogItemPickupFromLootBox", "LogItemPickupFromLootbox",
    "LogItemPickupFromCarepackage", "LogItemPickupFromVehicleTrunk"]);
  const pickups = events.filter((event) => pickupKinds.has(event._T) && rosterIds.has(id(event.character))
    && event.item?.category === "Weapon").flatMap((event) => {
    const timeSeconds = seconds(event, startMs);
    const weapon = weaponName(event.item?.itemId);
    return timeSeconds === null || weapon === "무기 확인 불가" ? [] : [{ event, timeSeconds, weapon }];
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
      if (source !== "ground") { same.source = source; same.owner = owner; }
    } else weaponFinds.push({ timeSeconds: item.timeSeconds, player, weapon: item.weapon, source, owner });
  }
  return { encounters, weaponFinds };
}
