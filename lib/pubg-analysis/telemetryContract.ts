import { normalizeName } from "./utils";

export type TelemetryFilterMode = "lite" | "full";

export type TelemetryFilterContext = {
  mode: TelemetryFilterMode;
  teamNames: ReadonlySet<string>;
  teamAccountIds: ReadonlySet<string>;
};

export type TelemetryEventRecord = Record<string, unknown>;

/** The order here is part of the telemetry contract. Do not sort this list. */
export const TELEMETRY_EVENT_ALLOWLIST = [
  "LogMatchStart",
  "LogMatchEnd",
  "LogGameStatePeriodic",
  "LogPhaseStart",
  "LogPhaseChange",
  "LogPlayerCreate",
  "LogPlayerPosition",
  "LogParachuteLanding",
  "LogPlayerAttack",
  "LogPlayerTakeDamage",
  "LogPlayerMakeGroggy",
  "LogPlayerMakeDBNO",
  "LogPlayerKill",
  "LogPlayerKillV2",
  "LogPlayerRevive",
  "LogPlayerRecall",
  "LogPlayerRecallShip",
  "LogPlayerRedeploy",
  "LogPlayerRedeployBRStart",
  "LogPlayerUseThrowable",
  "LogWeaponFire",
  "LogPlayerUseHeal",
  "LogThrowableUse",
  "LogProjectileHit",
  "LogItemUse",
  "LogHeal",
  "LogVehicleRide",
  "LogVehicleLeave",
  "LogCarePackageSpawn",
  "LogCarePackageLand",
  "LogExplosiveExplode",
] as const;

const ALLOWLIST = new Set<string>(TELEMETRY_EVENT_ALLOWLIST);

type PlainRecord = Record<string, unknown>;

const ACTOR_KEYS = [
  "attacker",
  "victim",
  "killer",
  "finisher",
  "dBNOMaker",
  "maker",
  "reviver",
  "recaller",
  "character",
  "recallingPlayer",
  "recalledPlayer",
  "assistant",
] as const;

const ACTOR_FIELDS = [
  "name",
  "characterName",
  "accountId",
  "playerId",
  "teamId",
  "health",
  "isInVehicle",
  "rotation",
  "viewDir",
  "weaponId",
  "heldItems",
] as const;

const ITEM_KEYS = ["item", "weapon", "damageCauser", "explosiveItem"] as const;
const ITEM_FIELDS = [
  "itemId",
  "name",
  "stackCount",
  "category",
  "subCategory",
  "attachedItems",
] as const;

const VEHICLE_FIELDS = [
  "vehicleId",
  "vehicleType",
  "vehicleUniqueId",
  "healthPercent",
  "velocity",
  "seatIndex",
  "isWheelsInAir",
  "isInWaterVolume",
  "isEngineOn",
] as const;

const SCALAR_FIELDS = [
  "attackId",
  "fireWeaponStackCount",
  "attackType",
  "dBNOId",
  "damage",
  "damageReason",
  "damageTypeCategory",
  "damageCauserName",
  "distance",
  "phase",
  "elapsedTime",
  "isThroughPenetrableWall",
  "isAttackerInVehicle",
  "isSuicide",
  "reviveType",
  "weaponId",
  "victimWeapon",
  "victimWeaponAdditionalInfo",
  "killerDamageInfo",
  "finishDamageInfo",
  "dBNODamageInfo",
  // Existing consumers still read this top-level field on the projected event.
  "isGame",
  "explosiveId",
  // Match-level custom/event evidence is consumed by the population
  // eligibility boundary; keep both official camelCase and stored aliases.
  "isCustomGame",
  "is_custom_game",
  "isEventMode",
  "is_event_mode",
  "isCustomMatch",
  "is_custom_match",
] as const;

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Clone only JSON-shaped values so projections never share mutable input objects. */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  if (isRecord(value)) {
    const result: PlainRecord = {};
    Object.entries(value).forEach(([key, item]) => {
      result[key] = cloneValue(item);
    });
    return result as T;
  }
  return value;
}

function hasValue(record: PlainRecord, key: string): boolean {
  return record[key] !== undefined;
}

