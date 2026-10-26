import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LolRankedGraph, { rankedPosition } from "@/components/lol/LolRankedGraph";
import type { LolRankedDailyPoint } from "@/lib/lol/types";

const point = (date: string, overrides: Partial<LolRankedDailyPoint> = {}): LolRankedDailyPoint => ({
  date, recordedAt: `${date}T00:00:00Z`, tier: "PLATINUM", rank: "IV", lp: 10,
  wins: 1, losses: 0, isBaseline: false, ...overrides,
});
function render(points: LolRankedDailyPoint[]) {
  return renderToStaticMarkup(React.createElement(LolRankedGraph, { label: "솔로 랭크", today: "2026-10-23",
    history: { points, highest: points[0] ?? null, trackingSince: points[0]?.recordedAt ?? null },
  }));
}

describe("최근 30일 티어 그래프", () => {
  it("기록이 없으면 안내하고 한 기록에는 점과 기록 시작 안내만 표시한다", () => {
    expect(render([])).toContain("최근 30일 기록 없음");
    const html = render([point("2026-10-23")]);
    expect(html.match(/<circle /g)).toHaveLength(1);
    expect(html).not.toContain("<polyline");
    expect(html).toContain("기록이 쌓이면 추이가 표시됩니다(기록 시작 2026-10-23)");
    expect(html).toContain("2026-10-23 · 플래티넘 4 · 10 LP");
  });
  it("빈 날짜는 선만 연결하고 이전 시작점은 구분하며 기간 밖 기록은 버린다", () => {
    const html = render([point("2026-09-01", { isBaseline: true }), point("2026-09-02"), point("2026-10-23")]);
    expect(html.match(/<circle /g)).toHaveLength(2);
    expect(html).toContain("<polyline");
    expect(html).toContain("30일 이전 시작점");
    expect(html).toContain("09-24");
    expect(html).toContain("10-23");
  });
  it("승급으로 LP가 초기화돼도 위치는 상승하고 마스터 이상 LP는 연속이다", () => {
    expect(rankedPosition(point("2026-10-23", { tier: "GOLD", rank: "I", lp: 99 })))
      .toBeLessThan(rankedPosition(point("2026-10-23", { lp: 0 })));
    expect(rankedPosition(point("2026-10-23", { tier: "MASTER", lp: 1500 }))).toBe(43);
    expect(rankedPosition(point("2026-10-23", { tier: "GRANDMASTER", lp: 1500 }))).toBe(43);
  });
});
