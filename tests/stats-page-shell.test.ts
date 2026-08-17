// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsPageController } from "@/hooks/useStatsPageController";
import playerReady from "./fixtures/stats/player-ready.json";

const mocks = vi.hoisted(() => ({
  controller: null as unknown as StatsPageController,
  routerPush: vi.fn(),
  addRecent: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.routerPush }) }));
vi.mock("@/hooks/useStatsPageController", () => ({ useStatsPageController: () => mocks.controller }));
vi.mock("@/hooks/useStatsSearchHistory", () => ({
  useStatsSearchHistory: () => ({
    recentSearches: [],
    favorites: [],
    addRecent: mocks.addRecent,
    toggleFavorite: vi.fn(),
    removeRecent: vi.fn(),
  }),
}));
vi.mock("@/hooks/useStatsAutocomplete", () => ({
  useStatsAutocomplete: () => ({ suggestions: [], suggesting: false, empty: false }),
}));
vi.mock("@/hooks/useStatsProfilePrefill", () => ({
  useStatsProfilePrefill: () => ({ loaded: true, nickname: null, platform: null }),
}));
vi.mock("@/hooks/useAdViewportClass", () => ({ useAdViewportClass: () => "unknown" }));
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/components/stat/profile/PlayerProfileHeader", () => ({
  PlayerProfileHeader: ({
    onSeasonChange,
    onRefresh,
  }: {
    onSeasonChange(value: string): void;
    onRefresh(): void;
  }) => createElement("div", { "data-testid": "profile-header" },
    createElement("button", { type: "button", onClick: () => onSeasonChange("season-next") }, "season-next"),
    createElement("button", { type: "button", onClick: onRefresh }, "refresh-player"),
  ),
}));
vi.mock("@/components/stat/StatSummaryPanel", () => ({
  StatSummaryPanel: ({
    aiSummary,
    onModeChange,
    onPartySizeChange,
  }: {
    aiSummary?: { verdict: string } | null;
    onModeChange(value: "ranked" | "normal"): void;
    onPartySizeChange(value: "solo" | "duo" | "squad"): void;
  }) =>
    createElement("aside", { "data-testid": "summary-panel" },
      aiSummary?.verdict ?? "summary-empty",
      createElement("button", { type: "button", onClick: () => onModeChange("normal") }, "일반전 통계"),
      createElement("button", { type: "button", onClick: () => onPartySizeChange("solo") }, "솔로 통계"),
    ),
}));
vi.mock("@/components/stat/matches/MatchFeed", () => ({
  MatchFeed: ({ summaryStatus, filter, onRetrySummaries }: { summaryStatus: string; filter: string; onRetrySummaries(): void }) =>
    createElement("div", { "data-testid": "match-feed" },
      `feed-${summaryStatus}-filter-${filter}`,
      summaryStatus === "error"
        ? createElement("button", { type: "button", onClick: onRetrySummaries }, "요약 다시 시도")
        : null,
    ),
}));
vi.mock("@/components/stat/RecentAISummary", () => ({
  RecentAISummary: ({ onSummaryChange }: { onSummaryChange(value: { verdict: string; tier: string }): void }) =>
    createElement("div", { "data-testid": "full-ai" },
      createElement("button", {
        type: "button",
        onClick: () => onSummaryChange({ verdict: "fixture verdict", tier: "A" }),
      }, "full-ai-action"),
    ),
}));
vi.mock("@/components/stat/SquadAnalysisPanel", () => ({ default: () => createElement("div", null, "squad-panel") }));

import { StatsPageShell } from "@/components/stat/layout/StatsPageShell";

