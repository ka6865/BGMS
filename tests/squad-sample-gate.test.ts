import { describe, expect, it } from "vitest";
import { buildSquadAiCoachingPrompt } from "@/lib/pubg-analysis/squadAiCoachingPrompt";
import { applySquadEvidencePolicy } from "@/lib/pubg-analysis/squadAiEvidence";
import {
  isSquadReviveRateEvaluable,
  isSquadTradeLatencyEvaluable,
  SQUAD_MIN_KNOCKS,
  SQUAD_MIN_TRADE_KILLS,
} from "@/lib/pubg-analysis/squadEvidenceSamples";
import { selectSquadPunchlines } from "@/lib/pubg-analysis/squadPunchlines";

// 듀오 KangHeeSung_ 집계와 같은 모양의 입력이다. 표본 값만 테스트마다 바꾼다.
function stats(overrides: Record<string, unknown> = {}) {
  return {
    avgIsolation: null,
    avgTradeLatency: 15344,
    totalTradeKills: 1,
    totalTeammateKnocks: 9,
    totalRevives: 3,
    totalSmokeRescues: 1,
    avgCoverRate: null,
    totalTeamWipes: null,
    ...overrides,
  };
}

const benchmark = {
  tier: null, scope: "team_population", teamMode: "duo", sampleCount: 540,
  avgIsolation: null, avgTradeLatency: 10400, avgReviveRate: 34.6, avgSmokeRate: 3.9, avgTeamWipes: null,
};

const roleProfiles = [
  { name: "KangHeeSung_", role: "메인 딜러", roleDesc: "주력 화력", avgDamage: 374, avgKills: 2.4, avgAssists: 0.4, avgDbnos: 1.8, totalDamage: 1870, totalKills: 12, shares: { damage: 73, kill: 67, assist: 67, dbno: 69 } },
  { name: "MiaeQ_Q", role: "전술가", roleDesc: "운영", avgDamage: 139, avgKills: 1.2, avgAssists: 0.2, avgDbnos: 0.8, totalDamage: 695, totalKills: 6, shares: { damage: 27, kill: 33, assist: 33, dbno: 31 } },
];

function promptFor(style: "spicy" | "mild", statsOverrides: Record<string, unknown> = {}) {
  return buildSquadAiCoachingPrompt({
    groupKey: "듀오 · MiaeQ_Q",
    stats: stats(statsOverrides),
    scores: { formation: null, backupSpeed: null, survivalCare: null, focusFire: null, teamWipe: null },
    roleProfiles,
    nickname: "KangHeeSung_",
    coachingStyle: style,
    squadGrade: null,
    benchmarkStats: benchmark,
    matchCount: 5,
    teamMode: "duo",
    matchesSummary: [3, 8, 12, 20, 5, 9, 14, 2, 18, 11].map((winPlace) => ({ winPlace })),
  });
}

describe("squad sample thresholds", () => {
  it("fixes the trade and knock minimums shared with the punchline selector", () => {
    expect(SQUAD_MIN_TRADE_KILLS).toBe(3);
    expect(SQUAD_MIN_KNOCKS).toBe(5);
  });

  it("treats backup speed as evaluable only with three measured trade kills", () => {
    expect(isSquadTradeLatencyEvaluable(stats({ totalTradeKills: 2 }))).toBe(false);
    expect(isSquadTradeLatencyEvaluable(stats({ totalTradeKills: 3 }))).toBe(true);
    expect(isSquadTradeLatencyEvaluable(stats({ totalTradeKills: null }))).toBe(false);
    expect(isSquadTradeLatencyEvaluable(stats({ totalTradeKills: undefined }))).toBe(false);
    expect(isSquadTradeLatencyEvaluable(stats({ avgTradeLatency: null, totalTradeKills: 5 }))).toBe(false);
  });

  it("treats the revive rate as evaluable only with five knocks and revives within knocks", () => {
    expect(isSquadReviveRateEvaluable(stats({ totalTeammateKnocks: 4, totalRevives: 1 }))).toBe(false);
    expect(isSquadReviveRateEvaluable(stats({ totalTeammateKnocks: 5, totalRevives: 1 }))).toBe(true);
    expect(isSquadReviveRateEvaluable(stats({ totalTeammateKnocks: 5, totalRevives: 6 }))).toBe(false);
    expect(isSquadReviveRateEvaluable(stats({ totalTeammateKnocks: null }))).toBe(false);
  });
});