/**
 * Normalize an official Location without inventing a coordinate when x/y are
 * absent. PUBG payloads occasionally use `loc` and omit z; z then defaults to
 * zero while x and y retain their original finite numeric values.
 */
export function normalizeTelemetryLocation(
  value: unknown,
): { x: number; y: number; z: number } | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, z } = value;
  if (typeof x !== "number" || !Number.isFinite(x) ||
      typeof y !== "number" || !Number.isFinite(y)) {
    return undefined;
  }
  return {
    x,
    y,
    z: typeof z === "number" && Number.isFinite(z) ? z : 0,
  };
}

function projectVehicle(value: unknown): unknown {
  if (!isRecord(value)) return cloneValue(value);
  const result: PlainRecord = {};
  VEHICLE_FIELDS.forEach((field) => {
    if (hasValue(value, field)) result[field] = cloneValue(value[field]);
  });
  return result;
}

function projectActor(value: unknown): PlainRecord | null {
  if (typeof value === "string") return { name: value };
  if (!isRecord(value)) return null;

  const result: PlainRecord = {};
  ACTOR_FIELDS.forEach((field) => {
    if (hasValue(value, field)) result[field] = cloneValue(value[field]);
  });

  // `location` is canonical; use `loc` only when location is absent/null.
  const locationSource = value.location ?? value.loc;
  const location = normalizeTelemetryLocation(locationSource);
  if (location) result.location = location;

  if (hasValue(value, "vehicle")) {
    result.vehicle = projectVehicle(value.vehicle);
  }
  return result;
}

function projectItem(value: unknown): unknown {
  if (!isRecord(value)) return cloneValue(value);
  const result: PlainRecord = {};
  ITEM_FIELDS.forEach((field) => {
    if (hasValue(value, field)) result[field] = cloneValue(value[field]);
  });
  return result;
}

function projectActorWrapper(value: unknown): unknown {
  if (!isRecord(value)) return projectActor(value);
  if (!Object.prototype.hasOwnProperty.call(value, "character")) {
    return projectActor(value);
  }

  const result: PlainRecord = {};
  // Wrapper metadata is intentionally limited to scalar values. The nested
  // character is projected through the same actor contract as direct actors.
  Object.entries(value).forEach(([key, item]) => {
    if (key === "character") return;
    if (item === null || typeof item !== "object") result[key] = cloneValue(item);
  });
  const character = projectActor(value.character);
  if (character) result.character = character;
  return result;
}

function projectGameState(value: unknown): PlainRecord | null {
  if (!isRecord(value)) return null;
  const result: PlainRecord = {};
  const locations = [
    "safetyZonePosition",
    "poisonGasWarningPosition",
  ] as const;
  locations.forEach((key) => {
    if (!hasValue(value, key)) return;
    const location = normalizeTelemetryLocation(value[key]);
    if (location) result[key] = location;
  });
  [
    "safetyZoneRadius",
    "poisonGasWarningRadius",
    "isZoneMoving",
  ].forEach((key) => {
    if (hasValue(value, key)) result[key] = cloneValue(value[key]);
  });
  return result;
}

function dedupeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((item) => {
    if (typeof item !== "string" || seen.has(item)) return;
    seen.add(item);
    result.push(item);
  });
  return result;
}

function projectOfficialAccountArray(
  source: PlainRecord,
  officialKey: "assists_AccountId" | "teamKillers_AccountId",
  aliasKey: "assistantAccountIds" | "teamKillerAccountIds",
  result: PlainRecord,
): void {
  const sourceKey = Array.isArray(source[officialKey]) ? officialKey : aliasKey;
  if (!Array.isArray(source[sourceKey])) return;
  const values = dedupeStringArray(source[sourceKey]) || [];
  result[officialKey] = values;
  result[aliasKey] = [...values];
}

function copyCharacters(source: PlainRecord, eventType: string, result: PlainRecord): void {
  if (eventType !== "LogPlayerRedeployBRStart" && eventType !== "LogMatchEnd") return;
  if (!Array.isArray(source.characters)) return;
  result.characters = source.characters.map((item) => projectActorWrapper(item));
}

function copyRecalledPlayers(source: PlainRecord, result: PlainRecord): void {
  if (!Array.isArray(source.recalledPlayers)) return;
  result.recalledPlayers = source.recalledPlayers.map((item) => projectActorWrapper(item));
}

