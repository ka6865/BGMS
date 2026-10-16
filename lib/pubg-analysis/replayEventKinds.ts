// 리플레이 이벤트의 피해 원인·투척물 종류 코드. 서버(MapReplayHandler)가 기록하고 화면이 그대로 읽는다.
// PUBG 텔레메트리에는 투척물 착탄·폭발 좌표와 방향 값이 없으므로 위치는 던진 사람이나 피해자 기준으로만 그린다.

export type ReplayDamageCause =
  | "gun"
  | "grenade"
  | "explosion"
  | "fire"
  | "zone"
  | "bleed"
  | "fall"
  | "vehicle"
  | "melee"
  | "drown"
  | "other";

export type ReplayThrowableKind =
  | "smoke"
  | "grenade"
  | "molotov"
  | "flash"
  | "bluezone"
  | "sticky"
  | "c4"
  | "cover"
  | "flare";

/** damageTypeCategory(예: Damage_Gun, Damage_Explosion_Grenade)를 화면용 원인 코드로 줄인다. */
export function classifyDamageCause(category: unknown, causerName?: unknown): ReplayDamageCause {
  const value = typeof category === "string" ? category.toLowerCase() : "";
  const causer = typeof causerName === "string" ? causerName.toLowerCase() : "";
  if (value.startsWith("damage_gun")) return "gun";
  if (value === "damage_explosion_grenade" || causer.startsWith("projgrenade")) return "grenade";
  if (value.includes("bluezonegrenade")) return "explosion";
  if (value.includes("explosion")) return "explosion";
  if (value.includes("molotov") || causer.includes("molotov") || causer.includes("fireeffect")) return "fire";
  if (value.includes("drown")) return "drown";
  if (value.includes("bluezone") || value.includes("redzone") || value.includes("blackzone")) return "zone";
  if (value === "damage_dbno" || value.includes("groggy") || value.includes("bleeding")) return "bleed";
  if (value.includes("fall")) return "fall";
  if (value.includes("vehicle")) return "vehicle";
  if (value.includes("melee") || value.includes("kick") || value.includes("punch")) return "melee";
  return "other";
}

/** 아군·적 사이의 실제 교전으로 볼 수 있는 피해 원인. 자기장·출혈·낙하·익사는 제외한다. */
export function isCombatDamageCause(cause: unknown): boolean {
  return cause === undefined
    || cause === "gun"
    || cause === "grenade"
    || cause === "explosion"
    || cause === "fire"
    || cause === "vehicle"
    || cause === "melee"
    || cause === "other";
}

/** 투척 무기 itemId(예: Item_Weapon_SmokeBomb_C)를 종류로 분류한다. 투척물이 아니면 null. */
export function classifyThrowable(itemId: unknown): ReplayThrowableKind | null {
  const value = typeof itemId === "string" ? itemId.toLowerCase() : "";
  if (!value) return null;
  if (value.includes("smokebomb") || value.includes("m79")) return "smoke";
  if (value.includes("bluezonegrenade")) return "bluezone";
  if (value.includes("stickybomb")) return "sticky";
  if (value.includes("grenade")) return "grenade";
  if (value.includes("molotov")) return "molotov";
  if (value.includes("flashbang")) return "flash";
  if (value.includes("c4")) return "c4";
  if (value.includes("coverstruct")) return "cover";
  if (value.includes("flare")) return "flare";
  return null;
}
