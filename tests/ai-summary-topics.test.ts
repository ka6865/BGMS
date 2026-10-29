import { describe, expect, it } from "vitest";
import { DEFAULT_SUMMARY_TOPICS, selectSummaryDebateTopics } from "../lib/pubg-analysis/aiSummaryTopics";

// 2026-10-29 운영 요약에서 확인한 값(듀오 경쟁전 B, 104경기 비교 기준)을 줄였다.
const miaeqStats = {
  avgDamage: 231.3, userInitiativeRate: null, avgDuelWinRate: 66.7,
  totalTradeKills: 1, totalTeammateKnocks: 4, avgBackupLatency: "15.34s",
  totalUtilityThrows: 20, avgIsolationStr: "0.3", rawMetricValues: { isolation_average: 0.27 }, avgDeathPhase: 5,
};
const duoBBench = {
  sampleCount: 104,
  avgDamage: 220.1, avgDuelWinRate: 54.2, avgTradeRate: 14.3, avgTradeLatency: 10.5, avgIsolationIndex: 1.0,
  metricSampleCounts: { avgDamage: 104, avgDuelWinRate: 10, avgTradeRate: 7, avgTradeLatency: 4, avgIsolationIndex: 101 },
};

describe("summary debate topic selection", () => {
  it("does not choose topics whose comparison would be withheld for a small sample", () => {
    const topics = selectSummaryDebateTopics(miaeqStats, duoBBench, { userTradeRate: 25 });
    expect(topics.slice(0, 2)).toEqual(["포지셔닝", "화력"]);
    expect(topics).not.toContain("1:1 결정력");
    expect(topics).not.toContain("복수 성공률 및 백업");
  });

  it("keeps a comparable metric with enough samples as a topic", () => {
    const bench = { ...duoBBench, metricSampleCounts: { ...duoBBench.metricSampleCounts, avgDuelWinRate: 30 } };
    expect(selectSummaryDebateTopics(miaeqStats, bench, { userTradeRate: 25 })).toEqual(["포지셔닝", "1:1 결정력", "화력"]);
  });

  it("ranks comparable topics before user-only topics even when the user-only gap is larger", () => {
    const topics = selectSummaryDebateTopics({ ...miaeqStats, totalUtilityThrows: 2 }, duoBBench, { userTradeRate: 25 });
    expect(topics).toEqual(["포지셔닝", "화력", "유틸리티 활용"]);
  });

  it("fills with user-only topics when nothing is comparable", () => {
    const bench = { ...duoBBench, metricSampleCounts: { avgDamage: 29, avgIsolationIndex: 29 } };
    expect(selectSummaryDebateTopics(miaeqStats, bench, { userTradeRate: 25 })).toEqual(["유틸리티 활용", "포지셔닝", "생존 운영"]);
    expect(selectSummaryDebateTopics(miaeqStats, null, { userTradeRate: 25 })).toEqual(["유틸리티 활용", "포지셔닝", "생존 운영"]);
    expect(selectSummaryDebateTopics(null, duoBBench, { userTradeRate: null })).toEqual([...DEFAULT_SUMMARY_TOPICS]);
  });

  it("never repeats positioning when it is both comparable and a fill topic", () => {
    const topics = selectSummaryDebateTopics({ ...miaeqStats, avgIsolationStr: "4.0", rawMetricValues: { isolation_average: 4 } }, duoBBench, { userTradeRate: 25 });
    expect(new Set(topics).size).toBe(topics.length);
    expect(topics[0]).toBe("포지셔닝");
  });
});
