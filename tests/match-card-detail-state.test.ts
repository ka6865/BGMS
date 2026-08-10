// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import type { MatchData } from "@/types/stat";
import detailReadyFixture from "./fixtures/stats/match-detail-ready.json";
import summaryReady from "./fixtures/stats/matches-summary-ready.json";

const { aiStart, aiStop, mockPush, trackEvent } = vi.hoisted(() => ({
  aiStart: vi.fn(() => true),
  aiStop: vi.fn(),
  mockPush: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/common/BgmsIcon", () => ({
  BgmsIcon: () => createElement("span", { "aria-hidden": true }),
}));
vi.mock("@/components/stat/MatchTimeline", () => ({ MatchTimeline: () => null }));
vi.mock("@/lib/ai-management", () => ({
  useAIStatus: () => ({ isAnalyzing: false }),
  aiManager: { startAnalysis: aiStart, stopAnalysis: aiStop },
}));
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("@/lib/analytics", () => ({ trackEvent }));
vi.mock("@/lib/replay/mapCapabilities", () => ({
  resolve3DMapCapability: () => ({ mapId: "Erangel", assetPath: "/fixture" }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { MatchCard } from "@/components/stat/MatchCard";

const baseSummary = summaryReady.summaries["match-fixture-1"] as MatchSummaryData;
const baseDetail = detailReadyFixture as MatchData;

function summary(matchId = "match-detail-1", nickname = "PlayerOne"): MatchSummaryData {
  return {
    ...baseSummary,
    matchId,
    stats: { ...baseSummary.stats, name: nickname },
  };
}

function detail(matchId = "match-detail-1", nickname = "PlayerOne"): MatchData {
  return {
    ...baseDetail,
    matchId,
    stats: { ...baseDetail.stats, name: nickname },
    team: baseDetail.team.map((member, index) => index === 0 ? { ...member, name: nickname } : member),
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function aiResponse(finalVerdict: string) {
  const payload = JSON.stringify({
    coach: "SPICY BOMBER",
    signature: "전술 fixture",
    signatureSub: "fixture summary",
    briefFeedback: ["첫 번째 코칭"],
    finalVerdict,
    actionItems: [],
  });
  const body = `${JSON.stringify({ type: "chunk", data: payload })}\n${JSON.stringify({ type: "done" })}\n`;
  return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

function renderCard(overrides: {
  matchId?: string;
  nickname?: string;
  platform?: "steam" | "kakao";
  isMobile?: boolean;
  onFailure?: (reason: "detail_failed" | "analysis_failed") => void;
  onRecovery?: (reason: "detail_failed" | "analysis_failed") => void;
  onNicknameClick?: (nickname: string) => void;
  onModeDetected?: (matchId: string, gameMode: string, matchType?: string, mapName?: string) => void;
} = {}) {
  const matchId = overrides.matchId ?? "match-detail-1";
  const nickname = overrides.nickname ?? "PlayerOne";
  return render(createElement(MatchCard, {
    matchId,
    nickname,
    platform: overrides.platform ?? "steam",
    isMobile: overrides.isMobile ?? false,
    initialMatchData: summary(matchId, nickname),
    onFailure: overrides.onFailure,
    onRecovery: overrides.onRecovery,
    onNicknameClick: overrides.onNicknameClick,
    onModeDetected: overrides.onModeDetected,
  }));
}

describe("MatchCard isolated detail state", () => {
  beforeEach(() => {
    mockPush.mockReset();
    trackEvent.mockReset();
    aiStart.mockReset();
    aiStart.mockReturnValue(true);
    aiStop.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("HTTP detail 실패는 compact 요약을 유지하고 명시적 retry 성공만 같은 source를 recovery한다", async () => {
    const onFailure = vi.fn();
    const onRecovery = vi.fn();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ error: "detail unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse(detail()));
    vi.stubGlobal("fetch", fetchMock);
    renderCard({ onFailure, onRecovery });

    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
    expect(await screen.findByText("상세 정보를 불러오지 못했습니다")).toBeInTheDocument();
    expect(screen.getByText("에란겔")).toBeVisible();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith("detail_failed");

    fireEvent.click(screen.getByRole("button", { name: "상세 다시 시도" }));
    await screen.findByText("팀원 교전 성적");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRecovery).toHaveBeenCalledTimes(1);
    expect(onRecovery).toHaveBeenCalledWith("detail_failed");
  });

  it("summary와 full detail 모두 gameMode+matchType+mapName 전체 metadata를 전달한다", async () => {
    const onModeDetected = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(detail()))));
    renderCard({ onModeDetected });

    expect(onModeDetected).toHaveBeenCalledWith(
      "match-detail-1",
      baseSummary.gameMode,
      baseSummary.matchType,
      baseSummary.mapName,
    );
    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
    await screen.findByText("팀원 교전 성적");
    expect(onModeDetected).toHaveBeenLastCalledWith(
      "match-detail-1",
      "squad-fpp",
      "competitive",
      "Baltic_Main",
    );
  });

  it("상세 성공 뒤 팀·무기·티어 근거·지도·AI·2D/3D replay 계약을 보존한다", async () => {
    const onNicknameClick = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.startsWith("/api/pubg/match?")) return Promise.resolve(jsonResponse(detail()));
      if (url === "/api/pubg/ai-analyze") return Promise.resolve(aiResponse("final fixture verdict"));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCard({ platform: "kakao", onNicknameClick });

    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
    await screen.findByTestId("expanded-match-details");
    expect(screen.getByText("티어 산정 근거")).toBeInTheDocument();
    expect(screen.getByText("팀 66.3%")).toBeInTheDocument();
    expect(screen.getByText("화력 담당")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "전투 점수" })).toHaveAttribute("aria-valuenow", "34");
    expect(screen.getByRole("progressbar", { name: "전술 점수" })).toHaveAttribute("aria-valuenow", "27");
    expect(screen.getByRole("progressbar", { name: "생존 점수" })).toHaveAttribute("aria-valuenow", "21");
    expect(screen.getByText("87 · 캐리 (CARRY)")).toBeInTheDocument();
    expect(screen.getByText("화력 기여")).toBeInTheDocument();
    expect(screen.getByText("다음 S+ 티어까지 8점")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "다음 S+ 티어 진행도" })).toHaveAttribute("aria-valuenow", "82");
    const combatEvidence = screen.getByRole("region", { name: "전투 근거" });
    expect(within(combatEvidence).getByText("딜량 순위")).toBeInTheDocument();
    expect(within(combatEvidence).getByText("#2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /무기 사용/ }));
    expect(screen.getByText("M416")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /팀원/ }));
    fireEvent.click(screen.getAllByText("SquadMate").at(-1)!);
    expect(onNicknameClick).toHaveBeenCalledWith("SquadMate");

    fireEvent.click(screen.getByRole("button", { name: /전술 위치 분석 및 타임라인/ }));
    expect(screen.getByTestId("match-tactical-map")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /AI 전술 코칭/ }));
    fireEvent.click(screen.getByRole("button", { name: "이 매치 정밀 분석 시작하기" }));
    expect(await screen.findByText(/final fixture verdict/)).toBeInTheDocument();
    const aiCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/pubg/ai-analyze");
    expect(JSON.parse(String((aiCall?.[1] as RequestInit).body))).toMatchObject({
      nickname: "PlayerOne",
      platform: "kakao",
      coachingStyle: "spicy",
      matchData: { matchId: "match-detail-1" },
    });

    fireEvent.click(screen.getByRole("button", { name: "리플레이 분석" }));
    fireEvent.click(screen.getByRole("button", { name: /3D 전술 리플레이/ }));
    expect(mockPush).toHaveBeenLastCalledWith(
      "/replay/3d?matchId=match-detail-1&nickname=PlayerOne&platform=kakao",
    );
    fireEvent.click(screen.getByRole("button", { name: "리플레이 분석" }));
    fireEvent.click(screen.getByRole("button", { name: /2D 맵 리플레이/ }));
    expect(mockPush).toHaveBeenLastCalledWith(
      "/maps/Erangel?playback=match-detail-1&nickname=PlayerOne&platform=kakao",
    );
  });

  it("모바일 live 상세의 티어 세부 근거는 접힌 상태와 accessible toggle을 유지한다", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(detail()))));
    renderCard({ isMobile: true });

    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
    await screen.findByText("팀 66.3%");

    const openButton = screen.getByRole("button", { name: "상세 근거 보기" });
    expect(openButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "전투 근거" })).not.toBeInTheDocument();

    fireEvent.click(openButton);
    expect(screen.getByRole("button", { name: "상세 근거 접기" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "전투 근거" })).toBeInTheDocument();
  });

  it("collapse는 진행 중 AI를 abort하지 않고 mounted state/final verdict를 보존한다", async () => {
    let resolveAi!: (response: Response) => void;
    const pendingAi = new Promise<Response>((resolve) => { resolveAi = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/pubg/match?")) return Promise.resolve(jsonResponse(detail()));
      if (url === "/api/pubg/ai-analyze") return pendingAi;
      throw new Error(`Unexpected request: ${url} ${String(init)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
    await screen.findByText("AI 전술 코칭");
    fireEvent.click(screen.getByRole("button", { name: /AI 전술 코칭/ }));
    fireEvent.click(screen.getByRole("button", { name: "이 매치 정밀 분석 시작하기" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/pubg/ai-analyze")).toHaveLength(1));
    const aiCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/pubg/ai-analyze")!;
    const signal = (aiCall[1] as RequestInit).signal as AbortSignal;

    fireEvent.click(screen.getByRole("button", { name: "매치 상세 접기" }));
    expect(screen.getByTestId("expanded-match-details")).not.toBeVisible();
    expect(screen.getByTestId("expanded-match-details")).toHaveAttribute("aria-hidden", "true");
    expect(signal.aborted).toBe(false);

    await act(async () => resolveAi(aiResponse("retained AI verdict")));
    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
    expect(await screen.findByText(/retained AI verdict/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AI 전술 코칭/ })).toHaveAttribute("aria-expanded", "true");
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/pubg/match?"))).toHaveLength(1);
  });

  it("AI HTTP failure와 성공 retry는 analysis partial만 같은 행에서 report/recover한다", async () => {
    const onFailure = vi.fn();
    const onRecovery = vi.fn();
    let aiAttempt = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/pubg/match?")) return Promise.resolve(jsonResponse(detail()));
      if (url === "/api/pubg/ai-analyze") {
        aiAttempt += 1;
        return Promise.resolve(aiAttempt === 1
          ? new Response("analysis failed", { status: 503 })
          : aiResponse("recovered AI verdict"));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCard({ onFailure, onRecovery });

    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
    await screen.findByText("AI 전술 코칭");
    fireEvent.click(screen.getByRole("button", { name: /AI 전술 코칭/ }));
    fireEvent.click(screen.getByRole("button", { name: "이 매치 정밀 분석 시작하기" }));
    await waitFor(() => expect(onFailure).toHaveBeenCalledWith("analysis_failed"));
    expect(onFailure).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "이 매치 정밀 분석 시작하기" }));
    expect(await screen.findByText(/recovered AI verdict/)).toBeInTheDocument();
    expect(onRecovery.mock.calls.filter(([reason]) => reason === "analysis_failed")).toHaveLength(1);
  });

  it("same match A→B AI owner는 composite identity이며 late A finally가 B lock을 해제하지 않는다", async () => {
    let resolveAiA!: (response: Response) => void;
    let resolveAiB!: (response: Response) => void;
    const aiA = new Promise<Response>((resolve) => { resolveAiA = resolve; });
    const aiB = new Promise<Response>((resolve) => { resolveAiB = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/pubg/match?")) {
        const target = url.includes("nickname=PlayerA") ? "PlayerA" : "PlayerB";
        return Promise.resolve(jsonResponse(detail("same-match", target)));
      }
      if (url === "/api/pubg/ai-analyze") {
        const body = JSON.parse(String(init?.body)) as { nickname: string };
        return body.nickname === "PlayerA" ? aiA : aiB;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(createElement(MatchCard, {
      matchId: "same-match",
      nickname: "PlayerA",
      platform: "steam",
      isMobile: false,
      initialMatchData: summary("same-match", "PlayerA"),
    }));
    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
    await screen.findByText("AI 전술 코칭");
    fireEvent.click(screen.getByRole("button", { name: /AI 전술 코칭/ }));
    fireEvent.click(screen.getByRole("button", { name: "이 매치 정밀 분석 시작하기" }));
    const aiCallA = await waitFor(() => fetchMock.mock.calls.find(([input, init]) =>
      String(input) === "/api/pubg/ai-analyze" && String(init?.body).includes("PlayerA"),
    ));
    const signalA = (aiCallA?.[1] as RequestInit).signal as AbortSignal;

    view.rerender(createElement(MatchCard, {
      matchId: "same-match",
      nickname: "PlayerB",
      platform: "kakao",
      isMobile: false,
      initialMatchData: summary("same-match", "PlayerB"),
    }));
    expect(signalA.aborted).toBe(true);
    expect(aiStop).toHaveBeenCalledWith("steam:playera:same-match");

    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
    await screen.findByText("AI 전술 코칭");
    fireEvent.click(screen.getByRole("button", { name: /AI 전술 코칭/ }));
    fireEvent.click(screen.getByRole("button", { name: "이 매치 정밀 분석 시작하기" }));
    await waitFor(() => expect(aiStart).toHaveBeenCalledWith("kakao:playerb:same-match"));

    await act(async () => resolveAiA(aiResponse("stale A verdict")));
    expect(aiStop.mock.calls.filter(([owner]) => owner === "kakao:playerb:same-match")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "이 매치 정밀 분석 시작하기" })).toBeDisabled();

    await act(async () => resolveAiB(aiResponse("fresh B verdict")));
    expect(await screen.findByText(/fresh B verdict/)).toBeInTheDocument();
    expect(screen.queryByText(/stale A verdict/)).not.toBeInTheDocument();
  });

  it("platform+nickname+matchId identity 전환은 A를 abort하고 late A가 B ready/partial을 덮지 않는다", async () => {
    let resolveA!: (response: Response) => void;
    const responseA = new Promise<Response>((resolve) => { resolveA = resolve; });
    const onFailure = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.includes("nickname=PlayerA")) return responseA;
      if (url.includes("nickname=PlayerB")) return Promise.resolve(jsonResponse(detail("same-match", "PlayerB")));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(createElement(MatchCard, {
      matchId: "same-match",
      nickname: "PlayerA",
      platform: "steam",
      isMobile: false,
      initialMatchData: summary("same-match", "PlayerA"),
      onFailure,
    }));
    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signalA = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal as AbortSignal;

    view.rerender(createElement(MatchCard, {
      matchId: "same-match",
      nickname: "PlayerB",
      platform: "kakao",
      isMobile: false,
      initialMatchData: summary("same-match", "PlayerB"),
      onFailure,
    }));
    expect(signalA.aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
    await screen.findByText("팀원 교전 성적");

    resolveA(jsonResponse(detail("same-match", "PlayerA")));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: /팀원 교전 성적/ }));
    expect(screen.getByText("PlayerB")).toBeInTheDocument();
    expect(screen.queryByText("PlayerA")).not.toBeInTheDocument();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("상세 request는 unmount에서 abort되고 abort 자체는 partial failure가 아니다", async () => {
    const onFailure = vi.fn();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderCard({ onFailure });

    fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal as AbortSignal;
    view.unmount();

    expect(signal.aborted).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();
  });
});
