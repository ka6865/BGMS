// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStatsAdPlacements, statsAdPlacements, type AdViewportClass } from "@/lib/ads/statsAdPlacements";
import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import type { StatsMatchFilter, StatsMatchModeMeta } from "@/types/stats-page";
import summaryReady from "./fixtures/stats/matches-summary-ready.json";

vi.mock("@/components/stat/MatchCard", () => ({
  MatchCard: ({
    matchId,
    onFailure,
    onRecovery,
  }: {
    matchId: string;
    onFailure?(reason: "detail_failed"): void;
    onRecovery?(reason: "detail_failed"): void;
  }) => createElement("div", null,
    createElement("button", { type: "button", "aria-label": `${matchId} detail fail`, onClick: () => onFailure?.("detail_failed") }),
    createElement("button", { type: "button", "aria-label": `${matchId} detail recover`, onClick: () => onRecovery?.("detail_failed") }),
  ),
}));
vi.mock("@/components/ads/ResponsiveAdSlot", () => ({
  ResponsiveAdSlot: ({ viewportClass }: { viewportClass: AdViewportClass }) => viewportClass === "unknown"
    ? null
    : createElement("span", { "data-provider-child": true }),
}));

const fixturePlacements = createStatsAdPlacements({
  feedAdfitUnit: "DAN-fixture-stats-feed-728",
});

function summary(matchId: string, overrides: Partial<MatchSummaryData> = {}): MatchSummaryData {
  const base = summaryReady.summaries["match-fixture-1"];
  return { ...base, matchId, ...overrides } as MatchSummaryData;
}

async function renderFeed({
  viewportClass,
  matchCount,
  filter = "all",
  missingMatchIds = new Set<string>(),
  matchModeMeta = {},
  placements = fixturePlacements,
  summaryStatus = "ready",
  onRetrySummaries = vi.fn(),
  historyStatus = "idle",
  historyPage = 1,
  historyTotalPages = 0,
  onPageChange,
  onRetryHistory,
}: {
  viewportClass: AdViewportClass;
  matchCount: number;
  filter?: StatsMatchFilter;
  missingMatchIds?: ReadonlySet<string>;
  matchModeMeta?: Record<string, StatsMatchModeMeta>;
  placements?: typeof fixturePlacements;
  summaryStatus?: "idle" | "loading" | "ready" | "error";
  onRetrySummaries?: () => void;
  historyStatus?: "idle" | "loading" | "ready" | "error";
  historyPage?: number;
  historyTotalPages?: number;
  onPageChange?: (page: number) => void;
  onRetryHistory?: () => void;
}) {
  const { MatchFeed } = await import("@/components/stat/matches/MatchFeed");
  const matchIds = Array.from({ length: matchCount }, (_, index) => `match-${index + 1}`);
  const summaries = Object.fromEntries(matchIds.map((matchId) => [matchId, summary(matchId)]));
  const view = render(createElement(MatchFeed, {
    matchIds,
    summaries,
    missingMatchIds,
    matchModeMeta,
    summaryStatus,
    filter,
    viewportClass,
    nickname: "PlayerOne",
    platform: "steam",
    placements,
    historyStatus,
    historyPage,
    historyTotalPages,
    onPageChange,
    onRetryHistory,
    onFilterChange: vi.fn(),
    onRetrySummaries,
    onNicknameClick: vi.fn(),
    onModeDetected: vi.fn(),
  }));
  return {
    ...view,
    sequence: () => Array.from(view.container.querySelectorAll<HTMLElement>("[data-feed-sequence]"))
      .map((node) => node.dataset.feedSequence),
    adAfterCounts: () => Array.from(view.container.querySelectorAll<HTMLElement>("[data-feed-ad-after]"))
      .map((node) => Number(node.dataset.feedAdAfter)),
  };
}

