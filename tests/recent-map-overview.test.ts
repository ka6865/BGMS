// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { StatSummaryPanel, type StatSummaryPanelProps } from "@/components/stat/StatSummaryPanel";
import { buildBasicMatchSummary, buildMatchSummary } from "@/lib/pubg-analysis/matchSummary";
import { toBattleRoyaleMapId } from "@/lib/stats/mapDisplayName";
import { buildRecentMapOverview } from "@/lib/stats/recentMapOverview";

type Row = { map: string; place?: number; damage?: number; mode?: string };

function fixture(rows: Row[]): StatSummaryPanelProps {
  const matchIds = rows.map((_, i) => `match-${i}`);
  return {
    matchIds,
    summaryStatus: "ready",
    summaries: Object.fromEntries(rows.map((row, i) => [matchIds[i], buildBasicMatchSummary({
      match_id: matchIds[i], player_id: "player", platform: "steam", game_mode: row.mode ?? "squad",
      match_type: "official", map_name: row.map, kills: 1, damage: row.damage, win_place: row.place,
    })])),
  };
}

describe("맵별 성적 집계", () => {
  afterEach(cleanup);

  it("맵별 경기 수·평균 순위·TOP10 비율·평균 피해를 계산한다", () => {
    const result = buildRecentMapOverview(fixture([
      { map: "Baltic_Main", place: 1, damage: 300 },
      { map: "Erangel_Main", place: 12, damage: 100 },
      { map: "Desert_Main", place: 5, damage: 200 },
    ]));
    expect(result).toEqual([
      { mapName: "에란겔", games: 2, averageRank: "6.5", top10Rate: "50%", averageDamage: "200" },
      { mapName: "미라마", games: 1, averageRank: "5.0", top10Rate: "100%", averageDamage: "200" },
    ]);
  });

  it("순위나 피해량이 없는 경기는 0으로 채우지 않고 제외한다", () => {
    const result = buildRecentMapOverview(fixture([
      { map: "Baltic_Main", place: 3, damage: 150 },
      { map: "Baltic_Main", damage: 400 },
      { map: "Baltic_Main", place: 20 },
    ]));
    expect(result).toEqual([{ mapName: "에란겔", games: 1, averageRank: "3.0", top10Rate: "100%", averageDamage: "150" }]);
  });

  it("데스매치와 미지원 맵은 제외한다", () => {
    const result = buildRecentMapOverview(fixture([
      { map: "PillarCompound_Main", place: 1, damage: 500 },
      { map: "Italy_TDM_Main", place: 1, damage: 500, mode: "tdm" },
      { map: "Baltic_Main", place: 1, damage: 500, mode: "tdm" },
      { map: "Haven_Main", place: 2, damage: 100 },
      { map: "Tiger_Main", place: 4, damage: 80 },
    ]));
    expect(result.map((row) => row.mapName)).toEqual(["태이고"]);
  });

  it("경기 수 내림차순으로 정렬하고 최대 5개 맵만 반환한다", () => {
    const counts: [string, number][] = [["Baltic_Main", 1], ["Desert_Main", 2], ["Savage_Main", 3], ["Summerland_Main", 3], ["Chimera_Main", 4], ["Tiger_Main", 5]];
    const rows: Row[] = counts.flatMap(([map, count]) => Array.from({ length: count }, () => ({ map, place: 10, damage: 100 })));
    const result = buildRecentMapOverview(fixture(rows));
    expect(result.map((row) => [row.mapName, row.games])).toEqual([["태이고", 5], ["파라모", 4], ["사녹", 3], ["카라킨", 3], ["미라마", 2]]);
  });

  it("집계할 경기가 없으면 카드를 숨기고 있으면 표로 보여 준다", () => {
    render(createElement(StatSummaryPanel, fixture([{ map: "PillarCompound_Main", place: 1, damage: 100 }])));
    expect(screen.queryByRole("heading", { name: "맵별 성적" })).not.toBeInTheDocument();
    cleanup();
    render(createElement(StatSummaryPanel, fixture([{ map: "Neon_Main", place: 7, damage: 250 }])));
    expect(screen.getByRole("heading", { name: "맵별 성적" })).toBeInTheDocument();
    expect(screen.getByTestId("map-overview-row")).toHaveTextContent(/론도.*1.*7\.0.*100%.*250/);
  });

  // 분석이 끝난 경기의 요약은 mapName이 한글 표시명이다(AnalysisEngine). 2026-10-30 KangHeeSung_ 최근 20경기 중
  // 분석이 없는 3경기만 집계돼 "태이고 2·론도 1"로 보였다.
  it("분석 요약의 한글 맵 이름과 기본 기록의 맵 ID를 같은 맵으로 집계한다", () => {
    const analysed = (id: string, mapName: string, winPlace: number, damageDealt: number) => buildMatchSummary({
      matchId: id, mapName, createdAt: "2026-10-29T00:00:00Z", gameMode: "duo", matchType: "competitive",
      stats: { kills: 1, damageDealt, winPlace },
    })!;
    const input = fixture([{ map: "Tiger_Main", place: 31, damage: 100 }, { map: "Neon_Main", place: 2, damage: 300 }]);
    input.matchIds = [...input.matchIds, "a-1", "a-2", "a-3", "a-4"];
    input.summaries = { ...input.summaries,
      "a-1": analysed("a-1", "미라마", 8, 200), "a-2": analysed("a-2", "미라마", 10, 400),
      "a-3": analysed("a-3", "태이고", 3, 500), "a-4": analysed("a-4", "필라 기지 (TDM)", 1, 900) };
    expect(buildRecentMapOverview(input)).toEqual([
      { mapName: "미라마", games: 2, averageRank: "9.0", top10Rate: "100%", averageDamage: "300" },
      { mapName: "태이고", games: 2, averageRank: "17.0", top10Rate: "50%", averageDamage: "300" },
      { mapName: "론도", games: 1, averageRank: "2.0", top10Rate: "100%", averageDamage: "300" },
    ]);
  });

  it("맵 ID와 한글 표시명을 맵 ID로 되돌리고 배틀로얄 맵이 아니면 null을 준다", () => {
    expect(toBattleRoyaleMapId("Desert_Main")).toBe("Desert_Main");
    expect(toBattleRoyaleMapId("에란겔")).toBe("Baltic_Main");
    expect(toBattleRoyaleMapId("론도")).toBe("Neon_Main");
    for (const value of ["PillarCompound_Main", "Haven_Main", "필라 기지 (TDM)", "", null, undefined]) expect(toBattleRoyaleMapId(value)).toBeNull();
  });
});
