// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

let pathname = "/stats/steam/FixturePlayer";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => pathname,
}));
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/components/common/GlobalMobileMenu", () => ({ default: () => null }));

import BottomNav, { isStatsPath } from "@/components/common/BottomNav";

afterEach(() => cleanup());

describe("BottomNav stats active", () => {
  it("stats와 모든 하위 route를 stats path로 분류한다", () => {
    expect(isStatsPath("/stats")).toBe(true);
    expect(isStatsPath("/stats/steam/FixturePlayer")).toBe(true);
    expect(isStatsPath("/stats/steam/FixturePlayer/weapons")).toBe(true);
    expect(isStatsPath("/rankings")).toBe(false);
  });

  it("player detail route에서도 AI 전적 nav를 활성 표시한다", () => {
    pathname = "/stats/steam/FixturePlayer";
    render(createElement(BottomNav));

    const link = screen.getByRole("link", { name: "AI 전적" });
    const style = link.getAttribute("style");
    expect(style).toContain("var(--color-accent)");
    expect(link).toHaveAttribute("aria-current", "page");
  });

  it("이동 탭은 실제 링크(href)이고 메뉴만 버튼이다", () => {
    pathname = "/rankings";
    render(createElement(BottomNav));

    expect(screen.getByRole("link", { name: "지도" })).toHaveAttribute("href", "/maps/erangel");
    expect(screen.getByRole("link", { name: "AI 전적" })).toHaveAttribute("href", "/stats");
    expect(screen.getByRole("link", { name: "랭킹" })).toHaveAttribute("href", "/rankings");
    expect(screen.getByRole("link", { name: "커뮤니티" })).toHaveAttribute("href", "/board");
    expect(screen.getByRole("button", { name: "메뉴" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "랭킹" })).toBeNull();
  });
});
