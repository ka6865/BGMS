import { describe, expect, it } from "vitest";
import { mergeRecentMatchIds } from "@/lib/pubg/recentMatches";

describe("최근 매치 ID 병합", () => {
  it("PUBG API의 최신 매치 뒤에 기존 캐시 매치를 순서대로 보존한다", () => {
    expect(
      mergeRecentMatchIds(
        ["newest-match", "new-match"],
        ["cached-latest-match", "cached-old-match"],
      ),
    ).toEqual([
      "newest-match",
      "new-match",
      "cached-latest-match",
      "cached-old-match",
    ]);
  });

  it("새 매치와 캐시 매치에 중복된 ID를 하나만 남긴다", () => {
    expect(
      mergeRecentMatchIds(
        ["match-3", "match-2", "match-2"],
        ["match-2", "match-1", "match-1"],
      ),
    ).toEqual(["match-3", "match-2", "match-1"]);
  });

  it("병합한 매치 목록을 표시 상한인 20건으로 제한한다", () => {
    const apiMatchIds = Array.from({ length: 4 }, (_, index) => `new-${index + 1}`);
    const cachedMatchIds = Array.from({ length: 25 }, (_, index) => `cached-${index + 1}`);

    const mergedMatchIds = mergeRecentMatchIds(apiMatchIds, cachedMatchIds);

    expect(mergedMatchIds).toHaveLength(20);
    expect(mergedMatchIds.slice(0, 4)).toEqual(apiMatchIds);
    expect(mergedMatchIds.at(-1)).toBe("cached-16");
  });
});
