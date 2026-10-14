import { describe, expect, it } from "vitest";
import { TEAM_BENCHMARK_MIN_SAMPLE, toTeamBenchmarkStats } from "@/lib/pubg-analysis/teamBenchmark";

const row = { sample_team_matches: 833, knocks: 3801, revives: 1379, trade_kills: 679, trade_latency_total_ms: 8_327_256,
  smoke_sample_team_matches: 833, smoke_knocks: 3801, smoke_rescues: 120 };

describe("팀 비교 기준", () => {
  it("팀 관측 합계로 소생률·복수 시간·연막 구출률을 만든다", () => {
    expect(toTeamBenchmarkStats(row, "squad")).toEqual({
      tier: null, scope: "team_population", teamMode: "squad", sampleCount: 833, avgIsolation: null,
      avgTradeLatency: 12_300, avgReviveRate: 36.3, avgSmokeRate: 3.2, avgTeamWipes: null,
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
});
