// 증강이 제시되지 않는 조건을 직접 정리한 표다. Riot이 공개 데이터로 주지 않아 패치노트와 커뮤니티 정리를 옮겼다.
// verified=false는 Riot 원문으로 확인하지 못한 정보라 화면에 "확인 필요"로 표시한다. 키는 공식 증강 번호(AugmentPlatformId)다.
export type MayhemOfferRule = { text: string; patch: string; verified: boolean };

// 무작위로 증강을 주는 증강(전환·판도라의 상자·나는 왕이다)과 거기서 나오지 않는다고 알려진 증강.
export const MAYHEM_RANDOM_GRANTERS = [1238, 1237, 1243, 12317, 1337] as const;
export const MAYHEM_RANDOM_EXCLUDED = { ids: [1205, 1004, 1134, 1206, 1311, 2018], removedNames: ["어깨 위의 악마", "흡혈병", "궁극기 봇"], patch: "26.18", verified: false } as const;

export const MAYHEM_OFFER_RULES: Record<number, MayhemOfferRule[]> = {
  1134: [{ text: "루난의 허리케인을 가지고 있으면 제시되지 않습니다.", patch: "26.17", verified: false }],
  1004: [{ text: "궁극기로 모습을 바꾸는 제이스·니달리·엘리스에게는 제시되지 않습니다.", patch: "", verified: false }],
  1243: [{ text: "펜타킬 헤드라이너 게임에서는 등장하지 않습니다.", patch: "26.21", verified: false }],
  1337: [{ text: "펜타킬 헤드라이너 게임에서는 등장하지 않습니다.", patch: "26.21", verified: false }],
};

export function mayhemOfferNotes(id: number): MayhemOfferRule[] {
  const notes = [...(MAYHEM_OFFER_RULES[id] ?? [])];
  if ((MAYHEM_RANDOM_EXCLUDED.ids as readonly number[]).includes(id)) {
    notes.unshift({ text: "전환·판도라의 상자·나는 왕이다가 무작위로 주는 증강에서는 나오지 않습니다.", patch: MAYHEM_RANDOM_EXCLUDED.patch, verified: MAYHEM_RANDOM_EXCLUDED.verified });
  }
  return notes;
}