function copyItemPackage(source: PlainRecord, result: PlainRecord): void {
  if (!isRecord(source.itemPackage)) return;
  const itemPackage: PlainRecord = {};
  if (hasValue(source.itemPackage, "itemPackageId")) {
    itemPackage.itemPackageId = cloneValue(source.itemPackage.itemPackageId);
  }
  if (hasValue(source.itemPackage, "location")) {
    const location = normalizeTelemetryLocation(source.itemPackage.location);
    if (location) itemPackage.location = location;
  }
  if (Object.keys(itemPackage).length > 0) {
    result.itemPackage = itemPackage;
    if (itemPackage.location) result.location = cloneValue(itemPackage.location);
  }
}

/** Project one official event into the shared, bounded consumer contract. */
export function projectTelemetryEvent(event: unknown): TelemetryEventRecord | null {
  if (!isRecord(event) || typeof event._T !== "string" || !ALLOWLIST.has(event._T)) {
    return null;
  }

  const result: TelemetryEventRecord = { _T: event._T };
  if (hasValue(event, "_D")) result._D = cloneValue(event._D);

  ["common", "Common"].forEach((key) => {
    const value = event[key];
    if (!isRecord(value)) return;
    const flag = key === "common" ? "isGame" : "IsGame";
    if (hasValue(value, flag)) result[key] = { [flag]: cloneValue(value[flag]) };
  });

  ACTOR_KEYS.forEach((key) => {
    if (!hasValue(event, key)) return;
    const actor = projectActor(event[key]);
    if (actor) result[key] = actor;
  });

  ITEM_KEYS.forEach((key) => {
    if (!hasValue(event, key)) return;
    result[key] = projectItem(event[key]);
  });

  if (hasValue(event, "vehicle")) result.vehicle = projectVehicle(event.vehicle);

  // Event-level locations are used by care-package and explosion consumers.
  // Keep `location` ahead of the legacy `loc` fallback and let itemPackage's
  // official nested location override it when valid.
  const eventLocation = normalizeTelemetryLocation(event.location ?? event.loc);
  if (eventLocation) result.location = eventLocation;

  SCALAR_FIELDS.forEach((field) => {
    if (hasValue(event, field)) result[field] = cloneValue(event[field]);
  });

  if (event._T === "LogGameStatePeriodic" && hasValue(event, "gameState")) {
    const gameState = projectGameState(event.gameState);
    if (gameState) result.gameState = gameState;
  }

  projectOfficialAccountArray(event, "assists_AccountId", "assistantAccountIds", result);
  projectOfficialAccountArray(event, "teamKillers_AccountId", "teamKillerAccountIds", result);
  copyRecalledPlayers(event, result);
  copyItemPackage(event, result);
  copyCharacters(event, event._T, result);

  // Existing match-end consumers use these two bounded, event-specific fields.
  if (event._T === "LogMatchEnd" && hasValue(event, "allWeaponStats")) {
    result.allWeaponStats = cloneValue(event.allWeaponStats);
  }

  return result;
}

export function filterTelemetryEvents(
  events: readonly unknown[],
  context: TelemetryFilterContext,
): TelemetryEventRecord[] {
  let enemyPositionOrdinal = 0;
  return events.flatMap((event) => {
    const projected = projectTelemetryEvent(event);
    if (!projected) return [];
    if (projected._T !== "LogPlayerPosition" || context.mode === "full") {
      return [projected];
    }

    const actor = isRecord(projected.character) ? projected.character : undefined;
    const accountIds = [actor?.accountId, actor?.playerId]
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .map((value) => String(value));
    const nameValue = actor?.name ?? actor?.characterName;
    const normalizedName = nameValue == null ? "" : normalizeName(String(nameValue));
    const isTeam = accountIds.some((accountId) => accountId.length > 0 && context.teamAccountIds.has(accountId)) ||
      (normalizedName.length > 0 && context.teamNames.has(normalizedName));
    if (isTeam) return [projected];

    enemyPositionOrdinal += 1;
    return enemyPositionOrdinal % 10 === 0 ? [projected] : [];
  });
}
