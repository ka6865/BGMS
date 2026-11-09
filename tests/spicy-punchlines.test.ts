import { describe, expect, it } from "vitest";
import { applyMatchSpicyJab, matchSpicyJab, summaryCardSpicyJab } from "@/lib/pubg-analysis/spicyPunchlines";
import { applyMatchAiEvidencePolicy } from "@/lib/pubg-analysis/matchAiEvidence";
import { findAiCoachingQualityFindings, sanitizeAiCoachingLanguageText } from "@/lib/pubg-analysis/aiCoachingQuality";
import { hasUnsupportedSummaryAdvice, hasUnsupportedSummaryInference } from "@/lib/pubg-analysis/aiSummaryJudgment";

const base = { matchId: "m1", stats: { processedDamageDealt: 300, timeSurvived: 1200, winPlace: 5, deathType: "byplayer" }, deathPhase: 6, duelStats: { totalDuels: 2, wins: 1 }, teamImpact: { totalTeamDamage: 600, teamDamageShare: 40 }, isolationData: { isolationIndex: 1.2 } };
const cases: Array<[string, any]> = [
  ["early_exit", { ...base, stats: { ...base.stats, timeSurvived: 120 }, deathPhase: 1 }],
  ["duel_losing", { ...base, duelStats: { totalDuels: 6, wins: 1 } }],
  ["quiet_gun", { ...base, stats: { ...base.stats, processedDamageDealt: 40 } }],
  ["share_tiny", { ...base, teamImpact: { totalTeamDamage: 900, teamDamageShare: 10 } }],
  ["far_from_team", { ...base, isolationData: { isolationIndex: 3 } }],
  ["chicken", { ...base, stats: { ...base.stats, winPlace: 1, deathType: "alive" } }],
  ["duel_winning", { ...base, duelStats: { totalDuels: 4, wins: 4 } }],
  ["damage_carry", { ...base, teamImpact: { totalTeamDamage: 900, teamDamageShare: 60 } }],
];

describe("spicy punchlines", () => {
  it.each(cases)("단일 경기 %s 한마디는 근거 정책을 다시 거쳐도 그대로 남고 한 번만 붙는다", (_id, match) => {
    const jab = matchSpicyJab(match);
    expect(jab).toBeTruthy();
    const once = applyMatchSpicyJab(JSON.stringify({ finalVerdict: "경기 기록을 확인했습니다." }), match);
    const reread = applyMatchSpicyJab(applyMatchAiEvidencePolicy(sanitizeAiCoachingLanguageText(once), match), match);
    expect(JSON.parse(reread).finalVerdict).toBe(`경기 기록을 확인했습니다. ${jab}`);
    expect(findAiCoachingQualityFindings(jab!, { blockingOnly: true })).toEqual([]);
  });

  it("못한 점을 먼저 비꼬고, 재료가 없으면 붙이지 않는다", () => {
    expect(matchSpicyJab({ ...base, stats: { ...base.stats, winPlace: 1 }, duelStats: { totalDuels: 6, wins: 1 } })).toMatch(/1:1/);
    expect(matchSpicyJab(base)).toBeNull();
    expect(matchSpicyJab({})).toBeNull();
    expect(applyMatchSpicyJab("not-json", cases[0][1])).toBe("not-json");
  });

  it("요약 한마디는 못 미친 지표를 비꼬고, 모두 평균 이상이면 인정하며, 비교 불가면 붙이지 않는다", () => {
    const ids = ["damage_average", "initiative_rate", "pressure_index", "counter_failure_rate", "reaction_latency", "duel_win_rate", "solo_kill_share", "death_phase", "isolation_average", "trade_success_rate", "backup_latency", "smoke_opportunity_rate"];
    for (const id of ids) {
      const jab = summaryCardSpicyJab([id], false, "ctx")!;
      expect(jab).toBeTruthy();
      expect(hasUnsupportedSummaryInference(jab) || hasUnsupportedSummaryAdvice(jab)).toBe(false);
      expect(findAiCoachingQualityFindings(jab, { blockingOnly: true })).toEqual([]);
    }
    expect(summaryCardSpicyJab([], true, "ctx")).toMatch(/인정|머쓱/);
    expect(summaryCardSpicyJab([], false, "ctx")).toBeNull();
  });
});
