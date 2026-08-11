// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import matchDetailReady from "./fixtures/stats/match-detail-ready.json";
import summaryReady from "./fixtures/stats/matches-summary-ready.json";

const matchSummaryFixture = summaryReady.summaries["match-fixture-1"] as MatchSummaryData;

const { mockPush } = vi.hoisted(() => ({
  mockPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

vi.mock("@/components/common/BgmsIcon", () => ({
  BgmsIcon: () => React.createElement("span", { "aria-hidden": true }),
}));

vi.mock("@/components/stat/MatchTimeline", () => ({
  MatchTimeline: () => null,
}));

vi.mock("@/lib/ai-management", () => ({
  useAIStatus: () => ({ isAnalyzing: false }),
  aiManager: {
    startAnalysis: vi.fn(() => true),
    stopAnalysis: vi.fn(),
  },
}));

vi.mock("@/components/AuthProvider", () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/replay/mapCapabilities", () => ({
  resolve3DMapCapability: () => null,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

import { MatchCard } from "../components/stat/MatchCard";

function renderCard(
  initialMatchData: MatchSummaryData = matchSummaryFixture,
) {
  return render(React.createElement(MatchCard, {
    matchId: "match-demand-1",
    nickname: "PlayerOne",
    platform: "steam",
    isMobile: true,
    initialMatchData: { ...initialMatchData, matchId: "match-demand-1" },
  }));
}

describe("MatchCard demand loading", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("요약 compact 카드는 마운트만으로 전체 분석 API를 호출하거나 상세 selector를 만들지 않는다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCard();
    await act(async () => {
      vi.runAllTimers();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("에란겔")).toBeInTheDocument();
    expect(screen.queryByTestId("expanded-match-details")).not.toBeInTheDocument();
  });

  it("optional summary가 없는 debug consumer도 마운트 0요청 후 명시적 click 한 번으로 요청한다", () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    render(React.createElement(MatchCard, {
      matchId: "match-debug-1",
      nickname: "DebugPlayer",
      platform: "steam",
      isMobile: true,
    }));

    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "매치 상세 불러오기" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("matchId=match-debug-1");
  });

  it("사용자가 매치 상세을 처음 펼쳐야 전체 분석을 한 번 요청한다", () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/pubg/match?");
  });

  it("첫 성공 뒤 접어도 상세를 mounted+hidden으로 보존하고 다시 열 때 재요청하지 않는다", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      ...matchDetailReady,
      matchId: "match-demand-1",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
    await screen.findByTestId("expanded-match-details");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "매치 상세 접기" }));
    expect(screen.getByTestId("expanded-match-details")).not.toBeVisible();
    expect(screen.getByText("헤드샷")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
    expect(screen.getByTestId("expanded-match-details")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("14일 초과 summary는 성공한 보존 상태로 펼치며 detail 요청·오류·retry가 없다", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderCard({
      ...matchSummaryFixture,
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/과거 전적/)).toBeInTheDocument();
    expect(screen.queryByText("상세 정보를 불러오지 못했습니다")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "상세 다시 시도" })).not.toBeInTheDocument();
  });
});
