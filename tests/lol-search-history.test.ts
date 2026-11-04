import { describe, expect, it } from "vitest";
import {
  emptyLolSearchHistory,
  loadLolSearchHistory,
  normalizeLolRiotId,
  recordLolSearch,
  removeLolRecent,
  saveLolSearchHistory,
  toggleLolFavorite,
} from "../lib/lol/searchHistory";

function memoryStorage(initial: string | null = null): Storage {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => { value = next; },
    removeItem: () => { value = null; },
    clear: () => { value = null; },
    key: () => null,
    get length() { return value === null ? 0 : 1; },
  };
}

describe("LoL 검색 기록", () => {
  it("Riot ID를 검증하고 대소문자 중복을 최신 항목으로 합친다", () => {
    expect(normalizeLolRiotId("  Player#kr1 ")).toBe("Player#kr1");
    expect(normalizeLolRiotId("bad#tag-with-dash")).toBeNull();
    const result = recordLolSearch(recordLolSearch(emptyLolSearchHistory(), "Player#KR1"), "player#kr1");
    expect(result.recent).toEqual(["player#kr1"]);
  });

  it("최근 10개와 즐겨찾기 20개를 제한하고 삭제한다", () => {
    let history = emptyLolSearchHistory();
    for (let i = 0; i < 12; i++) history = recordLolSearch(history, `Player${i}#KR1`);
    expect(history.recent).toHaveLength(10);
    expect(history.recent[0]).toBe("Player11#KR1");
    for (let i = 0; i < 20; i++) history = toggleLolFavorite(history, `Player${i}#KR1`)!;
    expect(toggleLolFavorite(history, "Player20#KR1")).toBeNull();
    history = toggleLolFavorite(history, "PLAYER0#kr1")!;
    expect(history.favorites).toHaveLength(19);
    expect(removeLolRecent(history, "PLAYER11#kr1").recent).toHaveLength(9);
  });

  it("복원·저장하고 손상되거나 차단된 저장소를 실패로 반환한다", () => {
    const storage = memoryStorage();
    const history = recordLolSearch(emptyLolSearchHistory(), "Player#KR1");
    expect(saveLolSearchHistory(history, storage)).toBe(true);
    expect(loadLolSearchHistory(storage)).toEqual(history);
    expect(loadLolSearchHistory(memoryStorage("{"))).toBeNull();
    const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } as unknown as Storage;
    expect(loadLolSearchHistory(blocked)).toBeNull();
    expect(saveLolSearchHistory(history, blocked)).toBe(false);
  });
});
