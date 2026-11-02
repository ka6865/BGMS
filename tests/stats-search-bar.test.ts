// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { StatsSearchBar } from "@/components/stat/search/StatsSearchBar";
import type { StatsPlatform } from "@/types/stats-page";
import type { StatsSearchEntry } from "@/hooks/useStatsSearchHistory";

const player = { nickname: "Kang", platform: "steam" as const };

function renderSearchBar(overrides: Partial<ComponentProps<typeof StatsSearchBar>> = {}) {
  const props = {
    platform: "steam" as StatsPlatform,
    nickname: "Ka",
    recentSearches: [] as readonly StatsSearchEntry[],
    favorites: [] as readonly StatsSearchEntry[],
    suggestions: [player],
    suggesting: false,
    empty: false,
    submitDisabled: false,
    onPlatformChange: vi.fn(),
    onNicknameChange: vi.fn(),
    onSubmit: vi.fn(),
    onQuickSearch: vi.fn(),
    onSuggestionSelect: vi.fn(),
    onFavoriteToggle: vi.fn(),
    onRecentRemove: vi.fn(),
    ...overrides,
  };
  const view = render(createElement(StatsSearchBar, props));
  fireEvent.focus(screen.getByLabelText("닉네임"));
  return { ...view, props };
}

describe("StatsSearchBar 접근성 및 키보드 동작", () => {
  it("연결된 읽기 쉬운 label과 실제 추천 popup 상태를 제공한다", () => {
    renderSearchBar();
    const nickname = screen.getByRole("combobox", { name: "닉네임" });
    const platform = screen.getByLabelText("플랫폼");
    const listbox = screen.getByRole("listbox", { name: "추천 플레이어" });
    const option = within(listbox).getByRole("option", { name: /Kang\s*스팀/ });

    expect(nickname).toHaveAttribute("aria-expanded", "true");
    expect(nickname).toHaveAttribute("aria-controls", listbox.id);
    expect(option.id).toBeTruthy();
    expect(nickname).not.toHaveAttribute("aria-activedescendant");
    expect(platform).toHaveAccessibleName("플랫폼");
  });

  it("ArrowDown/Up로 추천을 이동하고 Enter로 선택한다", () => {
    const second = { nickname: "Kang2", platform: "kakao" as const };
    const { props } = renderSearchBar({ suggestions: [player, second] });
    const input = screen.getByRole("combobox", { name: "닉네임" });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options[1].id);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(props.onSuggestionSelect).toHaveBeenCalledWith(player);
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Escape로 추천을 닫은 뒤 Enter는 일반 검색을 실행한다", () => {
    const { props } = renderSearchBar();
    const input = screen.getByRole("combobox", { name: "닉네임" });

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenCalledOnce();
  });

  it("Escape 후 ArrowDown/ArrowUp은 추천을 다시 열고 첫 항목/끝 항목을 활성화한다", () => {
    const second = { nickname: "Kang2", platform: "kakao" as const };
    renderSearchBar({ suggestions: [player, second] });
    const input = screen.getByRole("combobox", { name: "닉네임" });
    const options = within(screen.getByRole("listbox")).getAllByRole("option");

    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);

    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[1].id);
  });

  it("이력 popup 내부로 focus를 옮기면 유지하고 검색 버튼으로 나가면 닫는다", () => {
    renderSearchBar({
      nickname: "",
      suggestions: [],
      recentSearches: [{ nickname: "Recent", platform: "steam" }],
    });
    const quickSearch = screen.getByRole("button", { name: "Recent 스팀으로 검색" });
    const submit = screen.getByRole("button", { name: "검색" });

    fireEvent.blur(screen.getByLabelText("닉네임"), { relatedTarget: quickSearch });
    expect(quickSearch).toBeInTheDocument();

    fireEvent.blur(quickSearch, { relatedTarget: submit });
    expect(quickSearch).not.toBeInTheDocument();
  });

  it("IME 조합 중 Enter로 검색하거나 추천을 선택하지 않는다", () => {
    const { props } = renderSearchBar();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "닉네임" }), {
      key: "Enter",
      isComposing: true,
    });
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onSuggestionSelect).not.toHaveBeenCalled();
  });

  it("추천 배열이 갱신되면 이전 active descendant를 가리키지 않는다", () => {
    const { rerender } = renderSearchBar();
    const input = screen.getByRole("combobox", { name: "닉네임" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant");

    const refreshed = { nickname: "DifferentPlayer", platform: "kakao" as const };
    rerender(createElement(StatsSearchBar, {
      platform: "steam",
      nickname: "Ka",
      recentSearches: [],
      favorites: [],
      suggestions: [refreshed],
      suggesting: false,
      empty: false,
      submitDisabled: false,
      onPlatformChange: vi.fn(),
      onNicknameChange: vi.fn(),
      onSubmit: vi.fn(),
      onQuickSearch: vi.fn(),
      onSuggestionSelect: vi.fn(),
      onFavoriteToggle: vi.fn(),
      onRecentRemove: vi.fn(),
    }));

    expect(input).not.toHaveAttribute("aria-activedescendant");
    rerender(createElement(StatsSearchBar, {
      platform: "steam",
      nickname: "Ka",
      recentSearches: [],
      favorites: [],
      suggestions: [player],
      suggesting: false,
      empty: false,
      submitDisabled: false,
      onPlatformChange: vi.fn(),
      onNicknameChange: vi.fn(),
      onSubmit: vi.fn(),
      onQuickSearch: vi.fn(),
      onSuggestionSelect: vi.fn(),
      onFavoriteToggle: vi.fn(),
      onRecentRemove: vi.fn(),
    }));
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("플랫폼을 바꾸면 열린 추천과 활성 선택을 초기화한다", () => {
    const { props } = renderSearchBar();
    const input = screen.getByRole("combobox", { name: "닉네임" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.change(screen.getByLabelText("플랫폼"), { target: { value: "kakao" } });

    expect(props.onPlatformChange).toHaveBeenCalledWith("kakao");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("빈 결과는 listbox로 오인되지 않고 history popup은 별도 영역이다", () => {
    renderSearchBar({
      suggestions: [],
      empty: true,
      recentSearches: [{ nickname: "Recent", platform: "steam" }],
    });
    const input = screen.getByRole("combobox", { name: "닉네임" });
    expect(screen.getByText("검색 결과가 없습니다")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-controls");
    expect(screen.getByRole("region", { name: "즐겨찾기 및 최근 검색" })).toBeInTheDocument();
  });

  it("긴 추천 닉네임을 option 안에서 잘라내되 텍스트는 유지한다", () => {
    const nickname = "플레이어".repeat(40);
    renderSearchBar({ suggestions: [{ nickname, platform: "steam" }] });
    const option = screen.getByRole("option", { name: new RegExp(nickname) });
    expect(option).toHaveTextContent(nickname);
    expect(option.querySelector(".truncate")).toBeInTheDocument();
  });

  it("마우스 추천 선택과 최근 검색·즐겨찾기·삭제 동작을 유지한다", () => {
    const recent = { nickname: "Recent", platform: "steam" as const };
    const { props, rerender } = renderSearchBar({
      recentSearches: [recent],
      suggestions: [player],
    });
    fireEvent.click(screen.getByRole("option", { name: /Kang\s*스팀/ }));
    expect(props.onSuggestionSelect).toHaveBeenCalledWith(player);

    rerender(createElement(StatsSearchBar, {
      ...props,
      nickname: "",
      recentSearches: [recent],
      suggestions: [],
    }));
    fireEvent.focus(screen.getByLabelText("닉네임"));
    fireEvent.click(screen.getByRole("button", { name: "Recent 스팀 즐겨찾기 추가" }));
    fireEvent.click(screen.getByRole("button", { name: "Recent 스팀 최근 검색 삭제" }));
    fireEvent.click(screen.getByRole("button", { name: "Recent 스팀으로 검색" }));
    expect(props.onQuickSearch).toHaveBeenCalledWith("Recent", "steam");
    expect(props.onFavoriteToggle).toHaveBeenCalledWith("Recent", "steam");
    expect(props.onRecentRemove).toHaveBeenCalledWith("Recent", "steam");
  });
});
