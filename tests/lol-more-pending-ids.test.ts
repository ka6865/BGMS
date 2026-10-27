import { describe, expect, it } from "vitest";
import { LOL_MATCH_PAGE_SIZE, nextPendingMatchIds } from "@/lib/lol/limits";

const ids = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => `${prefix}${from + index}`);

describe("경기 더 불러오기로 보낼 남은 경기 ID", () => {
  it("첫 페이지 일부만 처리됐으면 그 페이지의 남은 ID만 보낸다", () => {
    const matchIds = ids("A", 1, 20);
    expect(nextPendingMatchIds(matchIds, 5, new Set(ids("A", 1, 5)))).toEqual(ids("A", 6, 20));
  });

  it("갱신으로 새 경기가 앞에 붙어 남은 ID가 두 페이지에 걸치면 현재 페이지 끝에서 자른다", () => {
    // 첫 검색 429로 A1·A2만 처리 → 새 게임 N1~N3 → 갱신 중 429로 N1~N3만 처리된 상태.
    const merged = [...ids("N", 1, 3), ...ids("A", 1, 20)];
    const loaded = new Set([...ids("N", 1, 3), "A1", "A2"]);
    const first = nextPendingMatchIds(merged, 5, loaded);
    // Riot 목록 0~19번 페이지(N1~N3, A1~A17) 안의 A3~A17만 보낸다.
    expect(first).toEqual(ids("A", 3, 17));
    expect(first.length).toBeLessThanOrEqual(LOL_MATCH_PAGE_SIZE);
    // 다음 요청은 offset 20에서 20~39번 페이지의 A18~A20을 보낸다.
    expect(nextPendingMatchIds(merged, 20, new Set([...loaded, ...first]))).toEqual(ids("A", 18, 20));
  });

  it("이미 받은 경기는 빼고, 남은 ID가 없으면 빈 목록으로 다음 페이지 요청을 하게 한다", () => {
    const matchIds = ids("A", 1, 20);
    expect(nextPendingMatchIds(matchIds, 5, new Set([...ids("A", 1, 5), "A7", "A9"]))).toEqual(
      ids("A", 6, 20).filter((id) => id !== "A7" && id !== "A9"));
    expect(nextPendingMatchIds(matchIds, 20, new Set(matchIds))).toEqual([]);
    expect(nextPendingMatchIds(undefined, 0, new Set())).toEqual([]);
  });
});
