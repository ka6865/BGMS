// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { IsolationRadar } from "../components/stat/IsolationRadar";
import { SpiderChart } from "../components/stat/SpiderChart";

describe("server-owned stat components", () => {
  it("SpiderChart shows team scores against their actual caps and describes achievement, not a title", () => {
    render(createElement(SpiderChart, {
      nickname: "FixturePlayer",
      bestMatchCount: 4,
      tierScope: "team",
      data: { combat: 32, tactical: 28, survival: 20 },
    }));

    expect(screen.getByText("전투")).toBeInTheDocument();
    expect(screen.getByText("전술")).toBeInTheDocument();
    expect(screen.getByText("생존")).toBeInTheDocument();
    expect(screen.getByText("32/40")).toBeInTheDocument();
    expect(screen.getByText("28/35")).toBeInTheDocument();
    expect(screen.getByText("20/25")).toBeInTheDocument();
    expect(screen.queryByText("시야")).not.toBeInTheDocument();
    expect(screen.queryByText("협력")).not.toBeInTheDocument();
    expect(screen.queryByText("성장")).not.toBeInTheDocument();
    expect(screen.getByText("4경기 기준 · 3영역 점수 분포")).toBeInTheDocument();
    expect(screen.getByText("각 영역 배점 대비 달성률이며 백분위가 아닙니다.")).toBeInTheDocument();
    expect(screen.queryByText(/공격적 돌격병|지능형 생존가|균형잡힌 전술가/)).not.toBeInTheDocument();
    expect(screen.queryByText(/PUBG 공식 평점|BGMS 자체 산정/)).not.toBeInTheDocument();
  });

  it("SpiderChart leaves the complete polygon out when scope or an axis is missing", () => {
    render(createElement(SpiderChart, {
      nickname: "MissingPlayer",
      tierScope: "team",
      data: { combat: 32, tactical: null, survival: 0 },
    }));

    expect(screen.getByText("32/40")).toBeInTheDocument();
    expect(screen.getByText("측정 불가")).toBeInTheDocument();
    expect(screen.getByText("0/25")).toBeInTheDocument();
    expect(document.querySelector('path[stroke="#6366f1"]')).not.toBeInTheDocument();

    render(createElement(SpiderChart, {
      nickname: "LegacyPlayer",
      data: { combat: 32, tactical: 28, survival: 20 },
    }));
    expect(screen.getByText("32점")).toBeInTheDocument();
    expect(document.querySelector('path[stroke="#6366f1"]')).not.toBeInTheDocument();
  });

  it.each([undefined, "", Number.NaN])("SpiderChart treats %s as unobserved instead of zero", (tactical) => {
    const { container } = render(createElement(SpiderChart, {
      nickname: "UnobservedPlayer",
      tierScope: "solo",
      data: { combat: 0, tactical, survival: 10 } as any,
    }));

    expect(screen.getByText("0/50")).toBeInTheDocument();
    expect(screen.getByText("측정 불가")).toBeInTheDocument();
    expect(container.querySelector('path[stroke="#6366f1"]')).not.toBeInTheDocument();
  });

  it.each([
    { tierScope: "team" as const, data: { combat: 40, tactical: 35, survival: 25 } },
    { tierScope: "solo" as const, data: { combat: 50, tactical: 15, survival: 35 } },
  ])("SpiderChart maps each $tierScope axis maximum to the chart edge", ({ tierScope, data }) => {
    const { container } = render(createElement(SpiderChart, { nickname: "MaxPlayer", tierScope, data }));
    const path = container.querySelector('path[stroke="#6366f1"]')!;
    const coordinates = path.getAttribute("d")!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);

    expect(coordinates).toHaveLength(6);
    for (let index = 0; index < 6; index += 2) {
      expect(Math.hypot(coordinates[index] - 170, coordinates[index + 1] - 170)).toBeCloseTo(102);
    }
    for (const cap of Object.values(data)) expect(screen.getByText(`${cap}/${cap}`)).toBeInTheDocument();
  });

  it("SpiderChart gives team 32/40 and solo 40/50 the same 80% radius and caps only the plotted value", () => {
    const readCombatRadius = (tierScope: "solo" | "team", combat: number) => {
      const { container, unmount } = render(createElement(SpiderChart, {
        nickname: "RatioPlayer",
        tierScope,
        data: { combat, tactical: 0, survival: 0 },
      }));
      const y = Number(container.querySelector('path[stroke="#6366f1"]')!.getAttribute("d")!.match(/^M\s+[-\d.]+\s+([-\d.]+)/)?.[1]);
      unmount();
      return 170 - y;
    };

    expect(readCombatRadius("team", 32)).toBeCloseTo(readCombatRadius("solo", 40));
    render(createElement(SpiderChart, {
      nickname: "OverCapPlayer",
      tierScope: "team",
      data: { combat: 45.5, tactical: 0, survival: 0 },
    }));
    expect(screen.getByText("45.5/40")).toBeInTheDocument();
    const y = Number(document.querySelector('path[stroke="#6366f1"]')!.getAttribute("d")!.match(/^M\s+[-\d.]+\s+([-\d.]+)/)?.[1]);
    expect(170 - y).toBeCloseTo(102);
  });

  it("SpiderChart keeps an observed zero at the center", () => {
    const { container } = render(createElement(SpiderChart, {
      nickname: "ZeroPlayer",
      tierScope: "team",
      data: { combat: 0, tactical: 0, survival: 0 },
    }));
    const path = container.querySelector('path[stroke="#6366f1"]')!;

    expect(screen.getAllByText("0/40").length).toBeGreaterThan(0);
    expect(path.getAttribute("d")).toBe("M 170 170 L 170 170 L 170 170 Z");
  });

  it("IsolationRadar matches the 200m / 2 normalization and labels minDist as average nearest ally distance", () => {
    render(createElement(IsolationRadar, {
      data: {
        isolationIndex: 1,
        minDist: 100,
        heightDiff: 3,
        isCrossfire: false,
        teammateCount: 2,
        benchmarkIsolationIndex: 0,
        benchmarkMinDist: 0,
        benchmarkScope: {
          gameMode: "duo",
          matchType: "competitive",
          tier: "B+",
          sampleCount: 24,
          metricSampleCounts: {
            avgIsolationIndex: 24,
            avgMinDist: 22,
          },
        },
      },
    }));

    expect(screen.getByText("평균 최근접 아군 거리")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();
    expect(document.body.textContent).toContain("100.0m");
    fireEvent.mouseEnter(screen.getAllByRole("button")[1]);
    expect(screen.getByText("100 - (평균 최근접 아군 거리 / 2.0)")).toBeInTheDocument();
    expect(screen.getByText(/200m/)).toBeInTheDocument();
    expect(screen.getByText("B+ · 듀오 · 경쟁전 평균: 고립지수 0")).toBeInTheDocument();
    expect(screen.getByText("B+ · 듀오 · 경쟁전 평균: 아군 거리 0m")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/player-match|해당 지표 n=|competitive/);
    expect(document.body.textContent).not.toContain("undefined");
    expect(screen.queryByText("최근접 아군 거리")).not.toBeInTheDocument();
  });

  it("IsolationRadar finite-normalizes malformed user values and hides invalid benchmarks", () => {
    render(createElement(IsolationRadar, {
      data: {
        isolationIndex: Number.NaN,
        minDist: Number.POSITIVE_INFINITY,
        heightDiff: undefined,
        isCrossfire: false,
        teammateCount: "not-a-number",
        benchmarkIsolationIndex: Number.NaN,
        benchmarkMinDist: Number.POSITIVE_INFINITY,
      } as any,
    }));

    expect(document.body.textContent).not.toMatch(/NaN|Infinity|undefined/);
    expect(screen.getAllByText("측정 불가").length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText(/평균 고립지수/)).not.toBeInTheDocument();
    expect(screen.queryByText(/평균: 아군 거리 .*m/)).not.toBeInTheDocument();
  });

  it("IsolationRadar renders missing isolation measurements as unavailable instead of perfect zero fallbacks", () => {
    render(createElement(IsolationRadar, {
      data: {
        isolationIndex: null,
        minDist: undefined,
        heightDiff: "",
        isCrossfire: false,
        teammateCount: null,
      } as any,
    }));

    expect(screen.getAllByText("측정 불가").length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText("공간 안정성: 우수")).not.toBeInTheDocument();
  });

  it("IsolationRadar preserves explicit numeric zero as a measured value", () => {
    render(createElement(IsolationRadar, {
      data: {
        isolationIndex: 0,
        minDist: 0,
        heightDiff: 0,
        isCrossfire: false,
        teammateCount: 0,
      },
    }));

    expect(screen.getByText("공간 안정성: 우수")).toBeInTheDocument();
    expect(screen.getAllByText("100").length).toBeGreaterThanOrEqual(3);
    expect(document.body.textContent).toContain("0.0m");
    expect(document.body.textContent).toContain("0명");
  });
});
