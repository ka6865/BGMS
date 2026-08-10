// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StatSearch from "@/components/stat/StatSearch";
import StatsPage from "@/app/stats/page";
import PlayerStatsPage from "@/app/stats/[platform]/[nickname]/page";
import SidebarFooterWrapper from "@/components/layout/SidebarFooterWrapper";
import playerReady from "./fixtures/stats/player-ready.json";
import summaryReady from "./fixtures/stats/matches-summary-ready.json";

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));
const storage = new Map<string, string>();
const localStorageMock: Storage = {
  get length() { return storage.size; },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => Array.from(storage.keys())[index] ?? null,
  removeItem: (key) => storage.delete(key),
  setItem: (key, value) => storage.set(key, String(value)),
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/stats",
  useRouter: () => ({ push: routerPush }),
  redirect: vi.fn(),
}));
vi.mock("@/components/common/Footer", () => ({ default: () => createElement("footer", null, "footer") }));
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
  },
}));
vi.mock("@/hooks/useAdViewportClass", () => ({ useAdViewportClass: () => "unknown" }));
vi.mock("@/components/stat/MatchCard", () => ({ MatchCard: () => null }));
vi.mock("@/components/stat/SquadAnalysisPanel", () => ({ default: () => null }));

describe("stats route layout boundary", () => {
  beforeEach(() => {
    storage.clear();
    routerPush.mockReset();
    vi.stubGlobal("localStorage", localStorageMock);
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("landing/dynamic route는 별도 max-width wrapper 없이 StatSearch를 직접 반환한다", async () => {
    const landing = StatsPage();
    expect(landing.type).toBe(StatSearch);

    const dynamic = await PlayerStatsPage({
      params: Promise.resolve({ platform: "steam", nickname: "Fixture%20Player" }),
      searchParams: Promise.resolve({ tab: "squad", groupKey: "g2" }),
    });
    expect(dynamic.type).toBe(StatSearch);
    expect(dynamic.props).toMatchObject({
      initialPlatform: "steam",
      initialNickname: "Fixture Player",
      initialTab: "squad",
      initialGroupKey: "g2",
    });
  });

  it("real SidebarFooterWrapper가 유일한 main이고 shell root가 approved auto-ad boundary다", () => {
    const view = render(createElement(
      SidebarFooterWrapper,
      null,
      createElement(StatSearch),
    ));

    expect(view.container.querySelectorAll("main")).toHaveLength(1);
    const boundary = screen.getByTestId("stats-auto-ads-boundary");
    expect(["SECTION", "DIV"]).toContain(boundary.tagName);
    expect(boundary).toHaveClass("stats-page", "stats-auto-ads-excluded", "pb-safe-nav");
    expect(boundary).toHaveAttribute("google-side-rail-overlap", "false");
    expect(boundary.querySelector("main")).not.toBeInTheDocument();
    expect(boundary.querySelectorAll('[data-ad-placement="stats-top"]')).toHaveLength(1);
  });

  it("dynamic route도 real landmark 안에서 player 1건·top 1건·full AI owner 1개만 소유한다", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/pubg/player?")) return Promise.resolve(jsonResponse(playerReady));
      if (url === "/api/pubg/matches-summary") return Promise.resolve(jsonResponse(summaryReady));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(createElement(
      SidebarFooterWrapper,
      null,
      createElement(StatSearch, {
        initialPlatform: "steam",
        initialNickname: "FixturePlayer",
      }),
    ));

    expect(await screen.findByRole("heading", { name: "FixturePlayer" })).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/pubg/player?"))).toHaveLength(1);
    });
    expect(view.container.querySelectorAll("main")).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-ad-placement="stats-top"]')).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /로그인 후 AI 전술 분석을 이용할 수 있습니다/ })).toHaveLength(1);
  });

  it("stats visual contract는 route-scoped exact token/grid/safe-area declarations만 가진다", () => {
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

    expect(css).toMatch(/\.stats-page\s*\{[^}]*--stats-bg:\s*#0d0d0d/i);
    expect(css).toMatch(/\.stats-page\s*\{[^}]*--stats-card:\s*#161616/i);
    expect(css).toMatch(/\.stats-page\s*\{[^}]*--stats-emphasis:\s*#1f1f1f/i);
    expect(css).toMatch(/\.stats-page\s*\{[^}]*--stats-accent:\s*#F2A900/i);
    expect(css).toMatch(/\.stats-page\s*\{[^}]*--stats-border:\s*rgba\(255,\s*255,\s*255,\s*0\.08\)/i);
    expect(css).toMatch(/\.stats-page\s*\{[^}]*--stats-text-primary:\s*rgba\(255,\s*255,\s*255,\s*1\)/i);
    expect(css).toMatch(/\.stats-page\s*\{[^}]*--stats-text-secondary:\s*rgba\(255,\s*255,\s*255,\s*0\.6\)/i);
    expect(css).toMatch(/\.stats-page\s*\{[^}]*--stats-text-disabled:\s*rgba\(255,\s*255,\s*255,\s*0\.3\)/i);
    expect(css).toMatch(/\.stats-page\s*\{[^}]*--stats-good:\s*#2dd4bf/i);
    expect(css).toMatch(/\.stats-page\s*\{[^}]*--stats-error:\s*#ef6b6b/i);
    expect(css).toMatch(/\.stats-page\s*\{[^}]*max-width:\s*1200px/i);
    expect(css).toMatch(/\.stats-result-grid\s*\{[^}]*gap:\s*8px/i);
    expect(css).toMatch(/@media\s*\(min-width:\s*768px\)[\s\S]*\.stats-result-grid\s*\{[^}]*gap:\s*16px/i);
    expect(css).toMatch(/@media\s*\(min-width:\s*1024px\)[\s\S]*\.stats-result-grid\s*\{[^}]*grid-template-columns:\s*320px\s+minmax\(0,\s*1fr\)/i);
    expect(css).toMatch(/\.stats-overview-rail\s*,\s*\.stats-match-column\s*\{[^}]*min-width:\s*0/i);
    expect(css).toMatch(/\.stats-page\.pb-safe-nav\s*\{[^}]*padding-bottom:\s*calc\(56px\s*\+\s*env\(safe-area-inset-bottom\)\)/i);
    expect(css).not.toMatch(/\.stats-page\s+button\s*\{/);
    expect(css).not.toMatch(/\.stats-overview-rail\s*\{[^}]*position:\s*sticky/i);
  });
});
