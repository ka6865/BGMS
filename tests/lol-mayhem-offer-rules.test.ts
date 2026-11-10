import { describe, expect, it } from "vitest";
import { MAYHEM_RANDOM_EXCLUDED, MAYHEM_RANDOM_GRANTERS, mayhemOfferNotes } from "@/lib/lol/mayhemOfferRules";

describe("증강 등장 조건 표", () => {
  it("무작위 제외 증강은 제외 안내를 먼저 붙이고, 개별 조건을 뒤에 붙인다", () => {
    expect(mayhemOfferNotes(1134).map(note => note.text)).toEqual([
      "전환·판도라의 상자·나는 왕이다가 무작위로 주는 증강에서는 나오지 않습니다.",
      "루난의 허리케인을 가지고 있으면 제시되지 않습니다.",
    ]);
    expect(mayhemOfferNotes(9999)).toEqual([]);
  });

  it("공식 원문으로 확인하지 못한 정보는 모두 확인 필요로 남는다", () => {
    const ids = [...MAYHEM_RANDOM_EXCLUDED.ids, ...MAYHEM_RANDOM_GRANTERS];
    expect(ids.flatMap(mayhemOfferNotes).every(note => !note.verified)).toBe(true);
    // 주는 쪽과 제외되는 쪽이 겹치면 안내가 모순된다.
    expect(MAYHEM_RANDOM_EXCLUDED.ids.some(id => (MAYHEM_RANDOM_GRANTERS as readonly number[]).includes(id))).toBe(false);
  });
});
