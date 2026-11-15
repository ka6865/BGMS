import { describe, expect, it } from "vitest";
import { sumTeamBenchmarkRows, TEAM_BENCHMARK_MIN_SAMPLE, toTeamBenchmarkStats } from "@/lib/pubg-analysis/teamBenchmark";

const row = { sample_team_matches: 833, knocks: 3801, revives: 1379, trade_kills: 679, trade_latency_total_ms: 8_327_256,
  smoke_sample_team_matches: 833, smoke_knocks: 3801, smoke_rescues: 120 };

describe("팀 비교 기준", () => {
  it("팀 관측 합계로 소생률·복수 시간·연막 구출률을 만든다", () => {
    expect(toTeamBenchmarkStats(row, "squad")).toEqual({
      tier: null, scope: "team_population", teamMode: "squad", sampleCount: 833, avgIsolation: null,
      avgTradeLatency: 12_300, avgReviveRate: 36.3, avgSmokeRate: 3.2, avgTeammateKnocks: 4.6, avgTradeableTradeRate: null, avgTeamWipes: null,
    });
  });
  it("표본이 부족하면 비교값을 만들지 않는다", () => {
    expect(toTeamBenchmarkStats({ ...row, sample_team_matches: TEAM_BENCHMARK_MIN_SAMPLE - 1 }, "duo")).toBeNull();
    expect(toTeamBenchmarkStats(null, "duo")).toBeNull();
  });
  it("관측이 모순되면 비교값을 만들지 않는다", () => {
    expect(toTeamBenchmarkStats({ ...row, revives: row.knocks + 1 }, "squad")).toBeNull();
    expect(toTeamBenchmarkStats({ ...row, trade_kills: -1 }, "squad")).toBeNull();
  });
  it("연막 구출은 완전한 관측 표본이 부족하면 보류한다", () => {
    expect(toTeamBenchmarkStats({ ...row, smoke_sample_team_matches: 10 }, "squad")?.avgSmokeRate).toBeNull();
    expect(toTeamBenchmarkStats({ ...row, trade_kills: 0, trade_latency_total_ms: 0 }, "squad")?.avgTradeLatency).toBeNull();
  });
  it("잡을 수 있었던 기절 복수 성공률은 기록된 경기가 표본 기준 이상일 때만 만든다", () => {
    const tradeable = { tradeable_sample_team_matches: 320, tradeable_knocks: 1000, tradeable_trade_kills: 254 };
    expect(toTeamBenchmarkStats({ ...row, ...tradeable }, "squad")?.avgTradeableTradeRate).toBe(25.4);
    expect(toTeamBenchmarkStats({ ...row, ...tradeable, tradeable_sample_team_matches: 299 }, "squad")?.avgTradeableTradeRate).toBeNull();
    expect(toTeamBenchmarkStats({ ...row, ...tradeable, tradeable_trade_kills: 1001 }, "squad")?.avgTradeableTradeRate).toBeNull();
  });
  it("migration 전 행처럼 잡을 수 있었던 기절 열이 없으면 그 값만 비운다", () => {
    const tradeable = { tradeable_sample_team_matches: 200, tradeable_knocks: 600, tradeable_trade_kills: 150 };
    const both = sumTeamBenchmarkRows([{ ...row, ...tradeable }, { ...row, ...tradeable }]);
    expect(both).toMatchObject({ sample_team_matches: 1666, tradeable_sample_team_matches: 400, tradeable_knocks: 1200 });
    const mixed = sumTeamBenchmarkRows([{ ...row, ...tradeable }, row]);
    expect(mixed).toMatchObject({ sample_team_matches: 1666 });
    expect(mixed?.tradeable_knocks).toBeUndefined();
    expect(toTeamBenchmarkStats(mixed, "squad")).toMatchObject({ avgReviveRate: 36.3, avgTradeableTradeRate: null });
  });
});