describe("MatchFeed renderable order and ads", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("mobile 7개는 6번째 뒤에 한 슬롯을 두고 광고로 끝나지 않는다", async () => {
    const feed = await renderFeed({ viewportClass: "mobile", matchCount: 7 });

    expect(feed.sequence()).toEqual([
      "match-1", "match-2", "match-3", "match-4", "match-5", "match-6",
      "ad-stats-mobile-after-6", "match-7",
    ]);
  });

  it("tablet fixture registry는 16개에서 5·10·15 뒤, 5개에서는 광고 0개다", async () => {
    const full = await renderFeed({ viewportClass: "tablet", matchCount: 16 });
    expect(full.adAfterCounts()).toEqual([5, 10, 15]);
    full.unmount();

    const short = await renderFeed({ viewportClass: "tablet", matchCount: 5 });
    expect(short.adAfterCounts()).toEqual([]);
  });

  it("unknown은 viewport별 예약만 원래 match 사이에 두고 provider를 선택하지 않는다", async () => {
    const feed = await renderFeed({ viewportClass: "unknown", matchCount: 16 });

    expect(feed.adAfterCounts()).toEqual([5, 6, 10, 15]);
    expect(feed.sequence().at(-1)).toBe("match-16");
    expect(feed.container.querySelectorAll("[data-provider-child]")).toHaveLength(0);
    expect(feed.container.querySelector("[data-feed-ad-visibility='mobile-only']")).toHaveClass("stats-ad-slot--mobile-only");
    expect(feed.container.querySelector("[data-feed-ad-visibility='tablet-up']")).toHaveClass("stats-ad-slot--tablet-up");
  });

  it("feed env가 없는 registry는 after-10과 top-unit fallback을 만들지 않는다", async () => {
    const feed = await renderFeed({
      viewportClass: "tablet",
      matchCount: 16,
      placements: statsAdPlacements,
    });

    expect(feed.adAfterCounts()).toEqual([5, 15]);
    expect(feed.sequence()).not.toContain("ad-stats-after-10");
    expect(feed.sequence()).not.toContain("ad-stats-top");
  });

  it("missing을 먼저 제외하고 meta의 competitive matchType을 보존해 원래 ID 순서로 필터한다", async () => {
    const feed = await renderFeed({
      viewportClass: "mobile",
      matchCount: 4,
      filter: "ranked",
      missingMatchIds: new Set(["match-2"]),
      matchModeMeta: {
        "match-1": { gameMode: "squad-fpp", matchType: "official" },
        "match-2": { gameMode: "squad-fpp", matchType: "competitive" },
        "match-3": { gameMode: "squad-fpp", matchType: "competitive" },
        "match-4": { gameMode: "squad-fpp", matchType: "competitive" },
      },
    });

    expect(feed.sequence()).toEqual(["match-3", "match-4"]);
  });

  it("summary loading·error retry·필터별 empty를 매치 영역 안에서 표현한다", async () => {
    const loading = await renderFeed({ viewportClass: "mobile", matchCount: 2, summaryStatus: "loading" });
    expect(screen.getByRole("status", { name: "최근 매치 요약 로딩" })).toBeInTheDocument();
    expect(loading.container.querySelectorAll("[data-match-skeleton]")).toHaveLength(2);
    loading.unmount();

    const onRetrySummaries = vi.fn();
    const error = await renderFeed({
      viewportClass: "mobile",
      matchCount: 2,
      summaryStatus: "error",
      onRetrySummaries,
    });
    expect(screen.getByText("최근 매치 요약을 불러오지 못했습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "매치 요약 다시 시도" }));
    expect(onRetrySummaries).toHaveBeenCalledTimes(1);
    error.unmount();

    const empty = await renderFeed({
      viewportClass: "mobile",
      matchCount: 1,
      filter: "tdm",
      matchModeMeta: { "match-1": { gameMode: "squad-fpp", matchType: "official" } },
    });
    expect(screen.getByText("최근 14일 이내에 플레이한 팀 데스매치(TDM) 기록이 없습니다.")).toBeInTheDocument();
    empty.unmount();
  });

  it("저장 전적은 현재 페이지를 강조하고 이전·번호·다음 이동을 전달한다", async () => {
    const onPageChange = vi.fn();
    const feed = await renderFeed({
      viewportClass: "mobile",
      matchCount: 2,
      historyStatus: "ready",
      historyPage: 2,
      historyTotalPages: 3,
      onPageChange,
    });

    expect(screen.getByRole("navigation", { name: "전적 페이지 이동" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "전적 2페이지" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "이전 전적 페이지" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "다음 전적 페이지" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "전적 3페이지" }));
    fireEvent.click(screen.getByRole("button", { name: "이전 전적 페이지" }));
    expect(onPageChange.mock.calls).toEqual([[3], [1]]);
    feed.unmount();
  });

  it("페이지 수가 많으면 첫·현재 주변·마지막 페이지만 표시하고 생략부호를 둔다", async () => {
    const { getStatsHistoryPaginationItems } = await import("@/components/stat/matches/MatchFeed");
    expect(getStatsHistoryPaginationItems(10, 5)).toEqual([1, "ellipsis", 4, 5, 6, "ellipsis", 10]);
  });

  it("페이지 이동 중 상태와 현재 페이지 기준 empty 안내를 함께 보여준다", async () => {
    const feed = await renderFeed({
      viewportClass: "mobile",
      matchCount: 0,
      filter: "normal",
      historyStatus: "loading",
      historyPage: 2,
      historyTotalPages: 3,
    });

    expect(screen.getByRole("status", { name: "전적 페이지 로딩" })).toHaveTextContent("페이지 불러오는 중...");
    expect(screen.getByRole("heading", { name: /2\/3페이지/ })).toBeInTheDocument();
    expect(screen.getByText("현재 페이지에 일반전 기록이 없습니다. 다른 페이지도 확인해 보세요.")).toBeInTheDocument();
    feed.unmount();
  });

  it("행 failure/recovery를 서로 지우지 않는 match source ID로 전달한다", async () => {
    const onFailure = vi.fn();
    const onRecovery = vi.fn();
    const { MatchFeed } = await import("@/components/stat/matches/MatchFeed");
    render(createElement(MatchFeed, {
      matchIds: ["match-1", "match-2"],
      summaries: { "match-1": summary("match-1"), "match-2": summary("match-2") },
      missingMatchIds: new Set<string>(),
      matchModeMeta: {},
      summaryStatus: "ready",
      filter: "all",
      viewportClass: "mobile",
      nickname: "PlayerOne",
      platform: "steam",
      onFilterChange: vi.fn(),
      onRetrySummaries: vi.fn(),
      onNicknameClick: vi.fn(),
      onModeDetected: vi.fn(),
      onFailure,
      onRecovery,
    }));

    fireEvent.click(screen.getByRole("button", { name: "match-1 detail fail" }));
    fireEvent.click(screen.getByRole("button", { name: "match-2 detail fail" }));
    fireEvent.click(screen.getByRole("button", { name: "match-1 detail recover" }));

    expect(onFailure.mock.calls).toEqual([
      ["detail_failed", "match:match-1"],
      ["detail_failed", "match:match-2"],
    ]);
    expect(onRecovery).toHaveBeenCalledWith("detail_failed", "match:match-1");
  });
});
