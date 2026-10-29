// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, useLayoutEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import aiReady from "./fixtures/stats/ai-ready.json";

const { aiState, startAnalysis, stopAnalysis, spiderChartProps, authState } = vi.hoisted(() => ({
  authState: { user: { id: "fixture-user" } as { id: string } | null },
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
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => authState }));
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
import { buildSummaryCardEvidence } from "@/lib/pubg-analysis/aiSummaryCardEvidence";

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
  it.each([
    [410, "PUBG_MATCH_DETAIL_EXPIRED", "분석할 경기의 상세 제공 기간이 지났습니다.", "전적 갱신"],
    [409, "PUBG_AI_CANONICAL_NOT_READY", "최근 경기의 분석 데이터가 아직 준비되지 않았습니다.", "상세 분석"],
  ])('shows a data-specific error for %s/%s', async (status, errorCode, title, detail) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({errorCode,error:"data unavailable"}), {status,headers:{"Content-Type":"application/json"}})));
    render(createElement(RecentAISummary, baseProps));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(detail))).toBeInTheDocument();
    expect(screen.queryByText("서버가 바쁘거나 네트워크가 불안정할 때 가끔 생겨요.")).not.toBeInTheDocument();
  });
  it("MiaeQ_Q utility observations show the population and separate attempts from successes", async () => {
    const cards = buildSummaryCards({
      topics: ["화력", "유틸리티 활용", "포지셔닝"],
      context: { ...v2Context, gameMode: "duo", tier: "B", userMatchCount: 4, benchmarkSampleCount: 42 },
      evidence: buildSummaryCardEvidence({
        avgDamage: 228, totalUtilityThrows: 17, totalObservedSmokes: 8, totalLethalThrows: 8,
        metricMatchCounts: { damage_average: 2, utility_throws: 4, smoke_opportunity_rate: 4 },
        totalObservedRescueSmokes: 1, totalTeammateKnocks: 3, totalSmokeRescues: 0, avgIsolationStr: "1.4",
      }, { sampleCount: 42, avgDamage: 203, avgSmokeRate: 5.55555555555556, metricSampleCounts: { avgDamage: 42, avgSmokeRate: 36 } }),
    }).map((card): SummaryCard => ({ ...card, analysisStatus: "ready", winner: card.dataStatus === "comparable" ? "kind" : null,
      kindOpinion: "관측된 사용 기록을 확인했습니다.", spicyOpinion: "다음 경기에서 구출 연계를 점검하세요.", reason: "근거를 확인했습니다.", evaluation: "기록을 바탕으로 평가했습니다." }));
    const onSummaryChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { overallTier: "B", latestMatchCount: 10, bestMatchCount: 5 } },
      { type: "cards", data: cards },
      { type: "final", data: JSON.stringify({ schemaVersion: 2, cards, finalVerdict: "구출 연계를 점검하세요." }) },
      { type: "done", valid: true },
    ])));
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "구출 연계를 점검하세요.", tier: "B", latestMatchCount: 10, bestMatchCount: 5, analysisMatchCount: 4, analysisScope: "듀오 · 경쟁전" }));
    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    fireEvent.click(screen.getByRole("button", { name: /유틸리티 활용에 대한 두 코치의 평가는/ }));
    expect(screen.getByText("최근 10경기 중 점수 상위 5경기에서 선택한 듀오 · 경쟁전 4경기 기준")).toBeInTheDocument();
    expect(screen.getByText("선택된 4경기 중 4경기 기록 확인 · 비교 표본 36건")).toBeInTheDocument();
    expect(screen.getByText("17회")).toBeInTheDocument();
    expect(screen.getByText("연막 사용 8회 · 피해형 투척 8회")).toBeInTheDocument();
    expect(screen.getByText("아군 기절 3회 · 연막 구출 성공 0회 · 구출 연막 시도 1회")).toBeInTheDocument();
    expect(screen.getByText("5.6%")).toBeInTheDocument();
    expect(screen.queryByText("비교 자료 없음")).not.toBeInTheDocument();
  });

  beforeEach(() => {
    authState.user = { id: "fixture-user" };
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
    expect(normalizeRouteOwnedVisuals({ calculationPendingCount: 2.8 })).toMatchObject({
      calculationPendingCount: 2,
    });
    expect(normalizeRouteOwnedVisuals({ tierScope: "solo", tierMatchCount: 2 })).toMatchObject({ tierScope: "solo", tierMatchCount: 2 });
    expect(normalizeRouteOwnedVisuals({ tierScope: "duo" })?.tierScope).toBeUndefined();
    expect(normalizeRouteOwnedVisuals({ roleInfo: { title: "결투의 제왕", evidence: ["1:1 승률 상위 3%", 7, "a", "b", "c"], badges: "차량 교전" } })?.roleInfo)
      .toEqual({ title: "결투의 제왕", evidence: ["1:1 승률 상위 3%", "a", "b", "c"] });
  });

  it("칭호 아래에 근거 한 줄과 배지를 표시한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { overallTier: "A", roleInfo: {
        primaryRole: "executor", secondaryRole: null, title: "결투의 제왕", roleLabel: "처형자 (Executor)",
        description: "1:1 교전을 끝까지 이겨 냅니다.", evidence: ["1:1 승률 상위 3%", "역전 승률 상위 5%"], badges: ["차량 교전", "M416 주력"],
        signatureWeapon: "M416", scores: { executor: 97.5 },
      } } },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, baseProps));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await screen.findAllByText("결투의 제왕");
    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    expect(screen.getByLabelText("칭호 근거")).toHaveTextContent("1:1 승률 상위 3% · 역전 승률 상위 5%");
    expect(screen.getByText("차량 교전")).toBeInTheDocument();
    expect(screen.getByText("M416 주력")).toBeInTheDocument();
    // 경기 수를 받지 못한 옛 응답은 범위를 추정해 표시하지 않는다.
    expect(screen.queryByTestId("role-scope")).toBeNull();
  });

  it("확정 칭호도 판정에 쓴 경기 범위를 보여 주고 칭호 문구는 바꾸지 않는다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { overallTier: "A", latestMatchCount: 10, bestMatchCount: 5, roleInfo: {
        primaryRole: "mainGun", secondaryRole: null, title: "화력의 중심", roleLabel: "팀의 주포 (Main Gun)",
        description: "팀 전체 피해 중 큰 몫을 직접 넣습니다.", evidence: ["팀 내 피해 비중 상위 10%"], badges: [],
        signatureWeapon: "M416", scores: { mainGun: 89.5 },
        verdict: { kind: "confirmed", headline: "", label: "", detail: "", note: "", observations: [] },
      } } },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, baseProps));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await screen.findAllByText("화력의 중심");
    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    expect(screen.getByTestId("role-title")).toHaveTextContent("화력의 중심");
    expect(screen.getByTestId("role-label")).toHaveTextContent("팀의 주포 (Main Gun)");
    expect(screen.getByTestId("role-description")).toHaveTextContent("팀 전체 피해 중 큰 몫을 직접 넣습니다.");
    expect(screen.getByTestId("role-scope")).toHaveTextContent("칭호 판정: 최근 유효 10판 중 점수 상위 5판");
    expect(screen.queryByTestId("role-note")).toBeNull();
    expect(screen.queryByTestId("role-observations")).toBeNull();
  });

  it("칭호 판정 상태는 형식이 맞는 서버 값만 받는다", () => {
    const below = { kind: "below_threshold", headline: "뚜렷한 대표 역할 없음", label: "칭호 기준 미달 · 판정 역할 6/12", detail: "점수 상위 1판에서 판정한 역할 6개 중", observations: ["미끼 플레이 상위 20%", 3, "a", "b"] };
    expect(normalizeRouteOwnedVisuals({ roleInfo: { title: "균형형 전술가", verdict: below } })?.roleInfo)
      .toEqual({ title: "균형형 전술가", verdict: { ...below, note: "", observations: ["미끼 플레이 상위 20%", "a"] } });
    // 필수 문구가 없거나 모르는 상태면 버린다(기존 칭호 문구를 유지한다).
    expect((normalizeRouteOwnedVisuals({ roleInfo: { title: "균형형 전술가", verdict: { ...below, detail: "" } } })?.roleInfo as any)?.verdict).toBeUndefined();
    expect((normalizeRouteOwnedVisuals({ roleInfo: { title: "균형형 전술가", verdict: { ...below, kind: "unknown" } } })?.roleInfo as any)?.verdict).toBeUndefined();
    expect((normalizeRouteOwnedVisuals({ roleInfo: { title: "균형형 전술가", verdict: { kind: "insufficient", headline: "판정할 기록 부족", label: "근거 수집 중", detail: "점수 상위 3판", observations: ["x"] } } })?.roleInfo as any)?.verdict)
      .toEqual({ kind: "insufficient", headline: "판정할 기록 부족", label: "근거 수집 중", detail: "점수 상위 3판", note: "", observations: [] });
  });

  it.each([
    ["기준 미달", { primaryRole: "balanced", title: "균형형 전술가", roleLabel: "균형형", description: "특정 역할이 다른 플레이어보다 두드러지지 않습니다. 여러 상황을 고르게 경험하고 있습니다." },
      { kind: "below_threshold", headline: "뚜렷한 대표 역할 없음", label: "칭호 기준 미달 · 판정 역할 6/12", detail: "점수 상위 1판에서 판정한 역할 6개 모두 칭호 기준 85점(상위 15%)에 못 미쳤습니다(최고: 미끼 전술가 43.9).", note: "판정에 필요한 기록이 부족하거나 없는 역할 5개, 비교 기준이 아직 준비되지 않은 역할 1개는 판정하지 않았습니다.", observations: ["미끼 플레이 상위 20%"] }],
    ["기록 부족", { primaryRole: "insufficient", title: "전술 분석 중", roleLabel: "근거 수집 중", description: "역할을 판정할 만큼 교전·팀 기록이 쌓이지 않았습니다." },
      { kind: "insufficient", headline: "판정할 기록 부족", label: "근거 수집 중 · 판정 역할 0/12", detail: "점수 상위 1판에서 칭호를 판정할 만큼 기록이 쌓인 역할이 없습니다.", note: "", observations: [] }],
  ])("%s 상태는 서버 판정 설명으로 제목·라벨·설명을 바꾸고 관측 성향을 칭호와 구분한다", async (_name, role, verdict) => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { overallTier: "B", latestMatchCount: 1, bestMatchCount: 1, roleInfo: { ...role, secondaryRole: null, evidence: [], badges: [], signatureWeapon: "M416", scores: {}, verdict } } },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, baseProps));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await screen.findAllByText(verdict.headline);
    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    expect(screen.getByTestId("role-title")).toHaveTextContent(verdict.headline);
    expect(screen.getByTestId("role-label")).toHaveTextContent(verdict.label);
    // 단판 요약도 칭호 판정에 쓴 실제 경기 수를 그대로 보여 준다.
    expect(screen.getByTestId("role-scope")).toHaveTextContent("칭호 판정: 최근 유효 1판 중 점수 상위 1판");
    expect(screen.getByTestId("role-description")).toHaveTextContent(verdict.detail);
    if (verdict.note) expect(screen.getByTestId("role-note")).toHaveTextContent(verdict.note);
    else expect(screen.queryByTestId("role-note")).toBeNull();
    expect(document.body.textContent).not.toContain(role.title);
    expect(document.body.textContent).not.toContain("여러 상황을 고르게 경험");
    if (verdict.observations.length > 0) expect(screen.getByTestId("role-observations")).toHaveTextContent("관측 성향(칭호 아님): 미끼 플레이 상위 20%");
    else expect(screen.queryByTestId("role-observations")).toBeNull();
  });

  it("판정 상태가 없는 옛 응답이나 대표 역할과 맞지 않는 상태는 기존 칭호 문구를 그대로 쓴다", async () => {
    const legacyRole = { primaryRole: "balanced", secondaryRole: null, title: "균형형 전술가", roleLabel: "균형형", description: "특정 역할이 다른 플레이어보다 두드러지지 않습니다.", evidence: [], badges: [], signatureWeapon: "M416", scores: {} };
    for (const roleInfo of [
      legacyRole,
      // 확정 칭호에 비확정 상태가 붙어 와도 칭호를 덮지 않는다.
      { ...legacyRole, primaryRole: "executor", title: "결투의 제왕", roleLabel: "처형자 (Executor)", description: "1:1 교전을 끝까지 이겨 냅니다.",
        verdict: { kind: "below_threshold", headline: "뚜렷한 대표 역할 없음", label: "칭호 기준 미달", detail: "잘못 붙은 설명", observations: ["x"] } },
    ]) {
      cleanup();
      const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
        { type: "visuals", data: { overallTier: "B", roleInfo } },
        { type: "final", data: JSON.stringify(aiReady) },
        { type: "done", valid: true },
      ]));
      vi.stubGlobal("fetch", fetchMock);
      render(createElement(RecentAISummary, baseProps));
      fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
      await screen.findAllByText(roleInfo.title);
      fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
      expect(screen.getByTestId("role-label")).toHaveTextContent(roleInfo.roleLabel);
      expect(screen.getByTestId("role-description")).toHaveTextContent(roleInfo.description);
      expect(document.body.textContent).not.toMatch(/뚜렷한 대표 역할 없음|잘못 붙은 설명|관측 성향/);
    }
  });

  it("잠재 티어는 평균에 쓴 경기 수와 솔로 기준 여부를 표시한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { latestMatchCount: 3, bestMatchCount: 3, tierMatchCount: 2, tierScope: "solo", overallTier: "A" } },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, baseProps));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    expect(await screen.findByText("점수 상위 2판 · 솔로 기준 잠재 티어")).toBeInTheDocument();
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

  it("계산 업데이트 대기 매치 수를 최근 요약 범위 안내에 표시한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { overallTier: "A", calculationPendingCount: 2 } },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ])));
    render(createElement(RecentAISummary, { ...baseProps }));

    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    expect(await screen.findByText("새 계산 기준 확인이 필요한 2경기는 분석에서 제외했습니다.")).toBeInTheDocument();
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

    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "fixture verdict", tier: "A", latestMatchCount: 3, bestMatchCount: 3 }));
    expect(onSummaryChange.mock.calls).toEqual([
      [null],
      [{ verdict: "fixture verdict", tier: "A", latestMatchCount: 3, bestMatchCount: 3 }],
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
          tierBreakdown: { combat: 32, tactical: 21, survival: 20, total: 73 },
          tierScope: "team", tierMatchCount: 3,
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
      data: { combat: 32, tactical: 21, survival: 20 },
      bestMatchCount: 3, tierScope: "team",
    });
    expect(spiderChartProps.current?.data).not.toHaveProperty("growth");
    expect(spiderChartProps.current?.data).not.toHaveProperty("vision");
    expect(spiderChartProps.current?.data).not.toHaveProperty("teamwork");
  });

  it("분석 전에는 새로 확인된 최근 경기를 바로 반영하고, 결과가 있으면 안내 후 사용자가 반영할 때만 새 목록으로 바꾼다", async () => {
    const idleApply = vi.fn();
    const idle = render(createElement(RecentAISummary, { ...baseProps, pendingMatchCount: 1, onApplyPendingMatches: idleApply }));
    await waitFor(() => expect(idleApply).toHaveBeenCalledTimes(1));
    idle.unmount();

    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { overallTier: "A" } },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const onSummaryChange = vi.fn();
    // 실제 부모처럼 AI 입력과 최근 목록을 state로 들고, 반영하면 AI 입력을 바꾼다.
    let addRecentMatch: (() => void) | null = null;
    function Parent() {
      const [aiIds, setAiIds] = useState<readonly string[]>(["match-1", "match-2"]);
      const [recentIds, setRecentIds] = useState<readonly string[]>(["match-1", "match-2"]);
      addRecentMatch = () => setRecentIds(["match-0", "match-1", "match-2"]);
      return createElement(RecentAISummary, { ...baseProps, matchIds: aiIds, onSummaryChange,
        pendingMatchCount: recentIds.filter((id) => !aiIds.includes(id)).length,
        onApplyPendingMatches: () => setAiIds(recentIds) });
    }
    render(createElement(Parent));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith(expect.objectContaining({ verdict: "fixture verdict" })));

    act(() => addRecentMatch!());
    const notice = "새로 저장된 최근 경기 1개가 있습니다. 현재 분석은 이전 경기 목록 기준이며, 반영하면 현재 결과를 닫고 다시 분석할 수 있습니다.";
    expect(await screen.findByText(notice)).toBeInTheDocument();
    expect(onSummaryChange).not.toHaveBeenLastCalledWith(null);

    fireEvent.click(screen.getByRole("button", { name: "최신 경기 반영하기" }));
    // 새 목록으로 바뀌면 이전 결과와 안내를 닫고 시작 버튼으로 돌아간다. 자동으로 다시 요청하지 않는다.
    expect(await screen.findByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ })).toBeInTheDocument();
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    expect(onSummaryChange).toHaveBeenLastCalledWith(null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).matchIds).toEqual(["match-1", "match-2"]);

    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).matchIds).toEqual(["match-0", "match-1", "match-2"]);
  });

  it("측정 불가 축은 0으로 바꾸지 않고 총점·나머지 축과 함께 SpiderChart와 티어 설명에 전달한다", async () => {
    expect(normalizeRouteOwnedVisuals({ tierBreakdown: { combat: 0, tactical: null, survival: "12.5", total: 30 } })?.tierBreakdown)
      .toEqual({ combat: 0, tactical: null, survival: 12.5, total: 30 });
    // 모든 축이 측정 불가여도 유효한 총점은 보존한다. 총점 자체가 없거나 범위를 벗어나면 버린다.
    expect(normalizeRouteOwnedVisuals({ tierBreakdown: { combat: null, tactical: undefined, survival: "", total: 50 } })?.tierBreakdown)
      .toEqual({ combat: null, tactical: null, survival: null, total: 50 });
    expect(normalizeRouteOwnedVisuals({ tierBreakdown: { combat: false, tactical: true, survival: [42], total: "0" } })?.tierBreakdown)
      .toEqual({ combat: null, tactical: null, survival: null, total: 0 });
    expect(normalizeRouteOwnedVisuals({ tierBreakdown: { combat: 0, tactical: "0", survival: 1, total: null } })?.tierBreakdown).toBeUndefined();
    expect(normalizeRouteOwnedVisuals({ tierBreakdown: { combat: 0, tactical: 0, survival: 0, total: 101 } })?.tierBreakdown).toBeUndefined();
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      {
        type: "visuals",
        data: {
          overallTier: "C+",
          tierBreakdown: { combat: 15, tactical: 0, survival: null, total: 30 },
          tierScope: "team", tierMatchCount: 3,
          roleInfo: { primaryRole: "balanced", secondaryRole: null, title: "균형형 전술가", roleLabel: "균형형", description: "fixture", signatureWeapon: "M416", scores: {} },
        },
      },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange: vi.fn() }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    await waitFor(() => expect(spiderChartProps.current).not.toBeNull());
    expect(spiderChartProps.current).toMatchObject({ data: { combat: 15, tactical: 0, survival: null }, bestMatchCount: 3, tierScope: "team" });
    fireEvent.mouseEnter(screen.getByRole("button", { name: /잠재 티어 산정 방법 보기/ }).parentElement!);
    // 다른 카드도 "측정 불가"를 쓸 수 있으므로 티어 설명의 해당 행만 확인한다.
    await screen.findByText("생존 점수");
    expect(screen.getByText("생존 점수").nextElementSibling?.textContent).toBe("측정 불가");
    expect(screen.getByText("전술 점수").nextElementSibling?.textContent).toBe("0");
    expect(document.body.textContent).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("세 축이 모두 측정 불가여도 유효 총점 50은 그대로 표시하고 완성 도형은 그리지 않는다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      {
        type: "visuals",
        data: {
          overallTier: "B+",
          tierBreakdown: { combat: null, tactical: null, survival: null, total: 50 },
          tierScope: "team", tierMatchCount: 3,
          roleInfo: { primaryRole: "balanced", secondaryRole: null, title: "균형형 전술가", roleLabel: "균형형", description: "fixture", signatureWeapon: "M416", scores: {} },
        },
      },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange: vi.fn() }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    await waitFor(() => expect(spiderChartProps.current).not.toBeNull());
    expect(spiderChartProps.current).toMatchObject({ data: { combat: null, tactical: null, survival: null }, bestMatchCount: 3, tierScope: "team" });
    fireEvent.mouseEnter(screen.getByRole("button", { name: /잠재 티어 산정 방법 보기/ }).parentElement!);
    await screen.findByText("교전 점수");
    for (const label of ["교전 점수", "전술 점수", "생존 점수"]) expect(screen.getByText(label).nextElementSibling?.textContent).toBe("측정 불가");
    expect(screen.getByText("잠재 점수").nextElementSibling?.textContent).toBe("50");
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
    expect(screen.getByText("2개 항목은 비교 근거가 부족하거나 한쪽 판단을 지지하기 어려워 판정을 보류했습니다.")).toBeInTheDocument();
    const kindScoreLabel = screen.getAllByText("착한맛 승").find((element) => element.className.includes("text-green-400/60"));
    const spicyScoreLabel = screen.getAllByText("매운맛 승").find((element) => element.className.includes("text-red-400/60"));
    const drawScoreLabel = screen.getAllByText("장단점 함께").find((element) => element.className.includes("text-yellow-400/60"));
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
    expect(screen.getByText("3개 항목은 비교 근거가 부족하거나 한쪽 판단을 지지하기 어려워 판정을 보류했습니다.")).toBeInTheDocument();
    const kindScoreLabel = screen.getAllByText("착한맛 승").find((element) => element.className.includes("text-green-400/60"));
    const spicyScoreLabel = screen.getAllByText("매운맛 승").find((element) => element.className.includes("text-red-400/60"));
    const drawScoreLabel = screen.getAllByText("장단점 함께").find((element) => element.className.includes("text-yellow-400/60"));
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

  it.each([
    ["malformed", "not-json"],
    ["missing", "{}"],
  ])("done(valid:true)의 %s final payload는 partial 상태를 지우고 자동 재호출하지 않는다", async (label, finalData) => {
    vi.useFakeTimers();
    const visualTitle = `Partial ${label} visual`;
    const fetchMock = vi.fn().mockResolvedValueOnce(ndjsonResponse([
      { type: "visuals", data: { roleInfo: { title: visualTitle } } },
      { type: "final", data: finalData },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const onSummaryChange = vi.fn();
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));

    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(visualTitle)).not.toBeInTheDocument();
    expect(onSummaryChange.mock.calls.every(([summary]) => summary === null)).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /초 후 다시 시도하기/ })).toBeDisabled();
    expect(screen.queryByText(visualTitle)).not.toBeInTheDocument();
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /초 후 다시 시도하기/ })).toBeDisabled();
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

  it("done 없이 abrupt EOF가 발생하면 자동 재호출하지 않고 CTA를 표시한다", async () => {
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "다시 시도하기" })).toBeInTheDocument();
    expect(onSummaryChange.mock.calls).toEqual([[null]]);
  });

  it("done(valid:false)의 partial visuals/text를 남기고 자동 재호출하지 않는다", async () => {
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("retryable canonical-not-ready 409도 자동 POST를 만들지 않는다", async () => {
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "다시 시도하기" })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("계산 지표 업데이트 대기 409는 일시적 장애 문구나 재시도를 표시하지 않는다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "분석 지표 업데이트 준비 중입니다. 기본 전적은 계속 이용할 수 있습니다.",
      errorCode: "PUBG_CALCULATION_UPGRADE_REQUIRED",
      retryable: false,
    }), { status: 409, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(RecentAISummary, { ...baseProps }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });

    expect(screen.getByText("새 계산 기준 확인이 필요한 전적입니다")).toBeInTheDocument();
    expect(screen.getByText(/기본 전적은 계속 확인할 수 있습니다/)).toBeInTheDocument();
    expect(screen.queryByText("AI 분석이 잠깐 막혔어요.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다시 시도하기" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retryable route-timeout 504도 자동 POST를 만들지 않는다", async () => {
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "다시 시도하기" })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("HTTP-200 streamed timeout error+done도 자동 POST를 만들지 않는다", async () => {
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
    expect(screen.getByRole("button", { name: "다시 시도하기" })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "다시 시도하기" })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "v2 fixture verdict", tier: "A", analysisMatchCount: 5, analysisScope: "스쿼드 · 경쟁전" }));
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
    expect(screen.getByText("2개 항목은 비교 근거가 부족하거나 한쪽 판단을 지지하기 어려워 판정을 보류했습니다.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ }));
    expect(screen.getByText(/화력 근거를 확인했습니다/)).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.getByText("250")).toBeInTheDocument();
    expect(screen.getByText("VS")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /교전 주도권에 대한 두 코치의 평가는/ }));
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText(/평균 비교 없이 내 기록을 보여줍니다/)).toBeInTheDocument();
    expect(screen.queryByText("비교 자료 없음")).not.toBeInTheDocument();
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
    expect(screen.getByText("2개 항목은 비교 근거가 부족하거나 한쪽 판단을 지지하기 어려워 판정을 보류했습니다.")).toBeInTheDocument();
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
    expect(screen.getByText("AI 해석을 표시할 수 없습니다.")).toBeInTheDocument();
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
  async function flushStream() {
    for (let index = 0; index < 15; index += 1) await act(async () => { await Promise.resolve(); });
  }

  function partialResponse(remaining = 300, cards = readyV2Cards()) {
    return ndjsonResponse([
      { type: "visuals", data: { overallTier: "A" } },
      { type: "cards", data: buildV2Cards() },
      { type: "final", data: JSON.stringify({ schemaVersion: 2, analysisStatus: "partial", cards,
        retryAfterSeconds: 300, finalVerdict: "확인된 항목만 평가했습니다.", signature: null,
        signatureSub: null, weaknessDiagnostic: null, actionItems: null }) },
      { type: "done", valid: true, partial: true, retryAfterSeconds: remaining },
    ]);
  }

  it("부분 성공은 정상 카드를 보존하고 남은 대기 시간 후 수동 요청만 허용한다", async () => {
    vi.useFakeTimers();
    const stream = controlledStreamResponse();
    const fetchMock = vi.fn().mockResolvedValueOnce(partialResponse(23)).mockResolvedValueOnce(stream.response);
    vi.stubGlobal("fetch", fetchMock);
    const onSummaryChange = vi.fn();
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await flushStream();
    expect(screen.getByRole("status")).toHaveTextContent("일부 해석을 보류했습니다. 확인된 경기 기록과 분석을 표시합니다.");
    expect(screen.getByText(/확인된 항목만 평가했습니다/)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "23초 후 다시 시도하기" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    fireEvent.click(screen.getByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ }));
    expect(screen.getByText(/화력 근거를 확인했습니다/)).toBeInTheDocument();
    expect(screen.getByText("착한맛 지지 항목")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.getByText("250")).toBeInTheDocument();
    expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "확인된 항목만 평가했습니다.", tier: "A", analysisMatchCount: 5, analysisScope: "스쿼드 · 경쟁전" });
    await act(async () => { await vi.advanceTimersByTimeAsync(23_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "다시 시도하기" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도하기" }));
    await flushStream();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stream.push({ type: "cards", data: buildV2Cards() });
    await flushStream();
    expect(screen.getByText(/화력 근거를 확인했습니다/)).toBeInTheDocument();
    // 재시도 중에는 이전 시도의 부분 완료 안내와 결론을 남기지 않는다.
    expect(screen.queryByText(/일부 해석을 보류했습니다/)).not.toBeInTheDocument();
    expect(screen.queryByText(/확인된 항목만 평가했습니다/)).not.toBeInTheDocument();
    stream.close();
    await flushStream();
  });

  it("부분 성공 뒤 재시도가 검증에 실패하면 이전 결론을 남기지 않는다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce(partialResponse(0)).mockResolvedValueOnce(ndjsonResponse([
      { type: "cards", data: buildV2Cards() },
      { type: "done", valid: false, errorCode: "PUBG_AI_VALIDATION_FAILED", retryable: true, retryAfterSeconds: 30 },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, baseProps));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await flushStream();
    expect(screen.getByText(/확인된 항목만 평가했습니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도하기" }));
    await flushStream();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/확인된 항목만 평가했습니다/)).not.toBeInTheDocument();
    expect(screen.queryByText(/일부 해석을 보류했습니다/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "30초 후 다시 시도하기" })).toBeDisabled();
  });

  it.each(["evidence", "context"])("재시도 카드의 %s가 바뀌면 이전 해석을 재사용하지 않는다", async (changedField) => {
    vi.useFakeTimers();
    const stream = controlledStreamResponse();
    const fetchMock = vi.fn().mockResolvedValueOnce(partialResponse(0)).mockResolvedValueOnce(stream.response);
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, baseProps));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await flushStream();
    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    fireEvent.click(screen.getByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ }));
    expect(screen.getByText(/화력 근거를 확인했습니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도하기" }));
    await flushStream();
    const changed = buildV2Cards();
    if (changedField === "evidence") changed[0].evidence[0].userValue = "310";
    if (changedField === "context") changed.forEach((card) => { card.context = { ...card.context, userMatchCount: 6 }; });
    stream.push({ type: "cards", data: changed });
    await flushStream();
    expect(screen.queryByText(/화력 근거를 확인했습니다/)).not.toBeInTheDocument();
    if (changedField === "evidence") expect(screen.getByText("310")).toBeInTheDocument();
    expect(screen.getAllByText("AI 해석 준비 중").length).toBeGreaterThan(0);
    stream.close();
    await flushStream();
  });

  it.each(["nickname", "platform", "matchIds", "user"])("%s 변경은 부분 성공 카드와 대기 상태를 초기화한다", async (changed) => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(partialResponse()));
    const view = render(createElement(RecentAISummary, baseProps));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await flushStream();
    expect(screen.getByRole("button", { name: "300초 후 다시 시도하기" })).toBeDisabled();
    if (changed === "user") authState.user = { id: "another-user" };
    view.rerender(createElement(RecentAISummary, {
      ...baseProps,
      ...(changed === "nickname" ? { nickname: "OtherPlayer" } : {}),
      ...(changed === "platform" ? { platform: "kakao" } : {}),
      ...(changed === "matchIds" ? { matchIds: ["different-match"] } : {}),
    }));
    expect(screen.queryByText(/일부 해석을 보류했습니다/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ })).toBeEnabled();
  });

  it.each(["http", "stream"])("%s 요청 제한은 60초 동안 수동 재시도도 막고 자동 요청을 하지 않는다", async (transport) => {
    vi.useFakeTimers();
    const failure = { error: "quota", errorCode: "PUBG_AI_RATE_LIMITED", retryable: true, retryAfterSeconds: 60 };
    const fetchMock = vi.fn().mockResolvedValue(transport === "http"
      ? new Response(JSON.stringify(failure), { status: 429 })
      : ndjsonResponse([{ type: "cards", data: buildV2Cards() }, { type: "error", ...failure }, { type: "done", valid: false }]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, baseProps));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await flushStream();
    const retry = screen.getByRole("button", { name: "60초 후 다시 시도하기" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "다시 시도하기" })).toBeEnabled();
  });

  it("서버 시간 초과의 대기 시간 30초를 적용한다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "cards", data: buildV2Cards() },
      { type: "done", valid: false, errorCode: "PUBG_AI_ROUTE_TIMEOUT", retryable: true, retryAfterSeconds: 30 },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, baseProps));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await flushStream();
    expect(screen.getByRole("button", { name: "30초 후 다시 시도하기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "다시 시도하기" })).toBeEnabled();
  });

  it.each(["no-ready", "null-cards", "bad-delay"])("부분 성공 %s 응답을 검증 실패로 표시하고 대기 후에만 다시 요청한다", async (invalid) => {
    vi.useFakeTimers();
    const cards = invalid === "null-cards" ? null : invalid === "no-ready"
      ? readyV2Cards().map((card) => ({ ...card, analysisStatus: "unavailable", winner: null })) : readyV2Cards();
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "visuals", data: { overallTier: "A" } },
      { type: "cards", data: buildV2Cards() },
      // 카드 검증과 대기 시간 검증이 서로를 가리지 않도록 bad-delay만 대기 시간을 비운다.
      { type: "final", data: JSON.stringify({ schemaVersion: 2, analysisStatus: "partial", cards, retryAfterSeconds: invalid === "bad-delay" ? null : 300 }) },
      { type: "done", valid: true, partial: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, baseProps));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await flushStream();
    expect(screen.queryByText(/일부 해석을 보류했습니다/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "30초 후 다시 시도하기" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "30초 후 다시 시도하기" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByRole("button", { name: "다시 시도하기" })).toBeEnabled();
  });

  it("서버의 검증 실패도 경기 기록을 보존하고 대기 시간 동안 재시도를 막는다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "cards", data: buildV2Cards() },
      { type: "done", valid: false, errorCode: "PUBG_AI_VALIDATION_FAILED", retryable: true, retryAfterSeconds: 30 },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, baseProps));
    fireEvent.click(screen.getByRole("button", { name: /최근 최대 10경기 AI 끝장 토론 시작/ }));
    await flushStream();
    expect(screen.getByRole("button", { name: "30초 후 다시 시도하기" })).toBeDisabled();
    expect(screen.getByText(/분석 근거를 확인하지 못했습니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "상세 분석 리포트 펼치기" }));
    fireEvent.click(screen.getByRole("button", { name: /화력은 비슷한 조건 평균과 비교해 어떤가/ }));
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.getByText("250")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});
