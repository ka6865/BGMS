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

    expect(screen.getByRole("button", { name: "AI 전적" })).toHaveStyle({
      color: "#F2A900",
    });
  });
});
