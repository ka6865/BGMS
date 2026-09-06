// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, Fragment } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerStatsResponse, StatsBucket } from "@/types/stats-page";
import playerReadyFixture from "./fixtures/stats/player-ready.json";
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
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
  },
}));
vi.mock("@/components/stat/MatchCard", () => ({ MatchCard: () => null }));
vi.mock("@/components/stat/RecentAISummary", () => ({ RecentAISummary: () => null }));
vi.mock("@/components/stat/SquadAnalysisPanel", () => ({ default: () => null }));
vi.mock("@/components/ads/AdSenseBanner", () => ({ default: () => null }));
vi.mock("@/components/ads/AdfitBanner", () => ({ default: () => null }));

import { PlayerProfileHeader } from "@/components/stat/profile/PlayerProfileHeader";
import { StatSummaryPanel } from "@/components/stat/StatSummaryPanel";
import StatSearch from "@/components/stat/StatSearch";

function bucket(overrides: Partial<StatsBucket>): StatsBucket {
  return {
    roundsPlayed: 10,
    kills: 10,
    assists: 2,
    deaths: 5,
    wins: 1,
    top10Ratio: 0.4,
    damageDealt: 2000,
    dBNOs: 4,
    timeSurvived: 10000,
    headshotKills: 4,
    ...overrides,
  };
}

