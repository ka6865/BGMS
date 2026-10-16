import { describe, expect, it } from "vitest";
import { buildPositionTracks, samplePosition, sampleHealth, toPositionTrack } from "@/lib/replay/replayInterpolation";
import { classifyDamageCause, classifyThrowable, isCombatDamageCause } from "@/lib/pubg-analysis/replayEventKinds";

const position = (name: string, relativeTimeMs: number, x: number, health?: number) =>
  ({ type: "position", name, relativeTimeMs, x, y: 0, ...(health === undefined ? {} : { health }) });

describe("리플레이 위치·체력 조회", () => {
  it("선수별로 묶어 시간순으로 정렬하고 위치를 선형 보간한다", () => {
    const tracks = buildPositionTracks([position("B", 10_000, 200), position("A", 0, 0), position("a", 10_000, 100), { type: "shot", name: "A" }]);
    expect([...tracks.keys()]).toEqual(["b", "a"]);
    expect(samplePosition(tracks.get("a"), 5_000)).toMatchObject({ x: 50, y: 0 });
    expect(samplePosition(tracks.get("a"), -1)).toMatchObject({ x: 0 });
    expect(samplePosition(tracks.get("a"), 99_000)).toMatchObject({ x: 100 });
    expect(samplePosition(undefined, 0)).toBeNull();
  });

  it("긴 공백(재배치)은 잇지 않고 이전 위치에 머문다", () => {
    const track = toPositionTrack([position("A", 0, 0), position("A", 400_000, 7_000)]);
    expect(samplePosition(track, 200_000)).toMatchObject({ x: 0 });
    expect(samplePosition(track, 400_000)).toMatchObject({ x: 7_000 });
  });

  it("체력은 보간하지 않고 마지막 관측값을 쓰며 0도 그대로 둔다", () => {
    const track = toPositionTrack([position("A", 0, 0, 100), position("A", 10_000, 10, 0), position("A", 20_000, 20)]);
    expect(sampleHealth(track, 9_999)).toBe(100);
    expect(sampleHealth(track, 10_000)).toBe(0);
    expect(sampleHealth(track, 25_000)).toBe(0);
    expect(sampleHealth([], 0)).toBeNull();
  });
});

describe("피해 원인·투척물 분류 (실제 텔레메트리 값)", () => {
  it.each([
    ["Damage_Gun", "WeapHK416_C", "gun"],
    ["Damage_Gun_Penetrate_BRDM", "", "gun"],
    ["Damage_Explosion_Grenade", "ProjGrenade_C", "grenade"],
    ["Damage_Molotov", "BP_MolotovFireDebuff_C", "fire"],
    ["Damage_BlueZone", "", "zone"],
    ["Damage_DBNO", "", "bleed"],
    ["Damage_Instant_Fall", "", "fall"],
    ["Damage_VehicleCrashHit", "", "vehicle"],
    ["Damage_Kick", "", "melee"],
    ["Damage_BlueZoneGrenade", "", "explosion"],
    [undefined, undefined, "other"],
  ])("%s → %s", (category, causer, expected) => {
    expect(classifyDamageCause(category, causer)).toBe(expected);
  });

  it("자기장·출혈·낙하·익사는 교전 피해가 아니고, 원인이 없던 예전 데이터는 교전으로 본다", () => {
    expect(["zone", "bleed", "fall", "drown"].some(isCombatDamageCause)).toBe(false);
    expect(["gun", "grenade", "fire", "vehicle", "melee"].every(isCombatDamageCause)).toBe(true);
    expect(isCombatDamageCause(undefined)).toBe(true);
  });

  it.each([
    ["Item_Weapon_SmokeBomb_C", "smoke"],
    ["Item_Weapon_M79_C", "smoke"],
    ["Item_Weapon_Grenade_C", "grenade"],
    ["Item_Weapon_BluezoneGrenade_C", "bluezone"],
    ["Item_Weapon_Molotov_C", "molotov"],
    ["Item_Weapon_FlashBang_C", "flash"],
    ["Item_Weapon_CoverStructDropHandFlare_C", "cover"],
    ["Item_Weapon_PackageFlare_C", "flare"],
    ["Item_Weapon_HK416_C", null],
  ])("%s → %s", (itemId, expected) => {
    expect(classifyThrowable(itemId)).toBe(expected);
  });
});
