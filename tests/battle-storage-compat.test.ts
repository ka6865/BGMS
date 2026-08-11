// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BattleClient from "@/app/stats/battle/BattleClient";
import {
  STORAGE_KEY_FAVORITES,
  STORAGE_KEY_RECENT,
} from "@/lib/pubg-analysis/constants";

const storage = new Map<string, string>();
const localStorageMock: Storage = {
  get length() {
    return storage.size;
  },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => Array.from(storage.keys())[index] ?? null,
  removeItem: (key) => storage.delete(key),
  setItem: (key, value) => storage.set(key, String(value)),
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement("a", { href }, children),
}));

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/components/ads/AdfitBanner", () => ({ default: () => null }));
vi.mock("@/components/common/BgmsIcon", () => ({ BgmsIcon: () => null }));

describe("전적 검색과 배틀의 localStorage 호환성", () => {
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", localStorageMock);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("배틀 검색이 공유 string[] 최근검색과 즐겨찾기를 그대로 읽는다", async () => {
    localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(["RecentPlayer"]));
    localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(["FavoritePlayer"]));
    render(createElement(BattleClient));

    fireEvent.focus(screen.getByPlaceholderText("내 닉네임"));

    expect(await screen.findByText("RecentPlayer")).toBeInTheDocument();
    expect(screen.getByText("FavoritePlayer")).toBeInTheDocument();
  });

  it("손상된 공유 저장값은 제거하고 배틀 화면을 계속 렌더링한다", () => {
    localStorage.setItem(STORAGE_KEY_RECENT, "not-json");
    localStorage.setItem(STORAGE_KEY_FAVORITES, "not-json");

    render(createElement(BattleClient));

    expect(screen.getByRole("heading", { name: "전적 비교 배틀" })).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY_RECENT)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY_FAVORITES)).toBe("[]");
  });
});