describe("squad prompt backup gate", () => {
  it.each(["spicy", "mild"] as const)("omits the backup numbers and comparison when the sample is short (%s)", (style) => {
    const { prompt, systemInstruction } = promptFor(style, { totalTradeKills: 1 });
    for (const text of [prompt, systemInstruction]) {
      expect(text).not.toContain("15.34");
      expect(text).not.toContain("10.40");
      expect(text).not.toContain("15.3초");
      expect(text).not.toContain("10.4초");
    }
    expect(prompt).toContain("표본 부족으로 백업 속도는 평가하지 않음 (복수 1건, 3건 이상 필요)");
    expect(prompt).toContain("- Global Avg Backup Speed (백업 반응 속도): 표본 부족으로 비교하지 않음");
    expect(systemInstruction).toContain("Backup speed is NOT evaluable for this squad (fewer than 3 measured trade kills).");
  });

  it.each(["spicy", "mild"] as const)("includes the backup numbers and comparison when the sample is sufficient (%s)", (style) => {
    const { prompt, systemInstruction } = promptFor(style, { totalTradeKills: 3 });
    expect(prompt).toContain("15.34초");
    expect(prompt).toContain("10.40초");
    expect(prompt).toContain("- Global Avg Backup Speed (백업 반응 속도): 10.40초 (Our Squad Avg: 15.34초)");
    expect(systemInstruction).not.toContain("NOT evaluable for this squad (fewer than 3 measured trade kills)");
  });

  it("uses the same threshold as the punchline selector, so a short sample is absent from both", () => {
    const short = promptFor("spicy", { totalTradeKills: SQUAD_MIN_TRADE_KILLS - 1 });
    const enough = promptFor("spicy", { totalTradeKills: SQUAD_MIN_TRADE_KILLS });
    expect(short.prompt).not.toContain("백업 속도 평균");
    expect(enough.prompt).toContain("15.34초");
    const picks = selectSquadPunchlines({
      stats: stats({ totalTradeKills: SQUAD_MIN_TRADE_KILLS - 1 }), benchmarkStats: benchmark, roleProfiles, matchesSummary: [],
    });
    expect(picks.map((item) => item.id)).not.toContain("backup_slow");
  });

  it("does not put the backup score into the report when the sample is short", () => {
    const { prompt } = buildSquadAiCoachingPrompt({
      groupKey: "g", stats: stats({ totalTradeKills: 1 }),
      scores: { formation: 70, backupSpeed: 75, survivalCare: 80, focusFire: 76, teamWipe: 65 },
      roleProfiles, nickname: "KangHeeSung_", coachingStyle: "spicy", benchmarkStats: benchmark, matchCount: 5, teamMode: "duo",
    });
    expect(prompt).toContain("- Backup Trade Speed (백업 속도): 표본 부족으로 평가하지 않음");
  });
});

describe("squad prompt revive and smoke gate", () => {
  it("hides the global revive rate when the knock sample is short", () => {
    const { prompt, systemInstruction } = promptFor("spicy", { totalTeammateKnocks: 4, totalRevives: 2 });
    expect(prompt).not.toContain("34.6%");
    expect(prompt).toContain("- Global Avg Revive Success Rate (부활 성공률): 표본 부족으로 비교하지 않음 (아군 기절 4회, 5회 이상 필요)");
    expect(systemInstruction).toContain("Revive rate is NOT evaluable for this squad (fewer than 5 measured knocks).");
  });

  it("shows the team revive rate next to the global rate when the knock sample is enough", () => {
    const { prompt, systemInstruction } = promptFor("mild", { totalTeammateKnocks: 10, totalRevives: 4 });
    expect(prompt).toContain("- Global Avg Revive Success Rate (부활 성공률): 34.6% (Our Squad Revive Rate: 40%, 아군 기절 10회 중 4회 부활)");
    expect(systemInstruction).not.toContain("Revive rate is NOT evaluable");
  });

  it("never prints the global smoke rate, since no team smoke rate is computed to compare with", () => {
    for (const style of ["spicy", "mild"] as const) {
      const { prompt } = promptFor(style, { totalTeammateKnocks: 12, totalSmokeRescues: 3 });
      expect(prompt).not.toContain("3.9%");
      expect(prompt).toContain("팀 연막 구출률은 산출하지 않으므로 비교하지 않음");
    }
  });
});

describe("squad evidence backup gate", () => {
  const emptyScores = { survivalCare: null };
  it("withholds a backup sentence with a short trade sample, even when the value is present", () => {
    const result = applySquadEvidencePolicy({ summary: "백업 속도는 15.34초입니다." }, stats({ totalTradeKills: 1 }), null, emptyScores, [], { coachingStyle: "mild" });
    expect(result.summary).not.toContain("15.34");
    expect(result.summary).toContain("보류");
  });

  it("keeps the same backup sentence when the trade sample is enough, and spicy uses the pass wording", () => {
    const mild = applySquadEvidencePolicy({ summary: "백업 속도는 15.34초입니다." }, stats({ totalTradeKills: 3 }), null, emptyScores, [], { coachingStyle: "mild" });
    expect(mild.summary).toBe("백업 속도는 15.34초입니다.");
    const spicy = applySquadEvidencePolicy({ summary: "백업 속도는 15.34초입니다." }, stats({ totalTradeKills: 1 }), null, emptyScores, [], { coachingStyle: "spicy" });
    expect(spicy.summary).toBe("백업 속도 기록이 없어서 오늘은 봐드립니다.");
  });
});
