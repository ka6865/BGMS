import { describe, expect, it } from "vitest";
import { normalizeSquadWeaponStats } from "../lib/pubg-analysis/squadWeaponStats";

describe("normalizeSquadWeaponStats", () => {
  it("이름 대소문자만 다른 실시간/공식 아군 무기값을 합산하지 않고 공식값을 사용한다", () => {
    const result = normalizeSquadWeaponStats({
      KangHeeSung_: [{
        weapon: "Mk14",
        damage: 398,
        dBNODamage: 50,
        shots: 45,
        hits: 15,
        dBNOHits: 2,
        holdingTime: 23,
        accuracy: 33,
      }],
      kangheesung_: [{
        weapon: "Mk14",
        damage: 397.711,
        dBNODamage: 49.5,
        shots: 0,
        hits: 11,
        dBNOHits: 2,
        holdingTime: 0,
        accuracy: 0,
      }],
    });

    expect(result).toEqual({
      KangHeeSung_: [expect.objectContaining({
        weapon: "Mk14",
        damage: 398,
        hits: 15,
        shots: 45,
        holdingTime: 23,
      })],
    });
  });

  it("공식 통계에 없는 무기는 실시간 수집값을 보완값으로 유지한다", () => {
    const result = normalizeSquadWeaponStats({
      KangHeeSung_: [{
        weapon: "M416",
        damage: 210,
        dBNODamage: 0,
        shots: 80,
        hits: 9,
        dBNOHits: 0,
        holdingTime: 20,
        accuracy: 11,
      }],
      kangheesung_: [{
        weapon: "Mk14",
        damage: 145,
        dBNODamage: 0,
        shots: 0,
        hits: 5,
        dBNOHits: 0,
        holdingTime: 0,
        accuracy: 0,
      }],
    });

    expect(result.KangHeeSung_).toEqual(expect.arrayContaining([
      expect.objectContaining({ weapon: "M416", damage: 210 }),
      expect.objectContaining({ weapon: "Mk14", damage: 145 }),
    ]));
  });
});
