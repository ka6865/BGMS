import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LolMatchTimeline from "@/components/lol/LolMatchTimeline";
import type { LolTimelinePoint } from "@/lib/lol/matchBuild";

const render = (points: LolTimelinePoint[]) => renderToStaticMarkup(React.createElement(LolMatchTimeline, { points }));

describe("경기 골드·CS 그래프", () => {
  it("시계열이 없으면 안내하고 0은 실제 값으로 표시한다", () => {
    expect(render([])).toContain("골드·CS 기록이 없습니다.");
    const html = render([{ timestamp: 0, gold: 0, cs: 0 }]);
    expect(html).toContain("0:00 · 누적 골드 0");
    expect(html).toContain('aria-label="경기 시점"');
    expect(html).toContain("disabled");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });
  it("결측과 프레임 누락 구간은 선을 끊고 마지막 시점을 실제 시각으로 표시한다", () => {
    const html = render([
      { timestamp: 0, gold: 500, cs: 0 }, { timestamp: 60_000, gold: 700, cs: 5 },
      { timestamp: 120_000, gold: null, cs: 10 }, { timestamp: 180_000, gold: 1200, cs: 15 },
      { timestamp: 360_000, gold: 2000, cs: 20 },
    ]);
    const path = html.match(/<path d="([^"]*)"/)![1];
    expect(path.match(/M/g)).toHaveLength(3);
    expect(path.match(/L/g)).toHaveLength(1);
    expect(html).toContain("6:00 · 누적 골드 2,000");
    expect(html).toContain('aria-label="누적 골드 변화 그래프"');
  });
  it("없는 골드는 0으로 그리지 않고 기록 없음으로 표시한다", () => {
    const html = render([{ timestamp: 145_000, gold: null, cs: 13 }]);
    expect(html).toContain("누적 골드 기록이 없습니다.");
    expect(html).toContain("2:25 · 누적 골드 기록 없음");
    expect(html).not.toContain("<path");
  });
});
