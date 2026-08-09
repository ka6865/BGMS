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

  it("저장값을 normalized string[]로 읽고 recent 10개 제한을 유지한다", async () => {
    localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(["A", 3, "A", "B", ""]));
    localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(["Fav", null, "Fav"]));
    const { result } = renderHook(() => useStatsSearchHistory());

    await waitFor(() => expect(result.current.recentSearches).toEqual(["A", "B"]));
    expect(result.current.favorites).toEqual(["Fav"]);

    act(() => {
      for (let index = 0; index < 11; index += 1) result.current.addRecent(`P${index}`);
      result.current.toggleFavorite("NewFav");
      result.current.removeRecent("P5");
    });

    expect(result.current.recentSearches).toHaveLength(9);
    expect(result.current.recentSearches).not.toContain("P5");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_RECENT)!)).toEqual(result.current.recentSearches);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_FAVORITES)!)).toEqual(["NewFav", "Fav"]);
  });

  it("hydration load 전 빈 배열을 storage에 덮어쓰지 않는다", async () => {
    localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(["StoredPlayer"]));
    localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(["StoredFavorite"]));
    storageWrites.length = 0;

    const { result } = renderHook(() => useStatsSearchHistory());

    expect(storageWrites).toEqual([]);
    await waitFor(() => expect(result.current.recentSearches).toEqual(["StoredPlayer"]));
    expect(result.current.favorites).toEqual(["StoredFavorite"]);
    expect(storageWrites).toEqual([]);
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
