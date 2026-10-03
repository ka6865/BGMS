// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStatsProfilePrefill } from "@/hooks/useStatsProfilePrefill";
import { useStatsSearchHistory } from "@/hooks/useStatsSearchHistory";
import { STORAGE_KEY_FAVORITES, STORAGE_KEY_RECENT } from "@/lib/pubg-analysis/constants";

const { profileSingleMock } = vi.hoisted(() => ({
  profileSingleMock: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ single: profileSingleMock }),
      }),
    }),
  },
}));

const storage = new Map<string, string>();
const storageWrites: Array<[string, string]> = [];
const localStorageMock: Storage = {
  get length() { return storage.size; },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => Array.from(storage.keys())[index] ?? null,
  removeItem: (key) => storage.delete(key),
  setItem: (key, value) => {
    storageWrites.push([key, String(value)]);
    storage.set(key, String(value));
  },
};

describe("stats profile prefill/history", () => {
  beforeEach(() => {
    storage.clear();
    storageWrites.length = 0;
    profileSingleMock.mockReset();
    vi.stubGlobal("localStorage", localStorageMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("로그인 profile의 nickname/platform을 한 번 읽는다", async () => {
    profileSingleMock.mockResolvedValue({
      data: { pubg_nickname: "ProfilePlayer", pubg_platform: "kakao" },
      error: null,
    });
    const { result, rerender } = renderHook(
      ({ userId }) => useStatsProfilePrefill(userId),
      { initialProps: { userId: undefined as string | undefined } },
    );

    expect(result.current.loaded).toBe(true);
    rerender({ userId: "user-1" });
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current).toEqual({
      nickname: "ProfilePlayer",
      platform: "kakao",
      loaded: true,
    });
    rerender({ userId: "user-1" });
    expect(profileSingleMock).toHaveBeenCalledTimes(1);
  });

  it("비로그인은 profile 요청 없이 loaded 상태가 된다", () => {
    const { result } = renderHook(() => useStatsProfilePrefill());

    expect(result.current.loaded).toBe(true);
    expect(profileSingleMock).not.toHaveBeenCalled();
  });

  it("기존 문자열을 Steam 기록으로 읽고 recent 10개 제한을 유지한다", async () => {
    localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(["A", 3, "A", "B", ""]));
    localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(["Fav", null, "Fav"]));
    const { result } = renderHook(() => useStatsSearchHistory());

    await waitFor(() => expect(result.current.recentSearches.map(entry => entry.nickname)).toEqual(["A", "B"]));
    expect(result.current.favorites).toEqual([{ nickname: "Fav", platform: "steam" }]);

    act(() => {
      for (let index = 0; index < 11; index += 1) result.current.addRecent(`P${index}`);
      result.current.toggleFavorite("NewFav");
      result.current.removeRecent("P5");
    });

    expect(result.current.recentSearches).toHaveLength(9);
    expect(result.current.recentSearches.map(entry => entry.nickname)).not.toContain("P5");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_RECENT)!)).toEqual(result.current.recentSearches);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_FAVORITES)!)).toEqual(result.current.favorites);
  });

  it("hydration load 전 빈 배열을 storage에 덮어쓰지 않는다", async () => {
    localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(["StoredPlayer"]));
    localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(["StoredFavorite"]));
    storageWrites.length = 0;

    const { result } = renderHook(() => useStatsSearchHistory());

    expect(storageWrites).toEqual([]);
    await waitFor(() => expect(result.current.recentSearches).toEqual([{ nickname: "StoredPlayer", platform: "steam" }]));
    expect(result.current.favorites).toEqual([{ nickname: "StoredFavorite", platform: "steam" }]);
    expect(storageWrites).toEqual([]);
  });

  it("플랫폼별 같은 닉네임을 분리하고 대소문자만 다른 중복은 제거한다", () => {
    const { result } = renderHook(() => useStatsSearchHistory());
    act(() => {
      result.current.addRecent("Same", "steam");
      result.current.addRecent("Same", "kakao");
      result.current.addRecent("SAME", "kakao");
      result.current.toggleFavorite("Same", "steam");
      result.current.toggleFavorite("Same", "kakao");
      result.current.toggleFavorite("SAME", "kakao");
    });
    expect(result.current.recentSearches).toEqual([{ nickname: "SAME", platform: "kakao" }, { nickname: "Same", platform: "steam" }]);
    expect(result.current.favorites).toEqual([{ nickname: "Same", platform: "steam" }]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_RECENT)!)).toEqual(result.current.recentSearches);
  });

  it("v2 기록은 읽어 오되 이전 버전에서 읽는 저장값은 덮어쓰지 않는다", () => {
    localStorage.setItem("pubg_recent_searches_v2", JSON.stringify(["OldPlayer"]));
    const { result } = renderHook(() => useStatsSearchHistory());
    expect(result.current.recentSearches).toEqual([{ nickname: "OldPlayer", platform: "steam" }]);
    act(() => result.current.addRecent("NewPlayer", "kakao"));
    expect(JSON.parse(localStorage.getItem("pubg_recent_searches_v2")!)).toEqual(["OldPlayer"]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_RECENT)!)).toEqual(result.current.recentSearches);
  });

  it("읽기·삭제·저장이 차단되어도 화면 내 검색 기록은 유지한다", () => {
    const denied = () => { throw new DOMException("denied", "SecurityError"); };
    vi.stubGlobal("localStorage", { getItem: denied, removeItem: denied, setItem: denied });
    const { result } = renderHook(() => useStatsSearchHistory());
    act(() => {
      result.current.addRecent("KakaoPlayer", "kakao");
      result.current.toggleFavorite("KakaoPlayer", "kakao");
    });
    expect(result.current.recentSearches).toEqual([{ nickname: "KakaoPlayer", platform: "kakao" }]);
    expect(result.current.favorites).toEqual(result.current.recentSearches);
    act(() => result.current.removeRecent("KakaoPlayer", "kakao"));
    expect(result.current.recentSearches).toEqual([]);
  });

  it("배열이 아닌 legacy storage는 빈 목록으로 복구하고 제거한다", async () => {
    localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify({ nickname: "Legacy" }));
    localStorage.setItem(STORAGE_KEY_FAVORITES, "null");
    storageWrites.length = 0;

    const { result } = renderHook(() => useStatsSearchHistory());

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY_RECENT)).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY_FAVORITES)).toBeNull();
    });
    expect(result.current.recentSearches).toEqual([]);
    expect(result.current.favorites).toEqual([]);
    expect(storageWrites).toEqual([]);
  });
});
