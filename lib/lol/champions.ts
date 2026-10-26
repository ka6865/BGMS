export const LOL_CHAMPION_TAGS = ["Fighter", "Tank", "Mage", "Assassin", "Marksman", "Support"] as const;
export type LolChampionTag = (typeof LOL_CHAMPION_TAGS)[number];

export const LOL_CHAMPION_TAG_LABELS: Record<LolChampionTag, string> = {
  Fighter: "전사", Tank: "탱커", Mage: "마법사", Assassin: "암살자", Marksman: "원거리", Support: "서포터",
};

export type LolChampion = {
  /** Riot API의 championId (Data Dragon key) */
  id: number;
  /** Data Dragon 이미지 파일 이름 */
  imageId: string;
  name: string;
  title: string;
  tags: LolChampionTag[];
};

const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const choseong = (text: string) => [...text].map(char => {
  const code = char.charCodeAt(0) - 0xac00;
  return code >= 0 && code < 11172 ? CHOSEONG[Math.floor(code / 588)] : char;
}).join("");

// 공백을 무시하고 한글 이름, 초성(예: ㅇㄹ), 영문 ID 일부로 찾는다.
export function filterLolChampions(champions: LolChampion[], query: string, tag: LolChampionTag | null): LolChampion[] {
  const needle = query.replace(/\s+/g, "").toLowerCase();
  const initialsOnly = needle !== "" && [...needle].every(char => CHOSEONG.includes(char));
  return champions.filter(champion => {
    if (tag && !champion.tags.includes(tag)) return false;
    if (!needle) return true;
    const name = champion.name.replace(/\s+/g, "").toLowerCase();
    return name.includes(needle) || champion.imageId.toLowerCase().includes(needle) || (initialsOnly && choseong(name).includes(needle));
  });
}
