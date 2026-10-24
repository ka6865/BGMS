import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LOL_CHALLENGE_KEYS, pickLolChallenges } from "@/lib/lol/challenges";
import { parseLolMasteries, summarizeLolChampionPerformance, lolMasteryBadge } from "@/lib/lol/mastery";
import LolMasteryCard from "@/components/lol/LolMasteryCard";
import type { LolPlayerMatchSummary } from "@/lib/lol/types";
import { challengeFixture } from "./fixtures/lol/challenges";

const sql = readFileSync("supabase/migrations/20261024030000_lol_summary_challenges.sql", "utf8");
const previous = readFileSync("supabase/migrations/20261023060000_lol_participant_identity.sql", "utf8");
function definition(source: string) {
  const start = source.indexOf("create or replace function public.upsert_lol_player_match_summaries(");
  return source.slice(start, source.indexOf("$$;", start) + 3);
}
const row = (values: Partial<LolPlayerMatchSummary> = {}) => ({
  champion_id: 103, champion_name: "Ahri", duration_seconds: 1800, remake: false, win: true, kills: 5, deaths: 2, assists: 7, ...values,
} as LolPlayerMatchSummary);
const mastery = { championId: 103, championLevel: 14, championPoints: 250000, lastPlayTime: 1790000000000 };

describe("challenges 영구 요약", () => {
  it("SQL 화이트리스트는 TS 및 확인한 가상 표본 31개와 일치한다", () => {
    const list = sql.match(/where key=any\(array\[([\s\S]*?)\]::text\[\]\)/)![1].match(/'[^']+'/g)!.map(key => key.slice(1, -1));
    expect(list).toEqual([...LOL_CHALLENGE_KEYS]);
    expect(list).toHaveLength(31);
    expect(list).toEqual(Object.keys(challengeFixture));
    expect(pickLolChallenges(challengeFixture)).toEqual(challengeFixture);
  });
  it("기존 추출기는 challenges 열·값·충돌 갱신 추가 외에 동일하다", () => {
    const next = definition(sql).replace("perks, teammates, challenges\n", "perks, teammates\n")
      .replace(/,\n    coalesce\(\(select jsonb_object_agg[\s\S]*?'\{\}'::jsonb\)/, "")
      .replace(", challenges=excluded.challenges;", ";");
    expect(next).toBe(definition(previous));
    expect(sql).toContain("select public.upsert_lol_player_match_summaries(null,null)");
    expect(sql).not.toContain("lol_benchmark_aggregates");
  });
  it("숫자만 선택하고 누락·타입 변경·비정상 값을 건너뛴다", () => {
    expect(pickLolChallenges({ soloKills: 0, maxCsAdvantageOnLaneOpponent: -5.5, kda: "4", skillshotsHit: true,
      goldPerMinute: Infinity, damagePerMinute: NaN, saveAllyFromDeath: null, unknown: 9 })).toEqual({ soloKills: 0, maxCsAdvantageOnLaneOpponent: -5.5 });
    for (const input of [undefined, null, [], "bad"]) expect(pickLolChallenges(input)).toEqual({});
  });
});

describe("숙련도와 최근 성과", () => {
  it("공식 필드만 전달하고 PUUID·보상 원문은 제거한다", () => {
    expect(parseLolMasteries([{ ...mastery, puuid: "fixture-secret", championPointsUntilNextLevel: 0,
      championSeasonMilestone: 2, nextSeasonMilestone: { secret: true } }])).toEqual([
      { ...mastery, championPointsUntilNextLevel: 0, championSeasonMilestone: 2 },
    ]);
  });
  it.each([null, {}, Array(11).fill(mastery), [mastery, mastery], [{ ...mastery, championPoints: -1 }],
    [{ ...mastery, championLevel: "14" }], [{ ...mastery, lastPlayTime: 9e15 }]])("잘못된 숙련도 응답을 거부한다: %j", input => {
    expect(() => parseLolMasteries(input)).toThrow();
  });
  it("영구 요약 합계로 KDA를 계산하고 다시하기·짧은 경기·승패 누락은 제외한다", () => {
    const result = summarizeLolChampionPerformance([row(), row({ win: false, kills: 1, deaths: 4, assists: 1 }),
      row({ remake: true }), row({ duration_seconds: 100 }), row({ win: null })]);
    expect(result[0]).toMatchObject({ games: 2, wins: 1, winRatePct: 50, kda: 14 / 6, perfect: false });
    expect(lolMasteryBadge(result[0], true)).toBeNull();
  });
  it("3판 이상에서만 독립된 승률·KDA 조건으로 배지를 붙인다", () => {
    const good = summarizeLolChampionPerformance([row(), row(), row()])[0];
    expect(lolMasteryBadge(good, true)).toBe("주력");
    expect(lolMasteryBadge(good, false)).toBe("떠오르는 챔피언");
    expect(lolMasteryBadge({ ...good, games: 2 }, true)).toBeNull();
    expect(lolMasteryBadge({ ...good, winRatePct: 30, kda: 1 }, true)).toBe("최근 부진");
    expect(lolMasteryBadge({ ...good, winRatePct: 50 }, true)).toBeNull();
  });
  it("무사망과 누락은 구분하고 표본 없는 챔피언을 배지로 평가하지 않는다", () => {
    const champions = summarizeLolChampionPerformance([row({ deaths: 0 }), row({ deaths: 0 }), row({ deaths: 0 })]);
    expect(champions[0]).toMatchObject({ kda: null, perfect: true });
    expect(summarizeLolChampionPerformance([row({ kills: null })])[0]).toMatchObject({ kda: null, perfect: false });
    const html = renderToStaticMarkup(createElement(LolMasteryCard, { mastery: { status: "ready", champions: [{ ...parseLolMasteries([mastery])[0],
      championName: "가상 챔피언", championImageId: "Ahri" }], recent: { status: "ready", sampleSize: 0, champions: [] } } }));
    expect(html).toContain("BGMS에 저장된 최근 0경기 기준");
    expect(html).toContain("최근 성과 표본 없음");
    expect(html).not.toContain('>주력<');
  });
  it("숙련도 실패와 성과 조회 실패를 각각 안내한다", () => {
    const html = renderToStaticMarkup(createElement(LolMasteryCard, { mastery: { status: "failed", champions: [],
      recent: { status: "unavailable", sampleSize: 0, champions: [] } } }));
    expect(html).toContain("숙련도 정보를 불러오지 못했습니다");
    expect(html).toContain("저장된 최근 성과를 불러오지 못했습니다");
  });
});