function controller(overrides: Partial<StatsPageController> = {}): StatsPageController {
  return {
    status: "idle",
    result: null,
    error: null,
    suggestedPlayers: [],
    refreshAvailableAt: undefined,
    isRefreshCoolingDown: false,
    partialReasons: [],
    platform: "steam",
    nickname: "",
    seasonId: "",
    sectionTab: "overview",
    groupKey: undefined,
    statsMode: "ranked",
    partySize: "squad",
    matchFilter: "all",
    matchSummaries: {},
    missingMatchIds: new Set(),
    matchModeMeta: {},
    summaryStatus: "idle",
    matchIds: [],
    historyStatus: "idle",
    hasMoreHistory: false,
    setPlatform: vi.fn(),
    setNickname: vi.fn(),
    setSeasonId: vi.fn(),
    setSectionTab: vi.fn(),
    setGroupKey: vi.fn(),
    setStatsMode: vi.fn(),
    setPartySize: vi.fn(),
    setMatchFilter: vi.fn(),
    search: vi.fn().mockResolvedValue(null),
    refresh: vi.fn().mockResolvedValue(undefined),
    retrySummaries: vi.fn().mockResolvedValue(undefined),
    loadMoreHistory: vi.fn().mockResolvedValue(undefined),
    onModeDetected: vi.fn(),
    reportPartial: vi.fn(),
    clearPartial: vi.fn(),
    ...overrides,
  };
}

function readyResult(recentMatches: readonly string[] = ["match-fixture-1"]) {
  return { ...playerReady, recentMatches } as StatsPageController["result"];
}

