import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/pubg/squad-analyze/route";

const { getSquadAnalysisData } = vi.hoisted(() => ({ getSquadAnalysisData: vi.fn() }));
vi.mock("@/lib/pubg-analysis/squadAnalysis", () => ({ getSquadAnalysisData }));
vi.mock("@/lib/pubg/privatePlayerGuard", () => ({ blockPrivatePlayer: vi.fn().mockResolvedValue(null) }));

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-06T12:00:00Z"));
  getSquadAnalysisData.mockReset();
});

describe("squad detail retention", () => {
  it("keeps squad aggregates and hides cause scenes tied to expired matches", async () => {
    getSquadAnalysisData.mockResolvedValue({
      matchCount: 8,
      stats: { totalRevives: 12 },
      matchesSummary: [
        { matchId: "old", createdAt: "2026-09-01T00:00:00Z" },
        { matchId: "new", createdAt: "2026-10-01T00:00:00Z" },
      ],
      causeScenes: [{ matchId: "old" }, { matchId: "new" }],
    });

    const response = await GET(new Request("http://localhost/api/pubg/squad-analyze?nickname=Player&platform=steam&groupKey=Squad"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.matchCount).toBe(8);
    expect(body.stats.totalRevives).toBe(12);
    expect(body.matchesSummary).toHaveLength(2);
    expect(body.causeScenes).toEqual([{ matchId: "new" }]);
  });
});
