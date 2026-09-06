// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import aiReady from "./fixtures/stats/ai-ready.json";

const { aiState, startAnalysis, stopAnalysis, spiderChartProps } = vi.hoisted(() => ({
  aiState: { active: false },
  startAnalysis: vi.fn(() => {
    if (aiState.active) return false;
    aiState.active = true;
    return true;
  }),
  stopAnalysis: vi.fn(() => { aiState.active = false; }),
  spiderChartProps: { current: null as Record<string, unknown> | null },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { id: "fixture-user" } }) }));
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: {} }) } } }));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/ai-management", () => ({
  useAIStatus: () => ({ isAnalyzing: false, activeId: null }),
  aiManager: { startAnalysis, stopAnalysis, subscribe: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/stat/IsolationRadar", () => ({ IsolationRadar: () => null }));
vi.mock("@/components/stat/SpiderChart", () => ({
  SpiderChart: (props: Record<string, unknown>) => {
    spiderChartProps.current = props;
    return null;
  },
}));
vi.mock("@/components/stat/MapKingCard", () => ({ MapKingCard: () => null }));
vi.mock("@/components/common/BgmsIcon", () => ({ BgmsIcon: () => createElement("span", { "aria-hidden": true }) }));
vi.mock("@/components/common/InlineIconLabel", () => ({ InlineIconLabel: ({ children }: { children: unknown }) => children }));

import {
  RecentAISummary,
  finiteVisualNumber,
  formatBluezoneWaste,
  normalizeRouteOwnedVisuals,
  safeVisualDuration,
  safeVisualRate,
} from "@/components/stat/RecentAISummary";
import { buildSummaryCards, type SummaryCard } from "@/lib/pubg-analysis/aiSummaryCards";

function ndjsonResponse(lines: readonly unknown[]): Response {
  return new Response(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

function ndjsonResponseWithoutTrailingNewline(lines: readonly unknown[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join("\n"), {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

function deferredReaderResponse() {
  let resolveRead!: (result: ReadableStreamReadResult<Uint8Array>) => void;
  const reader = {
    read: vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { resolveRead = resolve; })),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  return {
    response: { ok: true, body: { getReader: () => reader } } as unknown as Response,
    settleDone: () => resolveRead({ done: true, value: undefined }),
    reader,
  };
}

function controlledStreamResponse() {
  let resolveRead: ((result: ReadableStreamReadResult<Uint8Array>) => void) | null = null;
  const queued: Uint8Array[] = [];
  let closed = false;
  const reader = {
    read: vi.fn(() => {
      if (queued.length > 0) return Promise.resolve({ done: false, value: queued.shift() });
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { resolveRead = resolve; });
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const encoder = new TextEncoder();
  return {
    response: { ok: true, body: { getReader: () => reader } } as unknown as Response,
    push: (line: unknown) => {
      const value = encoder.encode(`${JSON.stringify(line)}\n`);
      if (resolveRead) {
        const resolve = resolveRead;
        resolveRead = null;
        resolve({ done: false, value });
      } else {
        queued.push(value);
      }
    },
    close: () => {
      closed = true;
      if (resolveRead) {
        const resolve = resolveRead;
        resolveRead = null;
        resolve({ done: true, value: undefined });
      }
    },
  };
}

const baseProps = {
  matchIds: ["match-1", "match-2"] as readonly string[],
  nickname: "FixturePlayer",
  platform: "steam",
};

const v2Context = {
  contextId: "fixture-context",
  gameMode: "squad",
  matchType: "competitive",
  tier: "A",
  userMatchCount: 5,
  benchmarkSampleCount: 12,
  filterVersion: 1,
  populationVersion: 1,
};

function buildV2Cards(): SummaryCard[] {
  const cards = buildSummaryCards({
    topics: ["화력", "교전 주도권", "포지셔닝"],
    context: v2Context,
    evidence: [
      {
        metricId: "damage_average",
        label: "평균 피해량",
        userValue: "300",
        benchmarkValue: "250",
        benchmarkLabel: "상위권 평균",
        unit: "",
        sampleCount: 5,
      },
      {
        metricId: "initiative_rate",
        label: "교전 주도권 비율",
        userValue: "60%",
        benchmarkValue: null,
        benchmarkLabel: "비교 자료 없음",
        unit: "%",
        sampleCount: 5,
      },
      {
        metricId: "isolation_average",
        label: "평균 고립 거리",
        userValue: null,
        benchmarkValue: null,
        benchmarkLabel: "상위권 평균",
        unit: "",
        sampleCount: null,
        unavailableReason: "고립 교전 표본 부족",
      },
    ],
  });
  if (cards.length !== 3) throw new Error("v2 fixture card plan was not built");
  return cards;
}

function readyV2Cards(): SummaryCard[] {
  return buildV2Cards().map((card, index) => index === 0
    ? {
      ...card,
      analysisStatus: "ready",
      kindOpinion: "화력 근거를 확인했습니다.",
      spicyOpinion: "교전 선택을 더 다듬을 수 있습니다.",
      reason: "서버 근거 기반 평가",
      evaluation: "정상",
      winner: "kind",
    }
    : { ...card, analysisStatus: "unavailable", analysisReason: card.analysisReason ?? "AI 해석을 확인하지 못했습니다." });
}

describe("RecentAISummary callback bridge", () => {
  beforeEach(() => {
    aiState.active = false;
    startAnalysis.mockClear();
    stopAnalysis.mockClear();
    spiderChartProps.current = null;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    aiState.active = false;
  });

  it("visual normalizers omit nullish/blank values, keep rates and durations unavailable when negative, and preserve signed trends", () => {
    expect(finiteVisualNumber(null)).toBeNull();
    expect(finiteVisualNumber(undefined)).toBeNull();
    expect(finiteVisualNumber("")).toBeNull();
    expect(finiteVisualNumber("   ")).toBeNull();

    expect(safeVisualRate("-5%")).toBe("측정 불가");
    expect(safeVisualRate("101%")).toBe("측정 불가");
    expect(safeVisualRate("0%")).toBe("0%");
    expect(safeVisualDuration("-1.50s")).toBe("측정 불가");
    expect(safeVisualDuration("0s")).toBe("0.00s");

    expect(normalizeRouteOwnedVisuals({
      trends: {
        dmgTrend: -5,
        winTrend: -12.5,
        status: "하락",
        recent: { damage: 100, winRate: 40 },
        older: { damage: 200, winRate: 60 },
      },
    })).toMatchObject({
      trends: { dmgTrend: -5, winTrend: -12.5 },
    });
  });

  it("bluezone unavailable marker survives normalization and display without turning into 0 HP", async () => {
    expect(normalizeRouteOwnedVisuals({ bluezoneWaste: "측정 불가" })).toMatchObject({
      bluezoneWaste: "측정 불가",
    });
    expect(normalizeRouteOwnedVisuals({ bluezoneWaste: 0 })).toMatchObject({ bluezoneWaste: 0 });
    expect(normalizeRouteOwnedVisuals({ bluezoneWaste: "not-a-number" })?.bluezoneWaste).toBeUndefined();
    expect(normalizeRouteOwnedVisuals({ bluezoneWaste: Number.NaN })?.bluezoneWaste).toBeUndefined();
    expect(formatBluezoneWaste(0)).toBe("0 HP");
    expect(formatBluezoneWaste("측정 불가")).toBe("측정 불가");

    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      {
        type: "visuals",
        data: {
          overallTier: "A",
          bluezoneWaste: "측정 불가",
          goldenTime: { early: 0, mid1: 0, mid2: 0, late: 0 },
        },
      },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange: vi.fn() }));

    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(screen.getByText(/fixture verdict/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));

    expect(screen.getByText(/자기장 누적 피해: 측정 불가/)).toBeInTheDocument();
    expect(screen.queryByText(/자기장 누적 피해: 0 HP/)).not.toBeInTheDocument();
  });

  it("mount/rerender만으로 AI를 요청하지 않고 platform+nickname+IDs identity 변경에 null을 배출한다", async () => {
    const fetchMock = vi.fn();
    const onSummaryChange = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const view = render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith(null));

    view.rerender(createElement(RecentAISummary, {
      ...baseProps,
      platform: "kakao",
      onSummaryChange,
    }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenCalledTimes(2));

    view.rerender(createElement(RecentAISummary, {
      ...baseProps,
      platform: "kakao",
      matchIds: ["match-1", "match-3"],
      onSummaryChange,
    }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenCalledTimes(3));

    expect(onSummaryChange).toHaveBeenLastCalledWith(null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("visuals partial은 snapshot을 만들지 않고 final+done에서만 trim된 verdict/tier를 배출한다", async () => {
    const onSummaryChange = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      {
        type: "visuals",
        data: {
          latestMatchCount: 3,
          bestMatchCount: 3,
          overallTier: "A",
          tierBreakdown: { combat: 80, tactical: 80, survival: 80, total: 80 },
          tactical: {
            suppRate: "0%",
            smokeRate: "0%",
            reviveRate: "0%",
            baitCount: 0,
            counts: {
              supps: 0,
              knocks: 0,
              rescueSmokes: 0,
              smokeRescues: 0,
              smokes: 0,
              revives: 0,
            },
          },
          roleInfo: {
            primaryRole: "entry",
            secondaryRole: null,
            title: "테스트 전술가",
            roleLabel: "전술가",
            description: "검증용 역할",
            signatureWeapon: "테스트 무기",
            scores: {},
          },
        },
      },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, { ...baseProps, isMobile: true, onSummaryChange }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith(null));
    expect(screen.getByText("최근 유효 최대 10판은 전체 흐름에, 잘한 최대 5판은 잠재 티어와 비슷한 조건의 평균 비교에 사용합니다.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "fixture verdict", tier: "A" }));
    expect(onSummaryChange.mock.calls).toEqual([
      [null],
      [{ verdict: "fixture verdict", tier: "A" }],
    ]);
    expect(screen.getByText("점수 상위 3판 잠재 티어")).toBeInTheDocument();
    expect(screen.getByText("최근 3경기 평균 생존 구간")).toBeInTheDocument();
    expect(screen.getByText("3경기 전술 마스터리")).toBeInTheDocument();
    expect(screen.getByText("3경기 합계")).toBeInTheDocument();
    expect(screen.queryByText(/PUBG 공식 티어|PUBG 공식 평점|player-match|해당 지표 n=/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    const tierTrigger = screen.getByRole("button", { name: "점수 상위 3판 잠재 티어 산정 방법 보기" });
    expect(tierTrigger).toHaveAttribute("type", "button");
    expect(tierTrigger).toHaveAttribute("aria-controls", "recent-ai-summary-tier-tooltip");
    expect(tierTrigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.focus(tierTrigger);
    expect(tierTrigger).toHaveAttribute("aria-expanded", "true");
    expect(tierTrigger).toHaveAttribute("aria-describedby", "recent-ai-summary-tier-tooltip");
    const tierTooltip = screen.getByRole("dialog");
    expect(tierTooltip).toHaveAttribute("aria-modal", "true");
    expect(tierTooltip).toHaveAccessibleName("잠재 티어 산정 방법");
    expect(tierTooltip).toHaveTextContent("최근 유효 3판 중 점수가 높은 3판을 골라 교전·전술·생존 점수로 계산합니다.");
    expect(tierTooltip).not.toHaveTextContent(/PUBG 공식 티어|PUBG 공식 평점/);
    const closeTooltip = screen.getByRole("button", { name: "잠재 티어 산정 방법 닫기" });
    expect(closeTooltip).toHaveAttribute("type", "button");
    fireEvent.click(closeTooltip);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(tierTrigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(tierTrigger);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tierBreakdown이 있으면 SpiderChart에 서버 소유 3축을 그대로 전달하고 휴리스틱 축을 만들지 않는다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      {
        type: "visuals",
        data: {
          bestMatchCount: 4,
          tierBreakdown: { combat: 80, tactical: 70, survival: 60, total: 70 },
        },
      },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange: vi.fn() }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    await waitFor(() => expect(spiderChartProps.current).not.toBeNull());
    expect(spiderChartProps.current).toMatchObject({
      data: { combat: 80, tactical: 70, survival: 60 },
      bestMatchCount: 4,
    });
    expect(spiderChartProps.current?.data).not.toHaveProperty("growth");
    expect(spiderChartProps.current?.data).not.toHaveProperty("vision");
    expect(spiderChartProps.current?.data).not.toHaveProperty("teamwork");
  });

  it("malformed route-owned visuals는 UI에 NaN/Infinity/임의 필드를 전달하지 않는다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      {
        type: "visuals",
        data: {
          overallTier: "A",
          tierBreakdown: { combat: Number.NaN, tactical: Number.POSITIVE_INFINITY, survival: "bad", total: -10 },
          forged: "provider visual",
        },
      },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const onSummaryChange = vi.fn();
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "fixture verdict", tier: "A" }));
    expect(document.body.textContent).not.toMatch(/NaN|Infinity|undefined|provider visual/);
    expect(spiderChartProps.current).toBeNull();
  });

  it("visuals-only와 done(valid:false)는 undefined verdict snapshot을 배출하지 않는다", async () => {
    const onSummaryChange = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ndjsonResponse([{ type: "visuals", data: { overallTier: "S" } }]))
      .mockResolvedValueOnce(ndjsonResponse([{ type: "done", valid: false, error: "fatal" }]));
    vi.stubGlobal("fetch", fetchMock);
    const first = render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith(null));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(onSummaryChange.mock.calls).toEqual([[null]]);
    first.unmount();

    render(createElement(RecentAISummary, { ...baseProps, nickname: "OtherPlayer", onSummaryChange }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith(null));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await screen.findByText("AI 분석이 잠깐 막혔어요.");
    expect(onSummaryChange.mock.calls.every(([summary]) => summary === null)).toBe(true);
  });

  it("상세 증거는 label/unit이 일치하는 benchmark만 VS로 표시한다", async () => {
    const onSummaryChange = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { overallTier: "A" } },
      {
        type: "final",
        data: JSON.stringify({
          signature: "검증 칭호",
          signatureSub: "검증 이유",
          finalVerdict: "pairing fixture verdict",
          debateIssues: [{
            topic: "1:1 결정력",
            question: "정확한 지표만 비교하는가?",
            kindOpinion: "같은 지표만 비교합니다.",
            spicyOpinion: "서로 다른 지표를 섞지 않습니다.",
            winner: "kind",
            reason: "검증 데이터",
            evaluation: "정상",
            userStats: [
              { label: "1:1 교전 승률", value: "79%" },
              { label: "총 투척 횟수", value: "22회" },
            ],
            benchmarkStats: [
              { label: "아군 기절 대비 연막 구출률", value: "11%" },
              { label: "상위권 1:1 승률", value: "61%" },
            ],
          }, {
            topic: "두 번째 주제",
            question: "두 번째 질문",
            kindOpinion: "같은 지표만 비교합니다.",
            spicyOpinion: "서로 다른 지표를 섞지 않습니다.",
            winner: "kind",
            reason: "검증",
            evaluation: "정상",
            userStats: [],
            benchmarkStats: [],
          }, {
            topic: "세 번째 주제",
            question: "세 번째 질문",
            kindOpinion: "같은 지표만 비교합니다.",
            spicyOpinion: "서로 다른 지표를 섞지 않습니다.",
            winner: "kind",
            reason: "검증",
            evaluation: "정상",
            userStats: [],
            benchmarkStats: [],
          }],
          actionItems: [{ icon: "target", title: "검증", desc: "검증" }],
        }),
      },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith(null));

    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /1:1 결정력/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    expect(screen.getAllByText("판정 보류")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /1:1 결정력/ }));

    expect(screen.getByText(/같은 지표만 비교합니다/)).toBeInTheDocument();
    expect(screen.getByText(/서로 다른 지표를 섞지 않습니다/)).toBeInTheDocument();
    expect(screen.getByText("79%")).toBeInTheDocument();
    expect(screen.getByText("61%")).toBeInTheDocument();
    expect(screen.queryByText("22회")).not.toBeInTheDocument();
    expect(screen.queryByText("11%")).not.toBeInTheDocument();
    expect(screen.queryByText("총 투척 횟수")).not.toBeInTheDocument();
    expect(screen.queryByText("아군 기절 대비 연막 구출률")).not.toBeInTheDocument();
    expect(screen.getByText("근거 확인이 필요한 2개 항목은 판정을 보류했습니다.")).toBeInTheDocument();
    const kindScoreLabel = screen.getAllByText("착한맛 승").find((element) => element.className.includes("text-green-400/60"));
    const spicyScoreLabel = screen.getAllByText("매운맛 승").find((element) => element.className.includes("text-red-400/60"));
    const drawScoreLabel = screen.getAllByText("무승부").find((element) => element.className.includes("text-yellow-400/60"));
    expect(kindScoreLabel?.parentElement).toHaveTextContent("1");
    expect(spicyScoreLabel?.parentElement).toHaveTextContent("0");
    expect(drawScoreLabel?.parentElement).toHaveTextContent("0");
    const validKindIssue = screen.getByRole("button", { name: /1:1 결정력/ }).parentElement;
    expect(validKindIssue?.querySelector('[class*="ring-green-"]')).not.toBeNull();
    expect(validKindIssue?.querySelector('[class*="ring-red-"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /1:1 결정력/ }));
    fireEvent.click(screen.getByRole("button", { name: /두 번째 질문/ }));
    expect(screen.getByText("이 항목의 비교 근거를 표시할 수 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("VS")).not.toBeInTheDocument();
    const pendingIssue = screen.getByRole("button", { name: /두 번째 질문/ }).parentElement;
    expect(pendingIssue?.querySelector('[class*="ring-"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /세 번째 질문/ }));
    expect(screen.getByText("이 항목의 비교 근거를 표시할 수 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("VS")).not.toBeInTheDocument();
  });

  it("전부 빈 증거인 세 카드의 저장된 winner를 집계하지 않고 판정 보류로 표시한다", async () => {
    const onSummaryChange = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { overallTier: "A" } },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "fixture verdict", tier: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));

    expect(screen.getAllByText("판정 보류")).toHaveLength(3);
    expect(screen.getByText("근거 확인이 필요한 3개 항목은 판정을 보류했습니다.")).toBeInTheDocument();
    const kindScoreLabel = screen.getAllByText("착한맛 승").find((element) => element.className.includes("text-green-400/60"));
    const spicyScoreLabel = screen.getAllByText("매운맛 승").find((element) => element.className.includes("text-red-400/60"));
    const drawScoreLabel = screen.getAllByText("무승부").find((element) => element.className.includes("text-yellow-400/60"));
    expect(kindScoreLabel?.parentElement).toHaveTextContent("0");
    expect(spicyScoreLabel?.parentElement).toHaveTextContent("0");
    expect(drawScoreLabel?.parentElement).toHaveTextContent("0");
  });

  it("유효한 매운맛 승리 카드는 매운맛 코치만 강조한다", async () => {
    const onSummaryChange = vi.fn();
    const spicyFixture = {
      ...aiReady,
      debateIssues: aiReady.debateIssues.map((issue, index) => index === 0
        ? {
          ...issue,
          topic: "1:1 결정력",
          question: "정확한 지표만 비교하는가?",
          winner: "spicy",
          userStats: [{ label: "1:1 교전 승률", value: "79%" }],
          benchmarkStats: [{ label: "상위권 1:1 승률", value: "61%" }],
        }
        : issue),
    };
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { overallTier: "A" } },
      { type: "final", data: JSON.stringify(spicyFixture) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "fixture verdict", tier: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    fireEvent.click(screen.getByRole("button", { name: /1:1 결정력/ }));

    const validSpicyIssue = screen.getByRole("button", { name: /1:1 결정력/ }).parentElement;
    expect(validSpicyIssue?.querySelector('[class*="ring-red-"]')).not.toBeNull();
    expect(validSpicyIssue?.querySelector('[class*="ring-green-"]')).toBeNull();
  });

  it("trailing newline이 없는 complete final+done NDJSON도 성공으로 처리한다", async () => {
    const onSummaryChange = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponseWithoutTrailingNewline([
      { type: "visuals", data: { overallTier: "A" } },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith(null));

    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "fixture verdict", tier: "A" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("done(valid:true)의 malformed/missing final payload는 partial 상태를 지우고 한 번 재시도한다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ndjsonResponse([
        { type: "visuals", data: { roleInfo: { title: "Partial malformed visual" } } },
        { type: "final", data: "not-json" },
        { type: "done", valid: true },
      ]))
      .mockResolvedValueOnce(ndjsonResponse([
        { type: "visuals", data: { roleInfo: { title: "Partial missing visual" } } },
        { type: "final", data: "{}" },
        { type: "done", valid: true },
      ]));
    vi.stubGlobal("fetch", fetchMock);
    const onSummaryChange = vi.fn();
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Partial malformed visual")).not.toBeInTheDocument();
    expect(onSummaryChange.mock.calls.every(([summary]) => summary === null)).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "다시 시도하기" })).toBeInTheDocument();
    expect(screen.queryByText("Partial missing visual")).not.toBeInTheDocument();
    expect(onSummaryChange.mock.calls.every(([summary]) => summary === null)).toBe(true);
  });

  it("done(valid:true)의 partial finalVerdict payload는 전체 strict normalizer에서 거부한다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ndjsonResponse([
        { type: "final", data: JSON.stringify({ finalVerdict: "partial only" }) },
        { type: "done", valid: true },
      ]))
      .mockResolvedValueOnce(ndjsonResponse([
        { type: "final", data: JSON.stringify({ finalVerdict: "partial retry" }) },
        { type: "done", valid: true },
      ]));
    const onSummaryChange = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("partial only")).not.toBeInTheDocument();
    expect(onSummaryChange.mock.calls.every(([summary]) => summary === null)).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "다시 시도하기" })).toBeInTheDocument();
  });

  it("strict final이 유효해도 route-owned visuals가 없으면 성공 UI로 전환하지 않는다", async () => {
    vi.useFakeTimers();
    const providerVisuals = { roleInfo: { title: "Provider forged visual" } };
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "final", data: JSON.stringify({ ...aiReady, visuals: providerVisuals }) },
      { type: "done", valid: true },
    ]));
    const onSummaryChange = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Provider forged visual")).not.toBeInTheDocument();
    expect(onSummaryChange.mock.calls.every(([summary]) => summary === null)).toBe(true);
  });

  it("provider final의 visuals는 route-owned visuals를 덮어쓰지 않는다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { roleInfo: { title: "Route-owned visual" }, overallTier: "A" } },
      { type: "final", data: JSON.stringify({ ...aiReady, visuals: { roleInfo: { title: "Provider forged visual" }, overallTier: "S" } }) },
      { type: "done", valid: true },
    ]));
    const onSummaryChange = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "fixture verdict", tier: "A" }));
    expect(screen.getAllByText("Route-owned visual").length).toBeGreaterThan(0);
    expect(screen.queryByText("Provider forged visual")).not.toBeInTheDocument();
  });

  it("done 없이 abrupt EOF가 발생하면 한 번 재시도하고 성공 응답만 snapshot으로 배출한다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ndjsonResponse([{ type: "final", data: JSON.stringify(aiReady) }]))
      .mockResolvedValueOnce(ndjsonResponse([
        { type: "visuals", data: { overallTier: "A" } },
        { type: "final", data: JSON.stringify(aiReady) },
        { type: "done", valid: true },
      ]));
    vi.stubGlobal("fetch", fetchMock);
    const onSummaryChange = vi.fn();
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onSummaryChange.mock.calls).toEqual([[null]]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "fixture verdict", tier: "A" });
  });

  it("retry exhaustion 후 done(valid:false)의 partial visuals/text를 남기지 않고 error CTA만 표시한다", async () => {
    vi.useFakeTimers();
    const failedResponse = () => ndjsonResponse([
      { type: "visuals", data: { roleInfo: { title: "Partial failure visual" } } },
      { type: "chunk", data: "Partial failure text" },
      { type: "done", valid: false, error: "fatal", retryable: true },
    ]);
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => failedResponse())
      .mockImplementationOnce(async () => failedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const onSummaryChange = vi.fn();
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "다시 시도하기" })).toBeInTheDocument();
    expect(screen.queryByText("Partial failure visual")).not.toBeInTheDocument();
    expect(screen.queryByText("Partial failure text")).not.toBeInTheDocument();
    expect(onSummaryChange.mock.calls.every(([summary]) => summary === null)).toBe(true);
  });

  it("취소를 무시한 A의 late finally가 B의 loading·global lock·snapshot 소유권을 풀지 않는다", async () => {
    const requestA = deferredReaderResponse();
    const requestB = deferredReaderResponse();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(requestA.response)
      .mockResolvedValueOnce(requestB.response);
    const onSummaryChange = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const view = render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(await screen.findByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    view.rerender(createElement(RecentAISummary, {
      ...baseProps,
      platform: "kakao",
      matchIds: ["match-b"],
      onSummaryChange,
    }));
    fireEvent.click(await screen.findByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => requestA.settleDone());

    expect(screen.queryByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(aiState.active).toBe(true);
    expect(stopAnalysis).toHaveBeenCalledTimes(1);
    expect(onSummaryChange).toHaveBeenLastCalledWith(null);
  });

  it("35초를 넘겨 성공한 cold request는 재시도 없이 단 한 번만 POST한다", async () => {
    const fetchMock = vi.fn((_: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(ndjsonResponse([
        { type: "visuals", data: { overallTier: "A" } },
        { type: "final", data: JSON.stringify(aiReady) },
        { type: "done", valid: true },
      ])), 40_000);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onSummaryChange = vi.fn();
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith(null));

    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "fixture verdict", tier: "A" });
  });

  it("retryable canonical-not-ready 409는 bounded retry 한 번 뒤 성공하고 세 번째 POST를 만들지 않는다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "canonical match analysis is not ready",
        errorCode: "PUBG_AI_CANONICAL_NOT_READY",
        retryable: true,
      }), { status: 409, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(ndjsonResponse([
        { type: "visuals", data: { overallTier: "A" } },
        { type: "final", data: JSON.stringify(aiReady) },
        { type: "done", valid: true },
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const onSummaryChange = vi.fn();
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/fixture verdict/)).toBeInTheDocument();
    expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "fixture verdict", tier: "A" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retryable route-timeout 504는 structured retryability로 bounded retry 한 번 뒤 성공한다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "AI summary request timed out",
        errorCode: "PUBG_AI_ROUTE_TIMEOUT",
        retryable: true,
      }), { status: 504, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(ndjsonResponse([
        { type: "visuals", data: { overallTier: "A" } },
        { type: "final", data: JSON.stringify(aiReady) },
        { type: "done", valid: true },
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const onSummaryChange = vi.fn();
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/fixture verdict/)).toBeInTheDocument();
    expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "fixture verdict", tier: "A" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("HTTP-200 streamed timeout error+done은 structured retryability로 한 번만 재시도한다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ndjsonResponse([
        {
          type: "error",
          error: "server failure",
          errorCode: "PUBG_AI_ROUTE_TIMEOUT",
          retryable: true,
        },
        {
          type: "done",
          valid: false,
          error: "server failure",
          errorCode: "PUBG_AI_ROUTE_TIMEOUT",
          retryable: true,
        },
      ]))
      .mockResolvedValueOnce(ndjsonResponse([
        { type: "visuals", data: { overallTier: "A" } },
        { type: "final", data: JSON.stringify(aiReady) },
        { type: "done", valid: true },
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const onSummaryChange = vi.fn();
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "다시 시도하기" })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/fixture verdict/)).toBeInTheDocument();
    expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "fixture verdict", tier: "A" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("error CTA는 retry state를 초기화하고 새 POST를 직접 실행한다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not retryable" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(ndjsonResponse([
        { type: "visuals", data: { overallTier: "A" } },
        { type: "final", data: JSON.stringify(aiReady) },
        { type: "done", valid: true },
      ]));
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(RecentAISummary, { ...baseProps }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "다시 시도하기" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "다시 시도하기" }));
    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/fixture verdict/)).toBeInTheDocument();
  });

  it("v2 cards가 final보다 먼저 도착하면 스트림 중에는 AI 해석 준비 중을 표시한다", async () => {
    const stream = controlledStreamResponse();
    const fetchMock = vi.fn().mockResolvedValue(stream.response);
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange: vi.fn() }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    stream.push({ type: "visuals", data: { overallTier: "A" } });
    stream.push({ type: "cards", data: buildV2Cards() });
    await waitFor(() => expect(screen.getByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    fireEvent.click(screen.getByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ }));
    expect(screen.getAllByText("AI 해석 준비 중").length).toBeGreaterThan(0);

    stream.push({ type: "final", data: JSON.stringify({
      schemaVersion: 2,
      cards: readyV2Cards(),
      finalVerdict: "v2 pending done",
    }) });
    stream.push({ type: "done", valid: true });
    stream.close();
    await waitFor(() => expect(screen.getByText(/v2 pending done/)).toBeInTheDocument());
  });

  it("v2 final은 카드 evidence ID를 직접 렌더링하고 user-only/unavailable 행에 VS를 만들지 않는다", async () => {
    const onSummaryChange = vi.fn();
    const cards = readyV2Cards();
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { overallTier: "A" } },
      { type: "cards", data: buildV2Cards() },
      {
        type: "final",
        data: JSON.stringify({
          schemaVersion: 2,
          cards,
          signature: "v2 fixture",
          signatureSub: "v2 fixture reason",
          finalVerdict: "v2 fixture verdict",
          actionItems: [{ icon: "target", title: "v2 목표", desc: "근거를 확인하세요." }],
        }),
      },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));

    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "v2 fixture verdict", tier: "A" }));
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({
        matchIds: baseProps.matchIds,
        nickname: baseProps.nickname,
        platform: baseProps.platform,
        force: true,
        summaryContractVersion: 2,
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    const kindScoreLabel = screen.getAllByText("착한맛 승").find((element) => element.className.includes("text-green-400/60"));
    expect(kindScoreLabel?.parentElement).toHaveTextContent("1");
    expect(screen.getByText("근거 확인이 필요한 2개 항목은 판정을 보류했습니다.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ }));
    expect(screen.getByText(/화력 근거를 확인했습니다/)).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.getByText("250")).toBeInTheDocument();
    expect(screen.getByText("VS")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /교전 주도권에 대한 두 코치의 평가는/ }));
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getAllByText("비교 자료 없음").length).toBeGreaterThan(0);
    expect(screen.queryByText("VS")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /포지셔닝에 대한 두 코치의 평가는/ }));
    expect(screen.getAllByText("고립 교전 표본 부족").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /포지셔닝에 대한 두 코치의 평가/ }).parentElement).not.toHaveTextContent(/0(?:%|회| HP)/);
  });

  it("v2 cards facts는 done 실패에도 남고 AI 해석 불가 및 재시도 CTA를 함께 표시한다", async () => {
    const onSummaryChange = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { overallTier: "A" } },
      { type: "cards", data: buildV2Cards() },
      { type: "error", error: "provider unavailable", retryable: false },
      { type: "done", valid: false, error: "provider unavailable", retryable: false },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("AI 해석을 표시할 수 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도하기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ })).toBeInTheDocument();
    expect(onSummaryChange.mock.calls.every(([summary]) => summary === null)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    fireEvent.click(screen.getByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ }));
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.getByText("250")).toBeInTheDocument();
  });

  it("v2 terminal partial final은 유효한 카드 해석을 보존하고 invalid 카드는 unavailable로 남긴다", async () => {
    const onSummaryChange = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { overallTier: "A" } },
      { type: "cards", data: buildV2Cards() },
      {
        type: "final",
        data: JSON.stringify({ schemaVersion: 2, cards: readyV2Cards() }),
      },
      { type: "done", valid: false, error: "one card rejected", retryable: false },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    fireEvent.click(screen.getByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ }));
    expect(screen.getByText(/화력 근거를 확인했습니다/)).toBeInTheDocument();
    expect(screen.getByText("근거 확인이 필요한 2개 항목은 판정을 보류했습니다.")).toBeInTheDocument();
    expect(onSummaryChange.mock.calls.every(([summary]) => summary === null)).toBe(true);
  });

  it("v2 done 성공에도 최종 카드가 pending이면 AI 성공으로 처리하지 않고 사실을 보존한다", async () => {
    vi.useFakeTimers();
    const onSummaryChange = vi.fn();
    const cards = readyV2Cards();
    cards[1] = buildV2Cards()[1];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { overallTier: "A" } },
      { type: "cards", data: buildV2Cards() },
      { type: "final", data: JSON.stringify({ schemaVersion: 2, cards, finalVerdict: "미완성 판결" }) },
      { type: "done", valid: true },
    ])));
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText("미완성 판결")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ })).toBeInTheDocument();
    expect(onSummaryChange.mock.calls.every(([summary]) => summary === null)).toBe(true);
    expect(screen.getByText(/분석 결과가 불완전해요/)).toBeInTheDocument();
  });

  it("v2 facts-only 응답에 visuals가 없으면 누락된 통계 수치를 0으로 만들지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "cards", data: buildV2Cards() },
      { type: "done", valid: false, error: "해석 실패", retryable: false },
    ])));
    render(createElement(RecentAISummary, { ...baseProps }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    fireEvent.click(screen.getByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ }));

    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.queryByText("선제 타격 효율")).not.toBeInTheDocument();
    expect(screen.queryByText("0.00s")).not.toBeInTheDocument();
    expect(screen.queryByText("0 Ph")).not.toBeInTheDocument();
  });

  it("플레이어 변경 직후 reset effect 전에도 이전 플레이어의 v2 카드가 보이지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "cards", data: buildV2Cards() },
      { type: "done", valid: false, error: "해석 실패", retryable: false },
    ])));
    let beforePassiveReset = "";
    function ObservePaint({ nickname }: { nickname: string }) {
      const root = useRef<HTMLDivElement>(null);
      useLayoutEffect(() => { beforePassiveReset = root.current?.textContent ?? ""; }, [nickname]);
      return createElement("div", { ref: root }, createElement(RecentAISummary, { ...baseProps, nickname }));
    }
    const view = render(createElement(ObservePaint, { nickname: "Player_A" }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ })).toBeInTheDocument();

    view.rerender(createElement(ObservePaint, { nickname: "Player_B" }));
    expect(beforePassiveReset).not.toContain("화력은 비슷한 조건 평균과 비교해 어떤가?");
    expect(screen.queryByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ })).not.toBeInTheDocument();
  });
});
