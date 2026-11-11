// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { getMatchScoreMax, pickMatchVerdictMetrics } from "@/lib/pubg-analysis/matchVerdict";
import { MatchVerdictBlock } from "@/components/stat/matches/MatchVerdictBlock";
import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import detailReady from "./fixtures/stats/match-detail-ready.json";

afterEach(cleanup);

const squadMax = getMatchScoreMax("squad-fpp", false);
const evidence = { combat: "딜량 #2", tactical: "구출 50%", survival: "순위 #3 / 16" };

describe("이 판 결론 지표 선정", () => {
  it("만점 대비 비율이 가장 높은 범주와 가장 낮은 범주를 고른다", () => {
    const { best, weak } = pickMatchVerdictMetrics({ breakdown: { combat: 34, tactical: 10, survival: 21 }, max: squadMax, evidence });
    expect(best).toMatchObject({ category: "combat", label: "전투", score: 34, max: 40, evidence: "딜량 #2" });
    expect(weak).toMatchObject({ category: "tactical", score: 10, max: 35 });
  });

  it("모두 절반 이상이면 아쉬운 점 없이 좋았던 점만 고른다", () => {
    const { best, weak } = pickMatchVerdictMetrics({ breakdown: { combat: 34, tactical: 27, survival: 21 }, max: squadMax, evidence });
    expect(best?.category).toBe("combat");
    expect(weak).toBeNull();
  });

  it("모두 절반 미만이면 좋았던 점 없이 아쉬운 점만 고른다", () => {
    const { best, weak } = pickMatchVerdictMetrics({ breakdown: { combat: 10, tactical: 3, survival: 0 }, max: squadMax, evidence });
    expect(best).toBeNull();
    expect(weak?.category).toBe("survival");
  });

  it("솔로는 전술 만점이 작아 같은 점수라도 비율이 달라진다", () => {
    const soloMax = getMatchScoreMax("solo-fpp", false);
    expect(soloMax).toEqual({ combat: 50, tactical: 15, survival: 35 });
    expect(getMatchScoreMax("solo", true)).toEqual(squadMax);
    const { best } = pickMatchVerdictMetrics({ breakdown: { combat: 20, tactical: 12, survival: 10 }, max: soloMax, evidence });
    expect(best?.category).toBe("tactical");
  });

  it.each([
    ["근거 없음", {}],
    ["측정 불가 근거", { combat: "전투 샘플 측정 불가" }],
  ])("%s 범주는 점수가 있어도 고르지 않는다", (_, partial) => {
    const { best } = pickMatchVerdictMetrics({
      breakdown: { combat: 40, tactical: 20, survival: 14 },
      max: squadMax,
      evidence: { tactical: "구출 50%", survival: "순위 #3 / 16", ...partial },
    });
    expect(best?.category).toBe("tactical");
  });

  it("점수가 숫자가 아니거나 breakdown이 없으면 고르지 않는다", () => {
    expect(pickMatchVerdictMetrics({ breakdown: { combat: null, tactical: Number.NaN, survival: "20" }, max: squadMax, evidence }))
      .toEqual({ best: null, weak: null });
    expect(pickMatchVerdictMetrics({ breakdown: undefined, max: squadMax, evidence })).toEqual({ best: null, weak: null });
  });
});

describe("이 판 결론 블록", () => {
  const detail = () => structuredClone(detailReady) as unknown as MatchSummaryData;

  it("사망 경위, 점수와 티어, 좋았던 점을 서버 값으로 보여 준다", () => {
    const matchData = detail();
    render(createElement(MatchVerdictBlock, { matchData, report: matchData.matchReport ?? null, showScore: true }));
    const block = screen.getByRole("region", { name: "이 판 결론" });
    expect(within(block).getByTestId("match-verdict-score")).toHaveTextContent("S 티어 · 82 / 100점");
    expect(within(block).getByLabelText("사망 요약")).toBeInTheDocument();
    expect(within(block).getByText("좋았던 점").parentElement).toHaveTextContent("전투 34 / 40점 · 딜량 #2, 선제 성공 55%");
    expect(within(block).queryByText("아쉬운 점")).not.toBeInTheDocument();
  });

  it("아쉬운 범주가 있으면 함께 보여 준다", () => {
    const matchData = detail();
    matchData.benchmark!.breakdown.survival = 5;
    render(createElement(MatchVerdictBlock, { matchData, report: null, showScore: true }));
    expect(screen.getByText("아쉬운 점").parentElement).toHaveTextContent("생존 5 / 25점 · 순위 #3 / 16, 보정 없음");
  });

  it("점수를 보이지 않는 경기(기본 요약·TDM)는 사망 경위만 남긴다", () => {
    const matchData = detail();
    render(createElement(MatchVerdictBlock, { matchData, report: matchData.matchReport ?? null, showScore: false }));
    const block = screen.getByRole("region", { name: "이 판 결론" });
    expect(within(block).queryByTestId("match-verdict-score")).not.toBeInTheDocument();
    expect(within(block).queryByText("좋았던 점")).not.toBeInTheDocument();
    expect(within(block).getByLabelText("사망 요약")).toBeInTheDocument();
  });

  it("사망 경위도 점수도 없으면 블록을 그리지 않는다", () => {
    const matchData = detail();
    delete matchData.benchmark;
    render(createElement(MatchVerdictBlock, { matchData, report: null, showScore: true }));
    expect(screen.queryByRole("region", { name: "이 판 결론" })).not.toBeInTheDocument();
  });
});
