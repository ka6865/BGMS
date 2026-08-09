// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStatsAutocomplete } from "@/hooks/useStatsAutocomplete";
import { StatsSearchBar } from "@/components/stat/search/StatsSearchBar";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("stats autocomplete", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("2자 이상 query를 300ms debounce한 뒤 한 번만 요청한다", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      suggestions: [{ nickname: "Kang", platform: "steam" }],
    }));
    const { result } = renderHook(() => useStatsAutocomplete("Ka"));

    act(() => vi.advanceTimersByTime(299));
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/pubg/suggest?q=Ka");
    expect(result.current.suggestions).toEqual([{ nickname: "Kang", platform: "steam" }]);
  });

  it("query가 바뀌면 이전 요청을 abort하고 늦게 도착한 응답을 버린다", async () => {
    let resolveFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    fetchMock
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(jsonResponse({
        suggestions: [{ nickname: "NewPlayer", platform: "kakao" }],
      }));
    const controller = renderHook(
      ({ query }) => useStatsAutocomplete(query),
      { initialProps: { query: "Ka" } },
    );

    act(() => vi.advanceTimersByTime(300));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;

    controller.rerender({ query: "Kan" });
    expect(firstSignal.aborted).toBe(true);
    act(() => vi.advanceTimersByTime(300));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(controller.result.current.suggestions).toEqual([
      { nickname: "NewPlayer", platform: "kakao" },
    ]);

    await act(async () => resolveFirst(jsonResponse({
      suggestions: [{ nickname: "OldPlayer", platform: "steam" }],
    })));
    expect(controller.result.current.suggestions).toEqual([
      { nickname: "NewPlayer", platform: "kakao" },
    ]);
  });

  it("0건 응답은 열린 검색창에서 검색 결과 없음으로 표시한다", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ suggestions: [] }));

    function Harness() {
      const autocomplete = useStatsAutocomplete("Ka");
      return createElement(StatsSearchBar, {
        platform: "steam",
        nickname: "Ka",
        recentSearches: [],
        favorites: [],
        suggestions: autocomplete.suggestions,
        suggesting: autocomplete.suggesting,
        submitDisabled: false,
        onPlatformChange: vi.fn(),
        onNicknameChange: vi.fn(),
        onSubmit: vi.fn(),
        onQuickSearch: vi.fn(),
        onSuggestionSelect: vi.fn(),
        onFavoriteToggle: vi.fn(),
        onRecentRemove: vi.fn(),
      });
    }

    render(createElement(Harness));
    fireEvent.focus(screen.getByPlaceholderText("정확한 대소문자 닉네임을 입력하세요"));
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("검색 결과가 없습니다")).toBeInTheDocument();
  });
});
