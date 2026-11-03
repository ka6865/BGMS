import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetSquadAnalysisData,
  mockIsPlayerPrivate,
  mockImageResponse,
  mockFetch,
  MockImageResponse,
} = vi.hoisted(() => {
  const mockGetSquadAnalysisData = vi.fn();
  const mockIsPlayerPrivate = vi.fn();
  const mockImageResponse = vi.fn();
  const mockFetch = vi.fn();
  class MockImageResponse {
    constructor(element: unknown, options: unknown) {
      mockImageResponse(element, options);
      return new Response("mock-image", {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
  }
  return { mockGetSquadAnalysisData, mockIsPlayerPrivate, mockImageResponse, mockFetch, MockImageResponse };
});

vi.mock("next/og", () => ({ ImageResponse: MockImageResponse }));
vi.mock("@/lib/pubg-analysis/squadAnalysis", () => ({ getSquadAnalysisData: mockGetSquadAnalysisData }));
vi.mock("@/lib/pubg/privatePlayers", () => ({ isPlayerPrivate: mockIsPlayerPrivate }));
vi.mock("@/lib/pubg/privatePlayerIdentity", () => ({ resolvePrivatePlayerAccountId: vi.fn().mockResolvedValue(null) }));

import { GET } from "@/app/api/og/squad/route";

function collectText(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string" || typeof value === "number") {
    output.push(String(value));
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((child) => collectText(child, output));
    return output;
  }
  if (value && typeof value === "object") {
    const candidate = value as { props?: unknown; children?: unknown };
    if ("props" in candidate) collectText(candidate.props, output);
    else if ("children" in candidate) collectText(candidate.children, output);
  }
  return output;
}

describe("squad OG benchmark-unavailable state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    mockIsPlayerPrivate.mockResolvedValue(false);
  });

  it("does not render a private player's squad metrics", async () => {
    mockIsPlayerPrivate.mockResolvedValue(true);
    const response = await GET(new NextRequest(
      "http://localhost/api/og/squad?nickname=Private_Player&platform=steam&groupKey=Teammate_B",
    ));

    expect(response.status).toBe(403);
    expect(mockGetSquadAnalysisData).not.toHaveBeenCalled();
  });

  it("does not render a synthetic grade or score when benchmark data is unavailable", async () => {
    mockGetSquadAnalysisData.mockRejectedValue(new Error("Squad benchmark data unavailable."));

    const response = await GET(new NextRequest(
      "http://localhost/api/og/squad?nickname=Player_A&platform=steam&groupKey=Teammate_B",
    ));

    expect(response.status).toBe(200);
    expect(mockImageResponse).toHaveBeenCalledOnce();
    const text = collectText(mockImageResponse.mock.calls[0][0]);
    expect(text).toContain("분석 데이터 준비 중");
    expect(text).toContain("미측정");
    expect(text.filter((entry) => entry === "B")).toHaveLength(0);
    expect(text).not.toContain("50점");
  });

  it("does not treat a grade-only partial analysis as measured data", async () => {
    mockGetSquadAnalysisData.mockResolvedValue({ squadGrade: "B" });

    const response = await GET(new NextRequest(
      "http://localhost/api/og/squad?nickname=Player_A&platform=steam&groupKey=Teammate_B",
    ));

    expect(response.status).toBe(200);
    const text = collectText(mockImageResponse.mock.calls[0][0]);
    expect(text).toContain("분석 데이터 준비 중");
    expect(text.filter((entry) => entry === "B")).toHaveLength(0);
    expect(text).not.toContain("50점");
  });

  it("keeps measured grade and scores when canonical analysis succeeds", async () => {
    mockGetSquadAnalysisData.mockResolvedValue({
      squadGrade: "A",
      gradeBasis: { measuredAxes: 5, totalAxes: 5, score: 80 },
      matchCount: 5,
      stats: {
        avgIsolation: 1.2,
        avgTradeLatency: 7000,
        totalSmokeRescues: 2,
        totalRevives: 3,
        avgCoverRate: 0.4,
        totalTeamWipes: 2,
        totalTeammateKnocks: 4,
      },
      scores: { survivalCare: 90, backupSpeed: 85, smokeRescue: 80, damageBalance: 75, placement: 70 },
      roleProfiles: [{ name: "Player_A" }, { name: "Teammate_B" }],
      benchmarkStats: { tier: "A", avgIsolation: 1.3, avgTradeLatency: 9000, avgReviveRate: 20, avgSmokeRate: 10, avgTeamWipes: 2 },
    });

    const response = await GET(new NextRequest(
      "http://localhost/api/og/squad?nickname=Player_A&platform=steam&groupKey=Teammate_B",
    ));

    expect(response.status).toBe(200);
    const text = collectText(mockImageResponse.mock.calls[0][0]);
    expect(text).toContain("A");
    expect(text).toContain("90점");
    expect(text).not.toContain("분석 데이터 준비 중");
  });

  it("fails closed when the server did not report enough measured axes", async () => {
    mockGetSquadAnalysisData.mockResolvedValue({
      squadGrade: "B",
      matchCount: 5,
      stats: {
        avgIsolation: null,
        avgTradeLatency: 7000,
        totalSmokeRescues: 2,
        totalRevives: 3,
        avgCoverRate: 0.4,
        totalTeamWipes: 2,
        totalTeammateKnocks: 4,
      },
      scores: { survivalCare: null, backupSpeed: 85, smokeRescue: 80, damageBalance: 75, placement: 70 },
      benchmarkStats: { tier: "B", avgIsolation: 1.3, avgTradeLatency: 9000, avgReviveRate: 20, avgSmokeRate: 10, avgTeamWipes: 2 },
      roleProfiles: [{ name: "Player_A" }],
    });

    const response = await GET(new NextRequest(
      "http://localhost/api/og/squad?nickname=Player_A&platform=steam&groupKey=Teammate_B",
    ));

    expect(response.status).toBe(200);
    const text = collectText(mockImageResponse.mock.calls[0][0]);
    expect(text).toContain("분석 데이터 준비 중");
    expect(text.filter((entry) => entry === "B")).toHaveLength(0);
    expect(text).not.toContain("70점");
  });

  it("renders a measured zero latency instead of treating it as unavailable", async () => {
    mockGetSquadAnalysisData.mockResolvedValue({
      squadGrade: "A",
      gradeBasis: { measuredAxes: 5, totalAxes: 5, score: 90 },
      matchCount: 1,
      stats: {
        avgIsolation: 1,
        avgTradeLatency: 0,
        totalSmokeRescues: 1,
        totalRevives: 1,
        avgCoverRate: 0.5,
        totalTeamWipes: 1,
        totalTeammateKnocks: 1,
      },
      scores: { survivalCare: 90, backupSpeed: 90, smokeRescue: 90, damageBalance: 90, placement: 90 },
      roleProfiles: [{ name: "Player_A" }],
      benchmarkStats: { tier: "A", avgIsolation: 1.3, avgTradeLatency: 9000, avgReviveRate: 20, avgSmokeRate: 10, avgTeamWipes: 2 },
    });

    await GET(new NextRequest(
      "http://localhost/api/og/squad?nickname=Player_A&platform=steam&groupKey=Teammate_B",
    ));

    const text = collectText(mockImageResponse.mock.calls[0][0]);
    expect(text).toContain("0.00초");
  });

  const request = () => new NextRequest("http://localhost/api/og/squad?nickname=Player_A&platform=steam&groupKey=Teammate_B");

  it("측정 항목이 3개 미만이면 등급이 있어도 준비 중 상태로 둔다", async () => {
    mockGetSquadAnalysisData.mockResolvedValue({
      squadGrade: "B",
      gradeBasis: { measuredAxes: 2, totalAxes: 5, score: 60 },
      matchCount: 5,
      scores: { survivalCare: 80, backupSpeed: null, smokeRescue: null, damageBalance: 70, placement: null },
      roleProfiles: [{ name: "Player_A" }],
    });
    await GET(request());
    const text = collectText(mockImageResponse.mock.calls[0][0]);
    expect(text).toContain("분석 데이터 준비 중");
    expect(text.filter((entry) => entry === "B")).toHaveLength(0);
  });

  it("벤치마크와 고립도 값이 없어도 측정 4/5 항목으로 등급을 그리고 미측정 항목은 표시한다", async () => {
    mockGetSquadAnalysisData.mockResolvedValue({
      squadGrade: "B+",
      gradeBasis: { measuredAxes: 4, totalAxes: 5, score: 52.1 },
      matchCount: 6,
      recordedSummary: { windowDays: 14, total: 19, analyzed: 6, wins: 2 },
      stats: { avgIsolation: null, avgTradeLatency: 12409, totalRevives: 14, totalTeammateKnocks: 33 },
      scores: { survivalCare: 71, backupSpeed: null, smokeRescue: 36, damageBalance: 24, placement: 48 },
      roleProfiles: [{ name: "Player_A" }, { name: "B" }, { name: "C" }, { name: "D" }],
      benchmarkStats: { tier: null },
    });
    await GET(request());
    const text = collectText(mockImageResponse.mock.calls[0][0]);
    expect(text).toContain("B+");
    expect(text).toContain("71점");
    expect(text).toContain("미측정");
    expect(text).toContain("12.41초");
    expect(text.join("")).toContain("측정 4/5 항목");
    expect(text.join("")).toContain("최근 14일 19경기 중 상세 분석 가능한 6경기 기준");
    expect(text).not.toContain("분석 데이터 준비 중");
  });
});
