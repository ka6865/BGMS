// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import playerReady from "./fixtures/stats/player-ready.json";
import summaryReady from "./fixtures/stats/matches-summary-ready.json";

const storage = new Map<string, string>();
const localStorageMock: Storage = {
  get length() { return storage.size; },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => Array.from(storage.keys())[index] ?? null,
  removeItem: (key) => storage.delete(key),
  setItem: (key, value) => storage.set(key, String(value)),
};

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
    }),
  },
}));
vi.mock("@/components/stat/MatchCard", () => ({
  MatchCard: ({ matchId }: { matchId: string }) => createElement("div", { "data-testid": "live-feed-row" }, matchId),
}));
vi.mock("@/components/stat/StatSummaryPanel", () => ({ StatSummaryPanel: () => null }));
vi.mock("@/components/stat/RecentAISummary", () => ({ RecentAISummary: () => null }));
vi.mock("@/components/stat/SquadAnalysisPanel", () => ({ default: () => null }));
vi.mock("@/components/ads/AdSenseBanner", () => ({ default: () => null }));
vi.mock("@/components/ads/AdfitBanner", () => ({ default: () => null }));

import StatSearch from "@/components/stat/StatSearch";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("StatSearch MatchFeed live binding", () => {
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", localStorageMock);
    const baseSummary = summaryReady.summaries["match-fixture-1"];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/pubg/player?")) {
        return Promise.resolve(jsonResponse({
          ...playerReady,
          recentMatches: ["ranked-by-type", "normal-match"],
        }));
      }
      if (url === "/api/pubg/matches-summary") {
        return Promise.resolve(jsonResponse({
          summaries: {
            "ranked-by-type": {
              ...baseSummary,
              matchId: "ranked-by-type",
              gameMode: "squad-fpp",
              matchType: "competitive",
            },
            "normal-match": {
              ...baseSummary,
              matchId: "normal-match",
              gameMode: "squad-fpp",
              matchType: "official",
            },
          },
          missingMatchIds: [],
        }));
      }
      return Promise.resolve(jsonResponse({ suggestions: [] }));
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("live MatchFeed가 matchType competitive를 보존하고 stats-page 광고 CSS scope 안에 렌더된다", async () => {
    const view = render(createElement(StatSearch, {
      initialPlatform: "steam",
      initialNickname: "FixturePlayer",
    }));
    await screen.findByText("ranked-by-type");
    expect(screen.getByText("normal-match")).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("group", { name: "매치 유형 필터" })).getByRole("button", { name: "경쟁전" }));

    expect(screen.getByText("ranked-by-type")).toBeInTheDocument();
    expect(screen.queryByText("normal-match")).not.toBeInTheDocument();
    expect(view.container.firstElementChild).toHaveClass("stats-page");
  });
});
