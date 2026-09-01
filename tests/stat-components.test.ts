// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { IsolationRadar } from "../components/stat/IsolationRadar";
import { SpiderChart } from "../components/stat/SpiderChart";

describe("server-owned stat components", () => {
  it("SpiderChart renders only the exact server-owned combat/tactical/survival axes", () => {
    render(createElement(SpiderChart, {
      nickname: "FixturePlayer",
      bestMatchCount: 4,
      data: { combat: 80, tactical: 70, survival: 60 },
    }));

    expect(screen.getByText("전투")).toBeInTheDocument();
    expect(screen.getByText("전술")).toBeInTheDocument();
    expect(screen.getByText("생존")).toBeInTheDocument();
    expect(screen.getAllByText("80").length).toBeGreaterThan(0);
    expect(screen.getAllByText("70").length).toBeGreaterThan(0);
    expect(screen.getAllByText("60").length).toBeGreaterThan(0);
    expect(screen.queryByText("시야")).not.toBeInTheDocument();
    expect(screen.queryByText("협력")).not.toBeInTheDocument();
    expect(screen.queryByText("성장")).not.toBeInTheDocument();
    expect(screen.queryByText("75")).not.toBeInTheDocument();
    expect(screen.getByText(/점수 상위 4판 전술 플레이스타일/)).toBeInTheDocument();
    expect(screen.getByText(/점수 상위 4판.*BGMS 자체 산정 · PUBG 공식 평점 아님/)).toBeInTheDocument();
  });

  it("SpiderChart finite-normalizes malformed server-owned axes", () => {
    render(createElement(SpiderChart, {
      nickname: "MalformedPlayer",
      data: { combat: Number.NaN, tactical: Number.POSITIVE_INFINITY, survival: "bad" },
    } as any));

    expect(document.body.textContent).not.toMatch(/NaN|Infinity|undefined/);
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector("path")?.getAttribute("d")).not.toMatch(/NaN|Infinity|undefined/);
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
      },
    }));

    expect(screen.getByText("평균 최근접 아군 거리")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();
    expect(document.body.textContent).toContain("100.0m");
    fireEvent.mouseEnter(screen.getAllByRole("button")[1]);
    expect(screen.getByText("100 - (평균 최근접 아군 거리 / 2.0)")).toBeInTheDocument();
    expect(screen.getByText(/200m/)).toBeInTheDocument();
    expect(screen.getByText(/평균 고립지수: 0/)).toBeInTheDocument();
    expect(screen.getByText(/평균 최근접 아군 거리: 0m/)).toBeInTheDocument();
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
    expect(screen.queryByText(/평균 최근접 아군 거리: .*m/)).not.toBeInTheDocument();
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
