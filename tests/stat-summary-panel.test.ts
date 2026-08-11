// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatSummaryPanel } from "@/components/stat/StatSummaryPanel";
import { StatsSectionTabs } from "@/components/stat/overview/StatsSectionTabs";
import type { PlayerStatsResponse, StatsBucket, StatsMode, StatsPartySize } from "@/types/stats-page";

function bucket(input: Partial<StatsBucket> & Pick<StatsBucket, "roundsPlayed" | "kills" | "deaths" | "damageDealt">): StatsBucket {
  return {
    assists: 0,
    wins: 0,
    dBNOs: 0,
    ...input,
  };
}

const stats: PlayerStatsResponse["stats"] = {
  ranked: {
    solo: bucket({ roundsPlayed: 11, kills: 11, deaths: 11, damageDealt: 1100, top10Ratio: 0.1 }),
    duo: bucket({ roundsPlayed: 12, kills: 24, deaths: 8, damageDealt: 2400, top10Ratio: 0.2 }),
    squad: bucket({ roundsPlayed: 13, kills: 52, deaths: 13, damageDealt: 3900, top10Ratio: 0.3 }),
  },
  normal: {
    solo: bucket({ roundsPlayed: 21, kills: 42, deaths: 21, damageDealt: 8400, top10s: 8 }),
    duo: bucket({ roundsPlayed: 22, kills: 55, deaths: 11, damageDealt: 11000, top10s: 11 }),
    squad: bucket({ roundsPlayed: 23, kills: 138, deaths: 23, damageDealt: 13800, top10s: 20 }),
  },
};

const expected = [
  ["ranked", "solo", "11", "1.00", "100", "10.0%"],
  ["ranked", "duo", "12", "3.00", "200", "20.0%"],
  ["ranked", "squad", "13", "4.00", "300", "30.0%"],
  ["normal", "solo", "21", "2.00", "400", "38.1%"],
  ["normal", "duo", "22", "5.00", "500", "50.0%"],
  ["normal", "squad", "23", "6.00", "600", "87.0%"],
] as const;

function props(mode: StatsMode, partySize: StatsPartySize) {
  return {
    stats,
    mode,
    partySize,
    aiSummary: null,
    aiExpanded: false,
    onModeChange: vi.fn(),
    onPartySizeChange: vi.fn(),
    onAiToggle: vi.fn(),
  };
}

describe("StatSummaryPanel", () => {
  afterEach(() => cleanup());

  it.each(expected)("%s/%s controlled bucket의 독립 지표를 렌더한다", (mode, partySize, rounds, kda, damage, top10) => {
    render(createElement(StatSummaryPanel, props(mode, partySize)));

    expect(screen.getByTestId("rounds-played")).toHaveTextContent(rounds);
    expect(screen.getByTestId("kda")).toHaveTextContent(kda);
    expect(screen.getByTestId("average-damage")).toHaveTextContent(damage);
    expect(screen.getByTestId("top10-rate")).toHaveTextContent(top10);
    expect(screen.queryByTestId("preferred-mode")).not.toBeInTheDocument();
    expect(screen.queryByText("현재 랭크")).not.toBeInTheDocument();
  });

  it("모드/파티 controls는 외부 callback만 호출하는 controlled 경계다", () => {
    const onModeChange = vi.fn();
    const onPartySizeChange = vi.fn();
    render(createElement(StatSummaryPanel, {
      ...props("ranked", "squad"),
      onModeChange,
      onPartySizeChange,
    }));

    fireEvent.click(screen.getByRole("button", { name: "일반전" }));
    fireEvent.click(screen.getByRole("button", { name: "듀오" }));

    expect(onModeChange).toHaveBeenCalledWith("normal");
    expect(onPartySizeChange).toHaveBeenCalledWith("duo");
    expect(screen.getByRole("button", { name: "경쟁전" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "스쿼드" })).toHaveAttribute("aria-pressed", "true");
  });

  it("선택 bucket의 플레이 기록이 없으면 0 대신 명시적 empty state를 보여준다", () => {
    render(createElement(StatSummaryPanel, {
      ...props("ranked", "solo"),
      stats: { ...stats, ranked: { ...stats.ranked, solo: null } },
    }));

    expect(screen.getByText("기록 없음")).toBeInTheDocument();
    expect(screen.queryByTestId("rounds-played")).not.toBeInTheDocument();
  });

  it("AI snapshot이 있으면 한줄 요약과 controlled clamp만 제공한다", () => {
    const onAiToggle = vi.fn();
    const view = render(createElement(StatSummaryPanel, {
      ...props("ranked", "squad"),
      onAiToggle,
    }));
    expect(screen.queryByRole("button", { name: "최근 10경기 AI 분석으로 이동" })).not.toBeInTheDocument();

    view.rerender(createElement(StatSummaryPanel, {
      ...props("ranked", "squad"),
      aiSummary: { verdict: "fixture verdict", tier: "A" },
      aiExpanded: false,
      onAiToggle,
    }));
    expect(screen.getByText("fixture verdict")).toHaveClass("line-clamp-2", "md:line-clamp-3");
    expect(screen.getByText("A")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "AI 요약 더보기" }));
    expect(onAiToggle).toHaveBeenCalledTimes(1);

    view.rerender(createElement(StatSummaryPanel, {
      ...props("ranked", "squad"),
      aiSummary: { verdict: "fixture verdict", tier: "A" },
      aiExpanded: true,
      onAiToggle,
    }));
    expect(screen.getByText("fixture verdict")).not.toHaveClass("line-clamp-2");
    expect(screen.getByRole("button", { name: "AI 요약 접기" })).toBeInTheDocument();
  });

  it("overview/squad section tabs도 controlled 선택을 유지한다", () => {
    const onChange = vi.fn();
    render(createElement(StatsSectionTabs, { value: "squad", onChange }));

    fireEvent.click(screen.getByRole("button", { name: "개인 분석 개요" }));
    expect(onChange).toHaveBeenCalledWith("overview");
    expect(screen.getByRole("button", { name: "스쿼드 시너지" })).toHaveAttribute("aria-pressed", "true");
  });
});