const player: PlayerStatsResponse = {
  nickname: "FixtureNickname",
  platform: "kakao",
  seasonId: "season-2",
  seasons: [
    { id: "season-2", name: "Season 2" },
    { id: "season-1", name: "Season 1" },
  ],
  stats: {
    ranked: {
      squad: bucket({
        currentTier: { tier: "Gold", subTier: 3 },
        currentRankPoint: 2450,
        bestTier: { tier: "Platinum", subTier: 4 },
        bestRankPoint: 2780,
        avgRank: 6.25,
      }),
      duo: bucket({ currentTier: { tier: "Master", subTier: 1 }, currentRankPoint: 4000 }),
      solo: bucket({ currentTier: { tier: "Diamond", subTier: 2 }, currentRankPoint: 3200 }),
    },
    normal: {
      squad: bucket({
        roundsPlayed: 8,
        kills: 12,
        assists: 5,
        wins: 1,
        top10Ratio: 0.5,
        damageDealt: 1600,
        dBNOs: 6,
        timeSurvived: 7200,
        headshotKills: 2,
      }),
    },
  },
  recentMatches: [],
  clan: { id: "clan-1", name: "Fixture Clan", tag: "FC", level: 7, memberCount: 42 },
  survivalMastery: { xp: 1317, tier: 3, level: 441, totalMatchesPlayed: 782 },
  banType: "None",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

function panelProps() {
  return {
    stats: player.stats,
    mode: "ranked" as const,
    partySize: "squad" as const,
    aiSummary: null,
    aiExpanded: false,
    onModeChange: vi.fn(),
    onPartySizeChange: vi.fn(),
    onAiToggle: vi.fn(),
  };
}

describe("PlayerProfileHeader", () => {
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

  it("squad→duo→solo canonical 랭크를 프로필에만 한 번 노출하고 긴 닉네임을 보존한다", () => {
    render(createElement(Fragment, null,
      createElement(PlayerProfileHeader, {
        player,
        seasonId: player.seasonId,
        refreshing: false,
        isRefreshCoolingDown: false,
        favorite: false,
        onSeasonChange: vi.fn(),
        onRefresh: vi.fn(),
        onFavoriteToggle: vi.fn(),
        onCompare: vi.fn(),
        onWeapons: vi.fn(),
      }),
      createElement(StatSummaryPanel, panelProps()),
    ));

    expect(screen.getAllByText("현재 랭크")).toHaveLength(1);
    expect(screen.getByText("Gold 3")).toBeInTheDocument();
    expect(screen.getByText("2450 RP")).toBeInTheDocument();
    expect(screen.getByText(/최고 Platinum 4/)).toHaveTextContent("2780 RP");
    expect(screen.getByRole("img", { name: "Gold 3 티어 아이콘" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "현재 시즌 경쟁전 스쿼드 요약" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Season 2" })).toBeInTheDocument();
    expect(screen.getByText("생존 티어 3").parentElement).toHaveTextContent("Lv.441");
    expect(screen.getByRole("tooltip")).toHaveTextContent("누적 XP 1,317");
    expect(screen.getByText("승률").parentElement?.parentElement).toHaveTextContent("10.0%");
    expect(screen.getByText("Top 10률").parentElement?.parentElement).toHaveTextContent("40.0%");
    expect(screen.getByText("평균 생존").parentElement?.parentElement).toHaveTextContent("16:40");
    expect(screen.queryByText(/Master/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Diamond/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "FixtureNickname" })).toHaveAttribute("title", "FixtureNickname");
    expect(screen.getByRole("heading", { name: "FixtureNickname" })).toHaveClass("min-w-0", "truncate");
  });

  it("시즌·갱신·즐겨찾기·비교·무기 action을 접근 가능한 44px controlled target으로 제공한다", () => {
    const callbacks = {
      onSeasonChange: vi.fn(),
      onRefresh: vi.fn(),
      onFavoriteToggle: vi.fn(),
      onCompare: vi.fn(),
      onWeapons: vi.fn(),
    };
    render(createElement(PlayerProfileHeader, {
      player,
      seasonId: player.seasonId,
      refreshing: false,
      isRefreshCoolingDown: false,
      favorite: true,
      ...callbacks,
    }));

    const season = screen.getByRole("combobox", { name: "시즌 선택" });
    fireEvent.change(season, { target: { value: "season-1" } });
    fireEvent.click(screen.getByRole("button", { name: "전적 갱신" }));
    fireEvent.click(screen.getByRole("button", { name: "즐겨찾기 해제" }));
    fireEvent.click(screen.getByRole("button", { name: "전적 비교" }));
    fireEvent.click(screen.getByRole("button", { name: "무기 분석" }));

    expect(callbacks.onSeasonChange).toHaveBeenCalledWith("season-1");
    expect(callbacks.onRefresh).toHaveBeenCalledTimes(1);
    expect(callbacks.onFavoriteToggle).toHaveBeenCalledTimes(1);
    expect(callbacks.onCompare).toHaveBeenCalledTimes(1);
    expect(callbacks.onWeapons).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "즐겨찾기 해제" })).toHaveAttribute("aria-pressed", "true");
    const actions = [
      screen.getByRole("button", { name: "전적 갱신" }),
      screen.getByRole("button", { name: "즐겨찾기 해제" }),
      screen.getByRole("button", { name: "전적 비교" }),
      screen.getByRole("button", { name: "무기 분석" }),
    ];
    for (const control of [season, ...actions]) expect(control).toHaveClass("min-h-11");
    for (const action of actions) expect(action).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: "클랜 FC 정보" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "제재 상태 확인" })).toHaveAttribute("aria-expanded", "false");
  });

  it("Innocent 상태는 한글로 표시하고 클랜/제재 팝오버는 하나만 연다", () => {
    render(createElement(PlayerProfileHeader, {
      player: { ...player, banType: "Innocent" },
      seasonId: player.seasonId,
      refreshing: false,
      isRefreshCoolingDown: false,
      favorite: false,
      onSeasonChange: vi.fn(),
      onRefresh: vi.fn(),
      onFavoriteToggle: vi.fn(),
      onCompare: vi.fn(),
      onWeapons: vi.fn(),
    }));

    const clan = screen.getByRole("button", { name: "클랜 FC 정보" });
    const ban = screen.getByRole("button", { name: "제재 상태 확인" });
    fireEvent.click(clan);
    expect(screen.getByText("Fixture Clan")).toBeInTheDocument();
    expect(screen.queryByText("PUBG 상태: 정상")).not.toBeInTheDocument();
    expect(clan).toHaveAttribute("aria-expanded", "true");
    expect(ban).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(ban);
    expect(screen.queryByText("Fixture Clan")).not.toBeInTheDocument();
    expect(screen.getByText("PUBG 상태: 정상")).toBeInTheDocument();
    expect(clan).toHaveAttribute("aria-expanded", "false");
    expect(ban).toHaveAttribute("aria-expanded", "true");
  });

  it("스쿼드 기록이 없으면 duo, solo 순으로 canonical 랭크를 fallback한다", () => {
    const fallbackPlayer: PlayerStatsResponse = {
      ...player,
      stats: {
        ...player.stats,
        ranked: {
          ...player.stats.ranked,
          squad: bucket({ roundsPlayed: 0, currentTier: { tier: "Gold", subTier: 3 } }),
        },
      },
    };
    render(createElement(PlayerProfileHeader, {
      player: fallbackPlayer,
      seasonId: fallbackPlayer.seasonId,
      refreshing: false,
      isRefreshCoolingDown: false,
      favorite: false,
      onSeasonChange: vi.fn(),
      onRefresh: vi.fn(),
      onFavoriteToggle: vi.fn(),
      onCompare: vi.fn(),
      onWeapons: vi.fn(),
    }));

    expect(screen.getByText("Master 1")).toBeInTheDocument();
    expect(screen.getByText("4000 RP")).toBeInTheDocument();
  });

  it("모든 경쟁전 기록이 없으면 시즌 카드 빈 상태를 보여준다", () => {
    const emptyPlayer: PlayerStatsResponse = {
      ...player,
      stats: {
        ranked: {
          squad: bucket({ roundsPlayed: 0 }),
          duo: bucket({ roundsPlayed: 0 }),
          solo: bucket({ roundsPlayed: 0 }),
        },
        normal: {},
      },
    };
    render(createElement(PlayerProfileHeader, {
      player: emptyPlayer,
      seasonId: emptyPlayer.seasonId,
      refreshing: false,
      isRefreshCoolingDown: false,
      favorite: false,
      onSeasonChange: vi.fn(),
      onRefresh: vi.fn(),
      onFavoriteToggle: vi.fn(),
      onCompare: vi.fn(),
      onWeapons: vi.fn(),
    }));

    expect(screen.getByRole("region", { name: "현재 시즌 경쟁전 스쿼드 요약" })).toBeInTheDocument();
    expect(screen.getByText("기록 없음")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "시즌 선택" })).toBeInTheDocument();
  });

  it("모드 조회 불가는 시즌 카드에서 기록 없음이나 0 대신 명시적 안내를 보여준다", () => {
    const unavailablePlayer: PlayerStatsResponse = {
      ...player,
      statsAvailability: { ranked: { status: "unavailable" } },
    };
    render(createElement(PlayerProfileHeader, {
      player: unavailablePlayer,
      seasonId: unavailablePlayer.seasonId,
      statsMode: "ranked",
      partySize: "squad",
      refreshing: false,
      isRefreshCoolingDown: false,
      favorite: false,
      onSeasonChange: vi.fn(),
      onRefresh: vi.fn(),
      onFavoriteToggle: vi.fn(),
      onCompare: vi.fn(),
      onWeapons: vi.fn(),
    }));

    const summary = screen.getByRole("region", { name: "현재 시즌 경쟁전 스쿼드 요약" });
    expect(within(summary).getByText("조회 불가")).toBeInTheDocument();
    expect(within(summary).getByText(/현재 수치를 표시할 수 없습니다/)).toBeInTheDocument();
    expect(within(summary).queryByText("기록 없음")).not.toBeInTheDocument();
  });

  it("stale 모드 시즌 카드는 기존 값을 유지하고 마지막 갱신을 알린다", () => {
    const stalePlayer: PlayerStatsResponse = {
      ...player,
      statsAvailability: { ranked: { status: "stale", updatedAt: "2026-08-10T00:00:00.000Z" } },
    };
    render(createElement(PlayerProfileHeader, {
      player: stalePlayer,
      seasonId: stalePlayer.seasonId,
      statsMode: "ranked",
      partySize: "squad",
      refreshing: false,
      isRefreshCoolingDown: false,
      favorite: false,
      onSeasonChange: vi.fn(),
      onRefresh: vi.fn(),
      onFavoriteToggle: vi.fn(),
      onCompare: vi.fn(),
      onWeapons: vi.fn(),
    }));

    const summary = screen.getByRole("region", { name: "현재 시즌 경쟁전 스쿼드 요약" });
    expect(within(summary).getByText("Gold 3")).toBeInTheDocument();
    expect(within(summary).getByText("이전 자료로 표시 중")).toBeInTheDocument();
    expect(within(summary).getByText(/마지막 갱신/)).toBeInTheDocument();
  });

  it("상단 시즌 카드의 랭크 파티 필터를 외부 상세 통계 상태와 연결한다", () => {
    const onPartySizeChange = vi.fn();
    const onStatsModeChange = vi.fn();
    render(createElement(PlayerProfileHeader, {
      player,
      seasonId: player.seasonId,
      statsMode: "ranked",
      onStatsModeChange,
      partySize: "squad",
      onPartySizeChange,
      refreshing: false,
      isRefreshCoolingDown: false,
      favorite: false,
      onSeasonChange: vi.fn(),
      onRefresh: vi.fn(),
      onFavoriteToggle: vi.fn(),
      onCompare: vi.fn(),
      onWeapons: vi.fn(),
    }));

    const filter = screen.getByRole("group", { name: "현재 시즌 파티 필터" });
    fireEvent.click(within(filter).getByRole("button", { name: "듀오" }));
    fireEvent.click(within(screen.getByRole("group", { name: "현재 시즌 모드 필터" })).getByRole("button", { name: "일반전" }));

    expect(onPartySizeChange).toHaveBeenCalledWith("duo");
    expect(onStatsModeChange).toHaveBeenCalledWith("normal");
    expect(within(filter).getByRole("button", { name: "스쿼드" })).toHaveAttribute("aria-pressed", "true");
  });

  it("일반전에서는 랭크 블록 대신 일반전 성적을 표시한다", () => {
    render(createElement(PlayerProfileHeader, {
      player,
      seasonId: player.seasonId,
      statsMode: "normal",
      partySize: "squad",
      onStatsModeChange: vi.fn(),
      onPartySizeChange: vi.fn(),
      refreshing: false,
      isRefreshCoolingDown: false,
      favorite: false,
      onSeasonChange: vi.fn(),
      onRefresh: vi.fn(),
      onFavoriteToggle: vi.fn(),
      onCompare: vi.fn(),
      onWeapons: vi.fn(),
    }));

    const summary = screen.getByRole("region", { name: "현재 시즌 일반전 스쿼드 요약" });
    expect(within(summary).getByText("일반전 성적")).toBeInTheDocument();
    expect(within(summary).getByText("랭크 티어 미적용")).toBeInTheDocument();
    expect(within(summary).queryByText("현재 랭크")).not.toBeInTheDocument();
    expect(within(summary).queryByText("Gold 3")).not.toBeInTheDocument();
  });

  it("갱신 쿨다운이면 header refresh만 차단한다", () => {
    render(createElement(PlayerProfileHeader, {
      player,
      seasonId: player.seasonId,
      refreshing: false,
      isRefreshCoolingDown: true,
      refreshAvailableAt: Date.now() + 30_000,
      favorite: false,
      onSeasonChange: vi.fn(),
      onRefresh: vi.fn(),
      onFavoriteToggle: vi.fn(),
      onCompare: vi.fn(),
      onWeapons: vi.fn(),
    }));

    expect(screen.getByRole("button", { name: "최신 전적" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "전적 비교" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "무기 분석" })).toBeEnabled();
  });

  it("공백 닉네임과 Kakao platform을 Task 2 URL builder로 이동한다", async () => {
    const kakaoPlayer = { ...playerReadyFixture, nickname: "Fixture Player", platform: "kakao", recentMatches: [] };
    const fetchMock = vi.fn((input: RequestInfo | URL) => Promise.resolve(
      String(input).startsWith("/api/pubg/matches-summary")
        ? new Response(JSON.stringify(summaryReady), { headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify(kakaoPlayer), { headers: { "Content-Type": "application/json" } }),
    ));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(StatSearch, { initialPlatform: "kakao", initialNickname: "Fixture Player" }));
    await screen.findByRole("heading", { name: "Fixture Player" });

    fireEvent.click(screen.getByRole("button", { name: "전적 비교" }));
    fireEvent.click(screen.getByRole("button", { name: "무기 분석" }));

    expect(routerPush).toHaveBeenNthCalledWith(1, "/stats/battle?nick1=Fixture%20Player&platform1=kakao");
    expect(routerPush).toHaveBeenNthCalledWith(2, "/stats/kakao/Fixture%20Player/weapons");
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/pubg/player?"))).toHaveLength(1);
  });
});
