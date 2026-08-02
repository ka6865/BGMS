// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function renderCard() {
  return render(React.createElement(MatchCard, {
    matchId: "match-demand-1",
    nickname: "PlayerOne",
    platform: "steam",
    isMobile: true,
  }));
}

describe("MatchCard demand loading", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("요약 데이터가 없는 카드는 마운트만으로 전체 분석 API를 호출하지 않는다", async () => {
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
  });

  it("요약 데이터가 없을 때 사용자가 상세 불러오기를 눌러야 전체 분석을 요청한다", () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "매치 상세 불러오기" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/pubg/match?");
  });
});
