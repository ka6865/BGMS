import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYSIS_CALCULATION_VERSION, POPULATION_EVIDENCE_VERSION, RESULT_VERSION } from "@/lib/pubg-analysis/constants";

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mockCreateClient }));

type TeamMember = { name: string; damageDealt?: number; kills?: number; assists?: number; DBNOs?: number };

function matchRow(index: number, team: TeamMember[]) {
  const matchId = `match-${index}`;
  const createdAt = new Date(Date.UTC(2026, 8, 1, 0, 0, 30 - index)).toISOString();
  return {
    match_id: matchId,
    player_id: "player_a",
    platform: "steam",
    updated_at: createdAt,
    data: {
      fullResult: {
        matchId,
        player_id: "player_a",
        platform: "steam",
        v: RESULT_VERSION,
        calculationVersion: ANALYSIS_CALCULATION_VERSION,
        populationEvidenceVersion: POPULATION_EVIDENCE_VERSION,
        createdAt,
        gameMode: "squad-fpp",
        matchType: "official",
        mapName: "Baltic_Main",
        benchmark: { tier: "B", score: 50 },
        stats: { name: "Player_A", winPlace: 3, damageDealt: 100 },
        team: [{ name: "Player_A", damageDealt: 100, kills: 1, assists: 0, DBNOs: 0 }, ...team],
      },
    },
  };
}

// 실제 getSquadAnalysisData가 읽는 processed_match_telemetry와 팀 비교 기준 조회만 제공한다
function configureRows(rows: unknown[]) {
  const processed: any = {};
  for (const method of ["select", "eq", "order", "limit", "in"]) processed[method] = vi.fn().mockReturnValue(processed);
  processed.then = (resolve: any, reject: any) => Promise.resolve({ data: rows, error: null }).then(resolve, reject);
  const teamBenchmark: any = {};
  for (const method of ["select", "eq"]) teamBenchmark[method] = vi.fn().mockReturnValue(teamBenchmark);
  teamBenchmark.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  mockCreateClient.mockResolvedValue({
    from: vi.fn((table: string) => {
      if (table === "processed_match_telemetry") return processed;
      if (table === "pubg_team_benchmarks") return teamBenchmark;
      throw new Error(`unexpected table ${table}`);
    }),
  });
}

async function loadSquadAnalysis() {
  const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
  return getSquadAnalysisData;
}

beforeEach(() => {
  vi.resetModules();
  mockCreateClient.mockReset();
});

describe("PUBG Squad Synergy Analysis Tests", () => {
  it("groups squad matches by teammate composition and keeps the first-seen nickname casing", async () => {
    configureRows([
      matchRow(1, [{ name: "MiaeQ_Q" }, { name: "PlayerC" }, { name: "PlayerD" }]),
      matchRow(2, [{ name: "miaeq_q" }, { name: "PlayerC" }, { name: "PlayerD" }]),
    ]);
    const getSquadAnalysisData = await loadSquadAnalysis();

    const result: any = await getSquadAnalysisData("Player_A", "steam");

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      groupKey: "MiaeQ_Q, PlayerC, PlayerD",
      members: ["MiaeQ_Q", "PlayerC", "PlayerD"],
      matchCount: 2,
    });
  });

  it("keeps nicknames that differ only by special characters as different teammates", async () => {
    configureRows([
      matchRow(1, [{ name: "Mia.Q" }, { name: "PlayerC" }, { name: "PlayerD" }]),
      matchRow(2, [{ name: "MiaQ" }, { name: "PlayerC" }, { name: "PlayerD" }]),
    ]);
    const getSquadAnalysisData = await loadSquadAnalysis();

    const result: any = await getSquadAnalysisData("Player_A", "steam");

    expect(result.groups.map((group: any) => group.groupKey).sort()).toEqual([
      "Mia.Q, PlayerC, PlayerD",
      "MiaQ, PlayerC, PlayerD",
    ]);
  });

  it("assigns each member the role where they lead the squad share", async () => {
    // Player_A 행은 matchRow 기본값(딜량 100)이므로 딜량 1위가 되도록 덮어쓴다
    const rows = [matchRow(1, [
      { name: "Teammate_B", damageDealt: 200, kills: 1, assists: 0, DBNOs: 5 },
      { name: "Teammate_C", damageDealt: 300, kills: 5, assists: 0, DBNOs: 1 },
      { name: "Teammate_D", damageDealt: 150, kills: 0, assists: 8, DBNOs: 0 },
    ])];
    rows[0].data.fullResult.team[0] = { name: "Player_A", damageDealt: 800, kills: 2, assists: 1, DBNOs: 2 };
    configureRows(rows);
    const getSquadAnalysisData = await loadSquadAnalysis();

    const result: any = await getSquadAnalysisData("Player_A", "steam", "Teammate_B, Teammate_C, Teammate_D");
    const roleOf = (name: string) => result.roleProfiles.find((profile: any) => profile.name === name)?.role;

    expect(roleOf("Player_A")).toBe("메인 딜러");
    expect(roleOf("Teammate_B")).toBe("선봉장");
    expect(roleOf("Teammate_C")).toBe("해결사");
    expect(roleOf("Teammate_D")).toBe("지원가");
    expect(result.roleProfiles.find((profile: any) => profile.name === "Player_A")?.shares).toEqual({
      damage: 55, kill: 25, assist: 11, dbno: 25,
    });
  });
});
