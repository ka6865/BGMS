// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsPlatform } from "@/types/stats-page";
import { createSquadRequestCache } from "@/lib/stats/squadRequestCache";
import { aiManager } from "@/lib/ai-management";
import SquadAnalysisPanel from "@/components/stat/SquadAnalysisPanel";

const { authState, routerPush, trackEvent } = vi.hoisted(() => ({
  authState: { user: { id: "fixture-user" } as { id: string } | null },
  routerPush: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
  useSearchParams: () => new URLSearchParams("groupKey=g1"),
}));
vi.mock("next/dynamic", () => ({
  default: () => ({ matchId }: { matchId: string }) => createElement("div", { "data-testid": "squad-map" }, matchId),
}));
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => authState }));
vi.mock("@/components/stat/SquadCauseScenes", () => ({ default: () => null }));
vi.mock("@/lib/analytics", () => ({ trackEvent }));
vi.mock("html-to-image", () => ({ toPng: vi.fn().mockResolvedValue("data:image/png;base64,fixture") }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const groups = [
  { groupKey: "g1", members: ["Alpha", "Bravo"], matchCount: 3 },
  { groupKey: "g2", members: ["Charlie", "Delta"], matchCount: 2 },
];

function detail(groupKey: string) {
  return {
    groupKey,
    matchCount: 1,
    matchesSummary: [{
      matchId: `match-${groupKey}`,
      mapName: "Baltic_Main",
      mapDisplayName: "에란겔",
      winPlace: 2,
      createdAt: "2026-08-01T00:00:00.000Z",
    }],
    stats: {
      avgIsolation: 1.2,
      avgTradeLatency: 1000,
      totalSmokeRescues: 1,
      totalRevives: 1,
      avgCoverRate: 0.5,
      totalTeamWipes: 1,
    },
    scores: { formation: 80, backupSpeed: 81, survivalCare: 82, focusFire: 83, teamWipe: 84 },
    squadGrade: "A",
    roleProfiles: [{
      name: "FixturePlayer",
      role: "메인 딜러",
      roleDesc: "fixture role",
      avgDamage: 400,
      avgKills: 3,
      avgAssists: 1,
      avgDbnos: 2,
      shares: { damage: 50, kill: 50, assist: 50, dbno: 50 },
    }],
    causeScenes: [],
  };
}

function detailWithZeroTradeLatency(groupKey: string) {
  return {
    ...detail(groupKey),
    stats: {
      ...detail(groupKey).stats,
      avgTradeLatency: 0,
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPanel(groupKey: string | undefined, onGroupKeyChange = vi.fn()) {
  return render(createElement(SquadAnalysisPanel, {
    nickname: "FixturePlayer",
    platform: "steam" as StatsPlatform,
    groupKey,
    onGroupKeyChange,
  }));
}

describe("SquadAnalysisPanel controlled groupKey", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    routerPush.mockReset();
    trackEvent.mockReset();
    authState.user = { id: "fixture-user" };
    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/pubg/ai-squad") {
        return Promise.resolve(jsonResponse({
          squadGrade: "A",
          summary: "fixture summary",
          strength: "fixture strength",
          weakness: "fixture weakness",
          coaching: "fixture coaching",
        }));
      }
      const parsed = new URL(url, "http://localhost");
      const groupKey = parsed.searchParams.get("groupKey");
      return Promise.resolve(groupKey
        ? jsonResponse(detail(groupKey))
        : jsonResponse({ groups }));
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:fixture"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    window.history.replaceState(null, "", "/stats/steam/FixturePlayer?tab=squad&groupKey=g1");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const listRequests = () => fetchMock.mock.calls.filter(([input]) => {
    const url = String(input);
    return url.startsWith("/api/pubg/squad-analyze?") && !new URL(url, "http://localhost").searchParams.has("groupKey");
  });
  const detailRequests = (groupKey: string) => fetchMock.mock.calls.filter(([input]) => {
    const url = String(input);
    return url.startsWith("/api/pubg/squad-analyze?")
      && new URL(url, "http://localhost").searchParams.get("groupKey") === groupKey;
  });
  const aiRequests = () => fetchMock.mock.calls.filter(([input]) => String(input) === "/api/pubg/ai-squad");

  it("같은 페이지에서 탭을 다시 열면 목록과 상세 GET을 재사용한다", async () => {
    const requestCache = createSquadRequestCache();
    const props = { nickname: "FixturePlayer", platform: "steam" as StatsPlatform, groupKey: "g1", onGroupKeyChange: vi.fn(), requestCache };
    const first = render(createElement(SquadAnalysisPanel, props));
    await screen.findByText("협동 시너지 밸런스");
    first.unmount();
    const second = render(createElement(SquadAnalysisPanel, props));
    await screen.findByText("협동 시너지 밸런스");
    expect(listRequests()).toHaveLength(1);
    expect(detailRequests("g1")).toHaveLength(1);
    second.rerender(createElement(SquadAnalysisPanel, { ...props, requestCache: createSquadRequestCache() }));
    await waitFor(() => expect(listRequests()).toHaveLength(2));
    await waitFor(() => expect(detailRequests("g1")).toHaveLength(2));
    expect(aiRequests()).toHaveLength(0);
  });

  it("전환 전 팀의 늦은 상세 응답을 무시한다", async () => {
    let resolveOld!: (response: Response) => void;
    const normalFetch = fetchMock.getMockImplementation() as (input: RequestInfo | URL) => Promise<Response>;
    fetchMock.mockImplementation((input) => String(input).includes("groupKey=g1")
      ? new Promise<Response>((resolve) => { resolveOld = resolve; }) : normalFetch(input));
    const props = { nickname: "FixturePlayer", platform: "steam" as StatsPlatform, groupKey: "g1", onGroupKeyChange: vi.fn() };
    const view = render(createElement(SquadAnalysisPanel, props));
    await waitFor(() => expect(detailRequests("g1")).toHaveLength(1));
    view.rerender(createElement(SquadAnalysisPanel, { ...props, groupKey: "g2" }));
    await screen.findByText("협동 시너지 밸런스");
    fireEvent.click(screen.getByRole("button", { name: /지도 펼치기/ }));
    expect(screen.getByTestId("squad-map")).toHaveTextContent("match-g2");
    await act(async () => { resolveOld(jsonResponse(detail("g1"))); });
    expect(screen.getByTestId("squad-map")).toHaveTextContent("match-g2");
  });

  it("탭을 닫으면 AI를 취소하고 늦은 완료가 다른 분석의 잠금을 풀지 않는다", async () => {
    let resolveAi!: (response: Response) => void;
    const normalFetch = fetchMock.getMockImplementation() as (input: RequestInfo | URL) => Promise<Response>;
    fetchMock.mockImplementation((input) => String(input) === "/api/pubg/ai-squad"
      ? new Promise<Response>((resolve) => { resolveAi = resolve; }) : normalFetch(input));
    const view = renderPanel("g1");
    await screen.findByText("협동 시너지 밸런스");
    fireEvent.click(screen.getByRole("button", { name: "AI 코칭 보고서 생성" }));
    const signal = (aiRequests()[0][1] as RequestInit).signal!;
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(aiManager.startAnalysis("another-analysis")).toBe(true);
    try {
      await act(async () => { resolveAi(jsonResponse({ squadGrade: "A", summary: "old response" })); });
      expect(aiManager.getStatus().activeId).toBe("another-analysis");
    } finally { aiManager.stopAnalysis("another-analysis"); }
  });

  it("엄호 미측정은 등급을 보류하고 측정된 지표로 AI를 요청한다", async () => {
    const normalFetch = fetchMock.getMockImplementation() as (input: RequestInfo | URL) => Promise<Response>;
    fetchMock.mockImplementation((input) => String(input).includes("groupKey=g1")
      ? Promise.resolve(jsonResponse({ ...detail("g1"), squadGrade: null, stats: { ...detail("g1").stats, avgCoverRate: null }, scores: { ...detail("g1").scores, focusFire: null } }))
      : normalFetch(input));
    renderPanel("g1");
    await screen.findByText("등급 보류");
    expect(screen.getByText(/아직 집계하지 않는 지표/)).toBeInTheDocument();
    expect(screen.queryByText(/권장 기준치: 30%/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "AI 코칭 보고서 생성" }));
    await screen.findByText("fixture summary");
    expect(aiRequests()).toHaveLength(1);
  });

  it("지표 준비 전 409는 이유를 안내하고 즉시 재시도 버튼을 제공하지 않는다", async () => {
    const normalFetch = fetchMock.getMockImplementation() as (input: RequestInfo | URL) => Promise<Response>;
    fetchMock.mockImplementation((input) => String(input) === "/api/pubg/ai-squad"
      ? Promise.resolve(jsonResponse({ errorCode: "PUBG_AI_SQUAD_CANONICAL_NOT_READY", retryable: false }, 409))
      : normalFetch(input));
    renderPanel("g1");
    await screen.findByText("협동 시너지 밸런스");
    fireEvent.click(screen.getByRole("button", { name: "AI 코칭 보고서 생성" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("경기 지표가 아직 없습니다");
    expect(screen.getByRole("button", { name: "AI 코칭 보고서 생성" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
    expect(aiRequests()).toHaveLength(1);
  });

  it("상세 요청 실패는 오류 안내 후 성공적으로 재시도할 수 있다", async () => {
    const normalFetch = fetchMock.getMockImplementation() as (input: RequestInfo | URL) => Promise<Response>;
    let fail = true;
    fetchMock.mockImplementation((input) => String(input).includes("groupKey=g1") && fail
      ? Promise.resolve(jsonResponse({ error: "temporary failure" }, 503)) : normalFetch(input));
    renderPanel("g1");
    expect(await screen.findByRole("alert")).toHaveTextContent("스쿼드 데이터를 불러오지 못했습니다");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await screen.findByText("협동 시너지 밸런스");
    expect(detailRequests("g1")).toHaveLength(2);
    expect(listRequests()).toHaveLength(1);
  });

  it("valid g2를 초기 선택하고 g1 변경에는 상위만 알린 뒤 g1 detail만 추가한다", async () => {
    const onGroupKeyChange = vi.fn();
    const { rerender } = renderPanel("g2", onGroupKeyChange);

    const selector = await screen.findByRole("combobox", { name: "스쿼드 그룹" });
    expect(selector).toHaveValue("g2");
    await waitFor(() => expect(detailRequests("g2")).toHaveLength(1));
    expect(listRequests()).toHaveLength(1);
    expect(aiRequests()).toHaveLength(0);

    fireEvent.change(selector, { target: { value: "g1" } });
    expect(onGroupKeyChange).toHaveBeenCalledTimes(1);
    expect(onGroupKeyChange).toHaveBeenCalledWith("g1");
    expect(listRequests()).toHaveLength(1);

    rerender(createElement(SquadAnalysisPanel, {
      nickname: "FixturePlayer",
      platform: "steam" as StatsPlatform,
      groupKey: "g1",
      onGroupKeyChange,
    }));
    await waitFor(() => expect(detailRequests("g1")).toHaveLength(1));
    expect(detailRequests("g2")).toHaveLength(1);
    expect(listRequests()).toHaveLength(1);
  });

  it("invalid deep-link key로 detail을 요청하지 않고 목록 준비 후 g1을 상위에 올린다", async () => {
    const onGroupKeyChange = vi.fn();
    renderPanel("missing", onGroupKeyChange);

    await waitFor(() => expect(onGroupKeyChange).toHaveBeenCalledWith("g1"));
    expect(onGroupKeyChange).toHaveBeenCalledTimes(1);
    expect(detailRequests("missing")).toHaveLength(0);
    expect(listRequests()).toHaveLength(1);
  });

  it("groupKey가 없으면 첫 g1을 상위에 한 번만 올린다", async () => {
    const onGroupKeyChange = vi.fn();
    renderPanel(undefined, onGroupKeyChange);

    await waitFor(() => expect(onGroupKeyChange).toHaveBeenCalledWith("g1"));
    expect(onGroupKeyChange).toHaveBeenCalledTimes(1);
    expect(listRequests()).toHaveLength(1);
  });

  it("마운트에서 AI POST는 0건이고 CTA payload·share groupKey/UTM·2D 맵을 보존한다", async () => {
    renderPanel("g2");
    await screen.findByText("협동 시너지 밸런스");
    expect(aiRequests()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "AI 코칭 보고서 생성" }));
    await waitFor(() => expect(aiRequests()).toHaveLength(1));
    const aiInit = aiRequests()[0][1] as RequestInit;
    expect(JSON.parse(String(aiInit.body))).toEqual({
      groupKey: "g2",
      nickname: "FixturePlayer",
      platform: "steam",
      coachingStyle: "spicy",
    });

    fireEvent.click(await screen.findByRole("button", { name: /\ub9c1\ud06c \ubcf5\uc0ac/ }));
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    const shareUrl = new URL(copied);
    expect(shareUrl.searchParams.get("tab")).toBe("squad");
    expect(shareUrl.searchParams.get("groupKey")).toBe("g2");
    expect(shareUrl.searchParams.get("utm_source")).toBe("user_share");
    expect(shareUrl.searchParams.get("utm_medium")).toBe("social");
    expect(shareUrl.searchParams.get("utm_campaign")).toBe("squad_synergy_share");

    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const downloadButton = screen.getByRole("button", { name: /\uc774\ubbf8\uc9c0 \uc800\uc7a5/ });
    await waitFor(() => expect(downloadButton).toBeEnabled());
    fireEvent.click(downloadButton);
    await waitFor(() => expect(downloadClick).toHaveBeenCalledTimes(1));
    const downloadAnchor = downloadClick.mock.instances[0] as HTMLAnchorElement;
    expect(downloadAnchor.download).toBe("bgms-ai-squad-FixturePlayer.png");

    fireEvent.click(screen.getByRole("button", { name: /\uc9c0\ub3c4 \ud3bc\uce58\uae30/ }));
    expect(screen.getByTestId("squad-map")).toHaveTextContent("match-g2");
  });

  it("finite zero trade latency is rendered as measured 0.00초", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/pubg/ai-squad") {
        return Promise.resolve(jsonResponse({
          squadGrade: "A",
          summary: "fixture summary",
          strength: "fixture strength",
          weakness: "fixture weakness",
          coaching: "fixture coaching",
        }));
      }
      const parsed = new URL(url, "http://localhost");
      const selectedGroupKey = parsed.searchParams.get("groupKey");
      return Promise.resolve(selectedGroupKey
        ? jsonResponse(detailWithZeroTradeLatency(selectedGroupKey))
        : jsonResponse({ groups }));
    });

    renderPanel("g1");

    await waitFor(() => expect(screen.getByText("0.00초")).toBeInTheDocument());
    expect(screen.queryByText("측정 불가")).not.toBeInTheDocument();
  });

  it("does not render an all-zero radar polygon when any synergy score is unavailable", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/pubg/ai-squad") {
        return Promise.resolve(jsonResponse({
          squadGrade: "A",
          summary: "fixture summary",
          strength: "fixture strength",
          weakness: "fixture weakness",
          coaching: "fixture coaching",
        }));
      }
      const parsed = new URL(url, "http://localhost");
      const selectedGroupKey = parsed.searchParams.get("groupKey");
      return Promise.resolve(selectedGroupKey
        ? jsonResponse({
            ...detail(selectedGroupKey),
            scores: { formation: 80, backupSpeed: 81, survivalCare: null, focusFire: 83, teamWipe: 84 },
          })
        : jsonResponse({ groups }));
    });

    const view = renderPanel("g1");

    await waitFor(() => expect(screen.getByText(/생존 케어 \(측정 불가\)/)).toBeInTheDocument());
    expect(view.container.querySelector('polygon[stroke="rgba(168, 85, 247, 0.85)"]')).toBeNull();
    expect(view.container.querySelectorAll('circle[fill="#a855f7"]')).toHaveLength(0);
  });

  it("renders unavailable role shares without a null percent label or bar width", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/pubg/ai-squad") {
        return Promise.resolve(jsonResponse({
          squadGrade: "A",
          summary: "fixture summary",
          strength: "fixture strength",
          weakness: "fixture weakness",
          coaching: "fixture coaching",
        }));
      }
      const parsed = new URL(url, "http://localhost");
      const selectedGroupKey = parsed.searchParams.get("groupKey");
      return Promise.resolve(selectedGroupKey
        ? jsonResponse({
            ...detail(selectedGroupKey),
            roleProfiles: [{
              ...detail(selectedGroupKey).roleProfiles[0],
              shares: { damage: null, kill: 0, assist: null, dbno: 0 },
            }],
          })
        : jsonResponse({ groups }));
    });

    const view = renderPanel("g1");

    await waitFor(() => expect(screen.getByText("딜량 기여")).toBeInTheDocument());
    expect(view.container.textContent).not.toContain("null%");
    expect(view.container.textContent).not.toContain("undefined");
    expect(view.container.textContent).toContain("측정 불가");
    const shareLabel = screen.getByText("딜량 기여").parentElement?.querySelector("span:last-child");
    expect(shareLabel).toHaveTextContent("측정 불가");
    const shareBar = shareLabel?.parentElement?.nextElementSibling?.firstElementChild as HTMLElement | null;
    expect(shareBar?.getAttribute("style") || "").not.toContain("null");
  });
});
