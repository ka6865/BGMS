// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import aiReady from "./fixtures/stats/ai-ready.json";

const { aiState, startAnalysis, stopAnalysis } = vi.hoisted(() => ({
  aiState: { active: false },
  startAnalysis: vi.fn(() => {
    if (aiState.active) return false;
    aiState.active = true;
    return true;
  }),
  stopAnalysis: vi.fn(() => { aiState.active = false; }),
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
vi.mock("@/components/stat/SpiderChart", () => ({ SpiderChart: () => null }));
vi.mock("@/components/stat/MapKingCard", () => ({ MapKingCard: () => null }));
vi.mock("@/components/common/BgmsIcon", () => ({ BgmsIcon: () => createElement("span", { "aria-hidden": true }) }));
vi.mock("@/components/common/InlineIconLabel", () => ({ InlineIconLabel: ({ children }: { children: unknown }) => children }));

import { RecentAISummary } from "@/components/stat/RecentAISummary";

function ndjsonResponse(lines: readonly unknown[]): Response {
  return new Response(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, {
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

const baseProps = {
  matchIds: ["match-1", "match-2"] as readonly string[],
  nickname: "FixturePlayer",
  platform: "steam",
};

describe("RecentAISummary callback bridge", () => {
  beforeEach(() => {
    aiState.active = false;
    startAnalysis.mockClear();
    stopAnalysis.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    aiState.active = false;
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
      { type: "visuals", data: { overallTier: "A" } },
      { type: "final", data: JSON.stringify(aiReady) },
      { type: "done", valid: true },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith(null));

    fireEvent.click(screen.getByRole("button", { name: /최근 10경기 AI 끝장 토론 시작/ }));

    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith({ verdict: "fixture verdict", tier: "A" }));
    expect(onSummaryChange.mock.calls).toEqual([
      [null],
      [{ verdict: "fixture verdict", tier: "A" }],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("visuals-only와 done(valid:false)는 undefined verdict snapshot을 배출하지 않는다", async () => {
    const onSummaryChange = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ndjsonResponse([{ type: "visuals", data: { overallTier: "S" } }]))
      .mockResolvedValueOnce(ndjsonResponse([{ type: "done", valid: false, error: "fatal" }]));
    vi.stubGlobal("fetch", fetchMock);
    const first = render(createElement(RecentAISummary, { ...baseProps, onSummaryChange }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith(null));
    fireEvent.click(screen.getByRole("button", { name: /최근 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(onSummaryChange.mock.calls).toEqual([[null]]);
    first.unmount();

    render(createElement(RecentAISummary, { ...baseProps, nickname: "OtherPlayer", onSummaryChange }));
    await waitFor(() => expect(onSummaryChange).toHaveBeenLastCalledWith(null));
    fireEvent.click(screen.getByRole("button", { name: /최근 10경기 AI 끝장 토론 시작/ }));
    await screen.findByText("AI 분석이 잠깐 막혔어요.");
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
    fireEvent.click(await screen.findByRole("button", { name: /최근 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    view.rerender(createElement(RecentAISummary, {
      ...baseProps,
      platform: "kakao",
      matchIds: ["match-b"],
      onSummaryChange,
    }));
    fireEvent.click(await screen.findByRole("button", { name: /최근 10경기 AI 끝장 토론 시작/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => requestA.settleDone());

    expect(screen.queryByRole("button", { name: /최근 10경기 AI 끝장 토론 시작/ })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(aiState.active).toBe(true);
    expect(stopAnalysis).toHaveBeenCalledTimes(1);
    expect(onSummaryChange).toHaveBeenLastCalledWith(null);
  });
});
