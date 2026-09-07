// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: null, error: null }) }),
      }),
    }),
  },
}));
vi.mock("@/components/stat/MatchCard", () => ({ MatchCard: () => null }));
vi.mock("@/components/stat/RecentAISummary", () => ({
  RecentAISummary: ({
    nickname,
    onSummaryChange,
  }: {
    nickname: string;
    onSummaryChange?(summary: { verdict: string; tier: string } | null): void;
  }) => createElement("button", {
    type: "button",
    onClick: () => onSummaryChange?.({ verdict: `${nickname} verdict`, tier: "A" }),
  }, `${nickname} AI 완료`),
}));
vi.mock("@/components/stat/SquadAnalysisPanel", () => ({ default: () => null }));
vi.mock("@/components/ads/AdSenseBanner", () => ({ default: () => null }));
vi.mock("@/components/ads/AdfitBanner", () => ({ default: () => null }));

import StatSearch from "@/components/stat/StatSearch";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("StatSearch recent summary identity ownership", () => {
  beforeEach(() => {
    storage.clear();
    routerPush.mockReset();
    vi.stubGlobal("localStorage", localStorageMock);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("A의 최근 경기와 AI 문장을 B 빈 매치 route에 노출하지 않는다", async () => {
    const playerA = { ...playerReady, nickname: "PlayerA", recentMatches: ["match-fixture-1"] };
    const playerB = { ...playerReady, nickname: "PlayerB", recentMatches: [] };
    let resolvePlayerB!: (response: Response) => void;
    const playerBResponse = new Promise<Response>((resolve) => {
      resolvePlayerB = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/pubg/player?") && url.includes("nickname=PlayerA")) {
        return Promise.resolve(jsonResponse(playerA));
      }
      if (url.startsWith("/api/pubg/player?") && url.includes("nickname=PlayerB")) {
        return playerBResponse;
      }
      if (url.startsWith("/api/pubg/player/matches?")) {
        return Promise.resolve(jsonResponse({ matches: [], page: 1, totalPages: 0 }));
      }
      if (url.startsWith("/api/pubg/matches-summary")) {
        return Promise.resolve(jsonResponse(summaryReady));
      }
      if (url.startsWith("/api/pubg/suggest")) {
        return Promise.resolve(jsonResponse({ suggestions: [] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(createElement(StatSearch, {
      initialPlatform: "steam",
      initialNickname: "PlayerA",
    }));
    await screen.findByRole("heading", { name: "PlayerA" });
    fireEvent.click(await screen.findByRole("button", { name: "PlayerA AI 완료" }));
    expect(screen.queryByText("PlayerA verdict")).not.toBeInTheDocument();
    const recentSummary = within(screen.getByRole("region", { name: "최근 20경기 요약" }));
    expect(await recentSummary.findByTestId("kills")).toHaveTextContent("4");
    expect(screen.queryByRole("button", { name: "AI 요약 더보기" })).not.toBeInTheDocument();

    view.rerender(createElement(StatSearch, {
      initialPlatform: "steam",
      initialNickname: "PlayerB",
    }));
    expect(screen.queryByText("PlayerA verdict")).not.toBeInTheDocument();

    resolvePlayerB(jsonResponse(playerB));
    await screen.findByRole("heading", { name: "PlayerB" });
    const emptySummary = within(screen.getByRole("region", { name: "최근 20경기 요약" }));
    expect(emptySummary.queryByTestId("kills")).not.toBeInTheDocument();
    expect(emptySummary.getByText("최근 경기 기록이 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("PlayerA verdict")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "AI 요약 접기" })).not.toBeInTheDocument();
    screen.getByRole("region", { name: "AI 분석" });
    expect(screen.getByRole("status", { name: "AI 분석할 최근 매치 없음" })).toHaveTextContent(
      "최근 매치 기록이 없어 AI 분석을 시작할 수 없습니다.",
    );

    expect(screen.queryByRole("button", { name: "최근 10경기 AI 분석으로 이동" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/ai/"))).toHaveLength(0);
  });
});
