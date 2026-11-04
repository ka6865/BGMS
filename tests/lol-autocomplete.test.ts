// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLolAutocomplete } from "@/hooks/useLolAutocomplete";

const response = (suggestions: unknown, status = 200) => new Response(JSON.stringify({ suggestions }), { status });

describe("LoL autocomplete", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("2자 이상 Riot ID 전체를 300ms 디바운스해 요청한다", async () => {
    fetchMock.mockResolvedValue(response([{ gameName: "Hide on bush", tagLine: "KR1" }]));
    const { result } = renderHook(() => useLolAutocomplete("  Hi#KR1  "));
    act(() => vi.advanceTimersByTime(299));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/lol/suggest?q=Hi%23KR1");
    expect(result.current.suggestions).toEqual([{ gameName: "Hide on bush", tagLine: "KR1" }]);
  });

  it("새 query는 진행 중인 요청을 취소하고 늦은 응답은 버린다", async () => {
    let resolveOld!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(response([{ gameName: "New", tagLine: "KR1" }]));
    const hook = renderHook(({ query }) => useLolAutocomplete(query), { initialProps: { query: "Hi" } });
    act(() => vi.advanceTimersByTime(300));
    const oldSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    hook.rerender({ query: "New" });
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => resolveOld(response([{ gameName: "Old", tagLine: "KR1" }])));
    expect(hook.result.current.suggestions).toEqual([{ gameName: "New", tagLine: "KR1" }]);
  });

  it("응답의 저장된 Riot ID만 최대 8개로 받으며 실패를 검색에 전파하지 않는다", async () => {
    fetchMock.mockResolvedValue(response([
      ...Array.from({ length: 9 }, (_, index) => ({ gameName: `P${index}`, tagLine: "KR1", puuid: "private" })),
      { gameName: "malformed" },
    ]));
    const { result } = renderHook(() => useLolAutocomplete("Player"));
    await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.suggestions).toHaveLength(8);
    expect(result.current.suggestions[0]).toEqual({ gameName: "P0", tagLine: "KR1" });

    fetchMock.mockResolvedValue(response({ error: "unavailable" }, 503));
    const failed = renderHook(() => useLolAutocomplete("Another"));
    await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); await Promise.resolve(); });
    expect(failed.result.current).toEqual({ suggestions: [], suggesting: false, empty: false });
  });
});
