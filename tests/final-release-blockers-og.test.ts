import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetSquadAnalysisData,
  mockImageResponse,
  mockFetch,
  MockImageResponse,
} = vi.hoisted(() => {
  const mockGetSquadAnalysisData = vi.fn();
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
  return { mockGetSquadAnalysisData, mockImageResponse, mockFetch, MockImageResponse };
});

vi.mock("next/og", () => ({ ImageResponse: MockImageResponse }));
vi.mock("@/lib/pubg-analysis/squadAnalysis", () => ({ getSquadAnalysisData: mockGetSquadAnalysisData }));

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
    expect(text).toContain("측정 불가");
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
      scores: { formation: 90, backupSpeed: 85, survivalCare: 80, focusFire: 75, teamWipe: 70 },
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

  it("fails closed when benchmark evidence is complete but user measurements are partial", async () => {
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
      scores: { formation: null, backupSpeed: 85, survivalCare: 80, focusFire: 75, teamWipe: 70 },
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
      scores: { formation: 90, backupSpeed: 90, survivalCare: 90, focusFire: 90, teamWipe: 90 },
      roleProfiles: [{ name: "Player_A" }],
      benchmarkStats: { tier: "A", avgIsolation: 1.3, avgTradeLatency: 9000, avgReviveRate: 20, avgSmokeRate: 10, avgTeamWipes: 2 },
    });

    await GET(new NextRequest(
      "http://localhost/api/og/squad?nickname=Player_A&platform=steam&groupKey=Teammate_B",
    ));

    const text = collectText(mockImageResponse.mock.calls[0][0]);
    expect(text).toContain("0.00초");
  });
});
