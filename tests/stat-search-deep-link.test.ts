// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StatSearch from "@/components/stat/StatSearch";
import PlayerStatsPage from "@/app/stats/[platform]/[nickname]/page";
import { STORAGE_KEY_FAVORITES, STORAGE_KEY_RECENT } from "@/lib/pubg-analysis/constants";
import playerReady from "./fixtures/stats/player-ready.json";
import summaryReady from "./fixtures/stats/matches-summary-ready.json";

const { authState, profileSingleMock, routerPush } = vi.hoisted(() => ({
  authState: { user: null as { id: string } | null },
  profileSingleMock: vi.fn(),
  routerPush: vi.fn(),
}));
const storage = new Map<string, string>();
const localStorageMock: Storage = {
  get length() { return storage.size; },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => Array.from(storage.keys())[index] ?? null,
  removeItem: (key) => storage.delete(key),
  setItem: (key, value) => storage.set(key, String(value)),
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
  redirect: vi.fn(),
}));
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => authState }));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ single: profileSingleMock }) }),
    }),
  },
}));
vi.mock("@/components/stat/MatchCard", () => ({
  MatchCard: ({ onNicknameClick }: { onNicknameClick?: (nickname: string) => void }) =>
    createElement("button", { type: "button", onClick: () => onNicknameClick?.("Row Player") }, "row-player-search"),
}));
vi.mock("@/components/stat/StatSummaryPanel", () => ({ StatSummaryPanel: () => null }));
vi.mock("@/components/stat/RecentAISummary", () => ({ RecentAISummary: () => null }));
vi.mock("@/components/stat/SquadAnalysisPanel", () => ({
  default: ({
    groupKey,
    onGroupKeyChange,
  }: {
    groupKey?: string;
    onGroupKeyChange?: (value: string) => void;
  }) => createElement("div", { "data-testid": "controlled-squad-panel" },
    createElement("span", null, `squad-group-${groupKey ?? "none"}`),
    createElement("button", {
      type: "button",
      onClick: () => onGroupKeyChange?.("g1"),
    }, "squad-select-g1"),
  ),
}));
vi.mock("@/components/ads/AdSenseBanner", () => ({ default: () => null }));
vi.mock("@/components/ads/AdfitBanner", () => ({ default: () => null }));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("stats route-first/deep-link", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storage.clear();
    authState.user = null;
    profileSingleMock.mockReset();
    profileSingleMock.mockResolvedValue({ data: null, error: null });
    routerPush.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", localStorageMock);
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.history.replaceState(null, "", "/stats");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const playerRequests = () => fetchMock.mock.calls.filter(([input]) =>
    String(input).startsWith("/api/pubg/player?"),
  );

  it("동적 page가 tab/groupKey query를 StatSearch 초기 props로 전달한다", async () => {
    const page = await PlayerStatsPage({
      params: Promise.resolve({ platform: "steam", nickname: "Fixture%20Player" }),
      searchParams: Promise.resolve({ tab: "squad", groupKey: "g2" }),
    });
    const statSearch = page.props.children.props.children;

    expect(statSearch.type).toBe(StatSearch);
    expect(statSearch.props).toMatchObject({
      initialPlatform: "steam",
      initialNickname: "Fixture Player",
      initialTab: "squad",
      initialGroupKey: "g2",
    });
  });

  it("controller groupKey가 panel 선택과 overview 왕복 후 remount를 모두 소유한다", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/pubg/player?")) return Promise.resolve(jsonResponse(playerReady));
      if (url === "/api/pubg/matches-summary") return Promise.resolve(jsonResponse(summaryReady));
      throw new Error(`Unexpected request: ${url}`);
    });
    render(createElement(StatSearch, {
      initialPlatform: "steam",
      initialNickname: "FixturePlayer",
      initialTab: "squad",
      initialGroupKey: "g2",
    }));

    expect(await screen.findByText("squad-group-g2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "squad-select-g1" }));
    expect(await screen.findByText("squad-group-g1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "개인 분석 개요" }));
    expect(screen.queryByTestId("controlled-squad-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "스쿼드 시너지" }));
    expect(screen.getByText("squad-group-g1")).toBeInTheDocument();
  });

  it("landing submit은 player를 prefetch하지 않고 encoded player route로 이동한다", () => {
    render(createElement(StatSearch));
    fireEvent.change(screen.getByPlaceholderText("정확한 대소문자 닉네임을 입력하세요"), {
      target: { value: "Fixture Player" },
    });
    fireEvent.click(screen.getByRole("button", { name: "검색" }));

    expect(routerPush).toHaveBeenCalledWith("/stats/steam/Fixture%20Player");
    expect(playerRequests()).toHaveLength(0);
  });

  it("landing의 동기 double click/Enter는 route push 한 번만 만든다", () => {
    render(createElement(StatSearch));
    const input = screen.getByPlaceholderText("정확한 대소문자 닉네임을 입력하세요");
    fireEvent.change(input, { target: { value: "OnePush" } });
    const submit = screen.getByRole("button", { name: "검색" });

    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(playerRequests()).toHaveLength(0);
  });

  it("same-route push가 완료되지 않아도 bounded timeout 뒤 navigation guard를 복구한다", () => {
    vi.useFakeTimers();
    render(createElement(StatSearch));
    const input = screen.getByPlaceholderText("정확한 대소문자 닉네임을 입력하세요");
    fireEvent.change(input, { target: { value: "R" } });

    fireEvent.click(screen.getByRole("button", { name: "검색" }));
    fireEvent.click(screen.getByRole("button", { name: "검색" }));
    expect(routerPush).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1_000));
    fireEvent.click(screen.getByRole("button", { name: "검색" }));

    expect(routerPush).toHaveBeenCalledTimes(2);
    expect(playerRequests()).toHaveLength(0);
  });

  it("fresh PlayerA refresh cooldown 중에도 PlayerB generic search는 route-first 이동한다", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      ...playerReady,
      nickname: "PlayerA",
      recentMatches: [],
      updatedAt: new Date().toISOString(),
    }));
    render(createElement(StatSearch, {
      initialPlatform: "steam",
      initialNickname: "PlayerA",
    }));
    await screen.findByText("PlayerA");
    const input = screen.getByPlaceholderText("정확한 대소문자 닉네임을 입력하세요");

    fireEvent.change(input, { target: { value: "PlayerB" } });
    const searchButton = screen.getByRole("button", { name: "검색" });
    expect(searchButton).toBeEnabled();
    fireEvent.click(searchButton);

    expect(routerPush).toHaveBeenCalledWith("/stats/steam/PlayerB");
    expect(playerRequests()).toHaveLength(1);
  });

  it("recent와 favorite quick action도 landing player fetch 없이 route-first 이동한다", async () => {
    localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(["RecentPlayer"]));
    localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(["FavoritePlayer"]));
    const { unmount } = render(createElement(StatSearch));
    const input = screen.getByPlaceholderText("정확한 대소문자 닉네임을 입력하세요");
    fireEvent.focus(input);

    fireEvent.click(await screen.findByRole("button", { name: "RecentPlayer" }));
    expect(routerPush).toHaveBeenCalledWith("/stats/steam/RecentPlayer");
    expect(playerRequests()).toHaveLength(0);

    unmount();
    routerPush.mockReset();
    render(createElement(StatSearch));
    fireEvent.focus(screen.getByPlaceholderText("정확한 대소문자 닉네임을 입력하세요"));
    fireEvent.click(await screen.findByRole("button", { name: "FavoritePlayer" }));
    expect(routerPush).toHaveBeenCalledWith("/stats/steam/FavoritePlayer");
    expect(playerRequests()).toHaveLength(0);
  });

  it("autocomplete 선택도 반환 platform route로만 이동한다", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      suggestions: [{ nickname: "AutoPlayer", platform: "kakao" }],
    }));
    render(createElement(StatSearch));
    const input = screen.getByPlaceholderText("정확한 대소문자 닉네임을 입력하세요");
    fireEvent.change(input, { target: { value: "Au" } });
    fireEvent.focus(input);

    fireEvent.click(await screen.findByRole("button", { name: "AutoPlayer 카카오로 검색" }));

    expect(routerPush).toHaveBeenCalledWith("/stats/kakao/AutoPlayer");
    expect(playerRequests()).toHaveLength(0);
  });

  it("landing compare는 battle route로 이동하고 기능 카드는 세 개만 표시한다", () => {
    render(createElement(StatSearch));
    fireEvent.click(screen.getByRole("button", { name: "1:1 전적 비교" }));

    expect(routerPush).toHaveBeenCalledWith("/stats/battle");
    expect(screen.getAllByTestId("stats-landing-feature")).toHaveLength(3);
    expect(screen.getByText("전적 요약")).toBeInTheDocument();
    expect(screen.getByText("AI 분석")).toBeInTheDocument();
    expect(screen.getByText("스쿼드 시너지")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "로그인" })).toHaveAttribute("href", "/login");
  });

  it("로그인 profile에 PUBG 닉네임이 없으면 중복 조회 없이 mypage 등록 prompt를 표시한다", async () => {
    authState.user = { id: "missing-nickname-user" };
    profileSingleMock.mockResolvedValue({
      data: { pubg_nickname: null, pubg_platform: null },
      error: null,
    });

    render(createElement(StatSearch));

    expect(await screen.findByRole("link", { name: "PUBG 닉네임 등록" }))
      .toHaveAttribute("href", "/mypage");
    expect(screen.getAllByTestId("stats-landing-feature")).toHaveLength(3);
    expect(profileSingleMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link", { name: "로그인" })).not.toBeInTheDocument();
  });

  it("404 추천은 반환 platform으로 route-first 이동한다", async () => {
    localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(["Existing"]));
    fetchMock.mockResolvedValue(jsonResponse({
      error: "not found",
      code: "PLAYER_NOT_FOUND",
      suggestions: [{ nickname: "FixtureAlt", platform: "kakao" }],
    }, 404));
    render(createElement(StatSearch, {
      initialPlatform: "steam",
      initialNickname: "MissingPlayer",
    }));
    const suggestion = await screen.findByRole("button", { name: "FixtureAlt 카카오로 검색" });

    fireEvent.click(suggestion);

    expect(routerPush).toHaveBeenCalledWith("/stats/kakao/FixtureAlt");
    await waitFor(() => expect(playerRequests()).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_RECENT)!)).toEqual(["Existing"]);
  });

  it("MatchCard 닉네임 클릭은 현재 결과에서 새 route로만 이동한다", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(playerReady))
      .mockResolvedValueOnce(jsonResponse(summaryReady));
    render(createElement(StatSearch, {
      initialPlatform: "steam",
      initialNickname: "FixturePlayer",
    }));

    fireEvent.click(await screen.findByRole("button", { name: "row-player-search" }));

    expect(routerPush).toHaveBeenCalledWith("/stats/steam/Row%20Player");
    expect(playerRequests()).toHaveLength(1);
  });

  it("지연된 로그인 profile은 사용자가 먼저 입력한 값을 덮어쓰지 않는다", async () => {
    let resolveProfile!: (value: { data: { pubg_nickname: string; pubg_platform: string }; error: null }) => void;
    profileSingleMock.mockReturnValue(new Promise((resolve) => { resolveProfile = resolve; }));
    authState.user = { id: "late-user" };
    render(createElement(StatSearch));
    const input = screen.getByPlaceholderText("정확한 대소문자 닉네임을 입력하세요");
    fireEvent.change(input, { target: { value: "ManualPlayer" } });

    await act(async () => {
      resolveProfile({
        data: { pubg_nickname: "ProfilePlayer", pubg_platform: "kakao" },
        error: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(input).toHaveValue("ManualPlayer");
    expect(profileSingleMock).toHaveBeenCalledTimes(1);
  });
});
