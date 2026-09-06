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
  ["ranked", "solo", "11", "0", "0", "—"],
  ["ranked", "duo", "24", "0", "0", "—"],
  ["ranked", "squad", "52", "0", "0", "—"],
  ["normal", "solo", "42", "0", "0", "—"],
  ["normal", "duo", "55", "0", "0", "—"],
  ["normal", "squad", "138", "0", "0", "—"],
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

  it.each(expected)("%s/%s controlled bucket의 중복 없는 전투 지표를 렌더한다", (mode, partySize, kills, assists, dbnos, averageRank) => {
    render(createElement(StatSummaryPanel, props(mode, partySize)));

    expect(screen.getByTestId("kills")).toHaveTextContent(kills);
    expect(screen.getByTestId("assists")).toHaveTextContent(assists);
    expect(screen.getByTestId("dbnos")).toHaveTextContent(dbnos);
    expect(screen.getByTestId("average-rank")).toHaveTextContent(averageRank);
    expect(screen.queryByText("현재 랭크")).not.toBeInTheDocument();
  });

  it("모드/파티 controls는 상단 시즌 카드에만 노출해 중복을 제거한다", () => {
    render(createElement(StatSummaryPanel, props("ranked", "squad")));

    expect(screen.queryByRole("button", { name: "일반전" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "듀오" })).not.toBeInTheDocument();
  });

  it("선택 bucket의 플레이 기록이 없으면 0 대신 명시적 empty state를 보여준다", () => {
    render(createElement(StatSummaryPanel, {
      ...props("ranked", "solo"),
      stats: { ...stats, ranked: { ...stats.ranked, solo: null } },
    }));

    expect(screen.getByText("기록 없음")).toBeInTheDocument();
    expect(screen.queryByTestId("rounds-played")).not.toBeInTheDocument();
  });

  it("선택 모드 조회 불가는 기록 없음이나 0 대신 명시적 안내를 보여준다", () => {
    render(createElement(StatSummaryPanel, {
      ...props("ranked", "squad"),
      statsAvailability: { ranked: { status: "unavailable" } },
    }));

    expect(screen.getByText("조회 불가")).toBeInTheDocument();
    expect(screen.getByText(/현재 수치를 표시할 수 없습니다/)).toBeInTheDocument();
    expect(screen.queryByText("기록 없음")).not.toBeInTheDocument();
    expect(screen.queryByTestId("kills")).not.toBeInTheDocument();
  });

  it("stale 모드는 기존 지표와 마지막 갱신 안내를 함께 보존한다", () => {
    render(createElement(StatSummaryPanel, {
      ...props("normal", "squad"),
      statsAvailability: { normal: { status: "stale", updatedAt: "2026-08-10T00:00:00.000Z" } },
    }));

    expect(screen.getByTestId("kills")).toHaveTextContent("138");
    expect(screen.getByText("이전 자료로 표시 중")).toBeInTheDocument();
    expect(screen.getByText(/마지막 갱신/)).toBeInTheDocument();
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