function precedes(first: Element, second: Element) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("StatsPageShell state and ownership matrix", () => {
  beforeEach(() => {
    mocks.controller = controller();
    mocks.routerPush.mockReset();
    mocks.addRecent.mockReset();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.restoreAllMocks();
  });

  it("idle landing은 search → landing → top ad 순서이고 dynamic route boot은 landing/ad flash가 없다", () => {
    mocks.controller = controller({ nickname: "FixturePlayer" });
    const landing = render(createElement(StatsPageShell));
    const search = screen.getByPlaceholderText("정확한 대소문자 닉네임을 입력하세요");
    const landingState = screen.getByText("내 PUBG 전적을 빠르게 확인하세요").closest("section")!;
    const topAd = landing.container.querySelector('[data-ad-placement="stats-top"]')!;
    expect(precedes(search, landingState)).toBe(true);
    expect(precedes(landingState, topAd)).toBe(true);
    expect(landing.container.querySelectorAll('[data-ad-placement="stats-top"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "검색" }));
    expect(mocks.routerPush).toHaveBeenCalledWith("/stats/steam/FixturePlayer");
    expect(screen.getByRole("status")).toHaveTextContent("전적을 불러오는 중");
    landing.unmount();

    const boot = render(createElement(StatsPageShell, { initialNickname: "FixturePlayer" }));
    expect(screen.queryByText("내 PUBG 전적을 빠르게 확인하세요")).not.toBeInTheDocument();
    expect(boot.container.querySelector('[data-ad-placement="stats-top"]')).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("전적을 불러오는 중");
  });

  it("loading no-result는 status만, ready result는 profile → top ad → tabs → overview grid를 렌더한다", () => {
    mocks.controller = controller({ status: "loading" });
    const view = render(createElement(StatsPageShell));
    expect(screen.getByRole("status")).toHaveTextContent("플레이어 전적을 불러오는 중");
    expect(screen.queryByTestId("profile-header")).not.toBeInTheDocument();
    expect(view.container.querySelector('[data-ad-placement="stats-top"]')).not.toBeInTheDocument();

    mocks.controller = controller({ status: "ready", result: readyResult(), summaryStatus: "ready" });
    view.rerender(createElement(StatsPageShell));
    const profile = screen.getByTestId("profile-header");
    const topAd = view.container.querySelector('[data-ad-placement="stats-top"]')!;
    const tabs = screen.getByRole("group", { name: "전적 분석 섹션" });
    const grid = view.container.querySelector(".stats-result-grid")!;
    expect(precedes(profile, topAd)).toBe(true);
    expect(precedes(topAd, tabs)).toBe(true);
    expect(precedes(tabs, grid)).toBe(true);
  });

  it("mobile result/overview outer stack은 8px, md 이상은 16px이고 guide에 중복 margin이 없다", () => {
    mocks.controller = controller({ status: "ready", result: readyResult(), summaryStatus: "ready" });
    const view = render(createElement(StatsPageShell));
    const profile = screen.getByTestId("profile-header");
    const topAd = view.container.querySelector('[data-ad-placement="stats-top"]')!;
    const tabs = screen.getByRole("group", { name: "전적 분석 섹션" });
    const grid = view.container.querySelector(".stats-result-grid")!;
    const guide = screen.getByRole("button", { name: /BGMS AI 전술 분석 가이드/ });
    const fullAi = screen.getByTestId("full-ai");

    expect(profile.parentElement).toHaveClass("gap-2", "md:gap-4");
    expect(grid.parentElement).toHaveClass("gap-2", "md:gap-4");
    expect(guide.parentElement).not.toHaveClass("mt-4");
    expect(guide.parentElement).not.toHaveClass("mb-6");
    expect(precedes(profile, topAd)).toBe(true);
    expect(precedes(topAd, tabs)).toBe(true);
    expect(precedes(tabs, grid)).toBe(true);
    expect(precedes(fullAi, grid)).toBe(true);
    expect(precedes(grid, guide)).toBe(true);
  });

  it("stats mode/party 조작은 독립 match filter value/setter를 변경하지 않는다", () => {
    const setStatsMode = vi.fn();
    const setPartySize = vi.fn();
    const setMatchFilter = vi.fn();
    mocks.controller = controller({
      status: "ready",
      result: readyResult(),
      summaryStatus: "ready",
      matchFilter: "tdm",
      setStatsMode,
      setPartySize,
      setMatchFilter,
    });
    render(createElement(StatsPageShell));

    expect(screen.getByTestId("match-feed")).toHaveTextContent("filter-tdm");
    fireEvent.click(screen.getByRole("button", { name: "일반전 통계" }));
    fireEvent.click(screen.getByRole("button", { name: "솔로 통계" }));

    expect(setStatsMode).toHaveBeenCalledWith("normal");
    expect(setPartySize).toHaveBeenCalledWith("solo");
    expect(setMatchFilter).not.toHaveBeenCalled();
    expect(screen.getByTestId("match-feed")).toHaveTextContent("filter-tdm");
  });

  it("refreshing/partial/error + result는 현재 result와 top ad를 유지하고 partial summary retry를 feed에 남긴다", () => {
    mocks.controller = controller({ status: "refreshing", result: readyResult(), summaryStatus: "ready" });
    const view = render(createElement(StatsPageShell));
    expect(screen.getByTestId("profile-header")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("전적을 새로고침하는 중");
    expect(view.container.querySelectorAll('[data-ad-placement="stats-top"]')).toHaveLength(1);

    mocks.controller = controller({
      status: "partial",
      result: readyResult(),
      summaryStatus: "error",
      partialReasons: ["summary_batch_failed"],
    });
    view.rerender(createElement(StatsPageShell));
    expect(screen.getByTestId("profile-header")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "요약 다시 시도" }));
    expect(mocks.controller.retrySummaries).toHaveBeenCalledTimes(1);

    mocks.controller = controller({
      status: "error",
      result: readyResult(),
      error: { type: "server", message: "refresh failed" },
      sectionTab: "squad",
    });
    view.rerender(createElement(StatsPageShell));
    expect(screen.getByText("refresh failed")).toBeInTheDocument();
    expect(screen.getByTestId("profile-header")).toBeInTheDocument();
    expect(screen.getByText("squad-panel")).toBeInTheDocument();
    expect(view.container.querySelectorAll('[data-ad-placement="stats-top"]')).toHaveLength(1);
  });

  it("error no-result는 suggestion object의 platform으로 이동하고 result/landing/top ad를 렌더하지 않는다", () => {
    mocks.controller = controller({
      status: "error",
      error: { type: "not_found", message: "missing" },
      suggestedPlayers: [{ nickname: "KakaoPlayer", platform: "kakao" }],
    });
    const view = render(createElement(StatsPageShell));
    fireEvent.click(screen.getByRole("button", { name: "KakaoPlayer 카카오로 검색" }));
    expect(mocks.routerPush).toHaveBeenCalledWith("/stats/kakao/KakaoPlayer");
    expect(screen.queryByTestId("profile-header")).not.toBeInTheDocument();
    expect(screen.queryByText("내 PUBG 전적을 빠르게 확인하세요")).not.toBeInTheDocument();
    expect(view.container.querySelector('[data-ad-placement="stats-top"]')).not.toBeInTheDocument();
  });

  it("overview는 최근 10경기 AI → summary+feed grid → guide 순서이고 AI owner/snapshot은 하나다", () => {
    mocks.controller = controller({ status: "ready", result: readyResult(), summaryStatus: "ready" });
    const view = render(createElement(StatsPageShell));
    const grid = view.container.querySelector(".stats-result-grid")!;
    const guide = screen.getByRole("button", { name: /BGMS AI 전술 분석 가이드/ });
    const fullAi = screen.getByTestId("full-ai");
    expect(precedes(fullAi, grid)).toBe(true);
    expect(precedes(grid, guide)).toBe(true);
    expect(screen.getAllByTestId("full-ai")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "full-ai-action" }));
    expect(screen.getByTestId("summary-panel")).toHaveTextContent("fixture verdict");
    expect(screen.queryByRole("button", { name: "최근 10경기 AI 분석으로 이동" })).not.toBeInTheDocument();
  });

  it("zero recent match에서는 full AI를 mount하지 않고 빈 상태만 표시한다", () => {
    mocks.controller = controller({ status: "ready", result: readyResult([]), summaryStatus: "ready" });
    render(createElement(StatsPageShell));
    const region = screen.getByRole("region", { name: "AI 분석" });
    expect(region).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("status", { name: "AI 분석할 최근 매치 없음" })).toBeInTheDocument();
    expect(screen.queryByTestId("full-ai")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "최근 10경기 AI 분석으로 이동" })).not.toBeInTheDocument();
  });

  it("실패한 season/refresh exact intent는 3초 cooldown 전 0건, 후 1건 동일 request로 retry한다", async () => {
    vi.useFakeTimers();
    const search = vi.fn().mockResolvedValue(null);
    mocks.controller = controller({ status: "ready", result: readyResult(), seasonId: "season-current", search });
    const view = render(createElement(StatsPageShell));

    fireEvent.click(screen.getByRole("button", { name: "season-next" }));
    await act(async () => Promise.resolve());
    expect(search).toHaveBeenLastCalledWith({
      nickname: "FixturePlayer",
      platform: "steam",
      seasonId: "season-next",
      forceRefresh: false,
    });

    mocks.controller = controller({
      status: "error",
      result: readyResult(),
      seasonId: "season-current",
      error: { type: "server", message: "season failed" },
      search,
    });
    view.rerender(createElement(StatsPageShell));
    const retry = screen.getByRole("button", { name: "다시 시도" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(search).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await act(async () => Promise.resolve());
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenLastCalledWith({
      nickname: "FixturePlayer",
      platform: "steam",
      seasonId: "season-next",
      forceRefresh: false,
    });
  });

  it("429 retryAt 전은 retry button이 owned timer로 비활성이고 정확한 시각에 활성된다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const search = vi.fn().mockResolvedValue(null);
    mocks.controller = controller({
      status: "error",
      error: { type: "rate_limit", message: "slow", retryAt: Date.now() + 5_000 },
      search,
    });
    render(createElement(StatsPageShell, { initialNickname: "FixturePlayer", initialPlatform: "steam" }));
    const retry = screen.getByRole("button", { name: "다시 시도" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(search).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(4_999));
    expect(retry).toBeDisabled();
    act(() => vi.advanceTimersByTime(1));
    expect(retry).toBeEnabled();
  });
});
