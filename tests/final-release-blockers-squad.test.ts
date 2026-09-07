import { beforeEach, describe, expect, it, vi } from "vitest";
import { POPULATION_EVIDENCE_VERSION, RESULT_VERSION } from "@/lib/pubg-analysis/constants";
import { buildSquadAiCoachingPrompt } from "@/lib/pubg-analysis/squadAiCoachingPrompt";
import type { SquadObservation } from "@/lib/pubg-analysis/squadObservations";
const { mockCreateClient }=vi.hoisted(()=>({mockCreateClient:vi.fn()}));
vi.mock("@/utils/supabase/server",()=>({createClient:mockCreateClient}));
function queryChain(result:any){
  const chain:any={};for(const method of ["select","eq","order","limit","in"])chain[method]=vi.fn().mockReturnValue(chain);
  chain.then=(resolve:any,reject:any)=>Promise.resolve(result).then(resolve,reject);return chain;
}
function configureSquadClient(processed:any){
  const benchmarkChains:any[]=[];
  const from=vi.fn((table:string)=>{if(table==='processed_match_telemetry')return processed;benchmarkChains.push(table);throw new Error('Personal benchmark must not be queried for a squad');});
  mockCreateClient.mockResolvedValue({from});return {from,benchmarkChains};
}
const observation=(extra:Partial<SquadObservation>={}):SquadObservation=>({version:1,scope:'squad',teamAccountIds:['a','b'],status:'observed',issues:[],knocks:3,revives:1,smokeRescues:0,tradeKills:1,tradeLatencyTotalMs:6000,...extra});
function canonicalRow(index: number, overrides: Record<string, any> = {}) {
  const matchId = `match-${index}`;
  const createdAt = new Date(Date.UTC(2026, 8, 1, 0, 0, 12 - index)).toISOString();
  const fullResult = {
    matchId,
    player_id: "player_a",
    platform: "steam",
    v: RESULT_VERSION,
    calculationVersion: 2,
    populationEvidenceVersion: POPULATION_EVIDENCE_VERSION,
    createdAt,
    gameMode: "squad-fpp",
    matchType: "official",
    mapName: "Baltic_Main",
    benchmark: { tier: "B", score: index },
    stats: { name: "Player_A", playerId: "a", winPlace: index, damageDealt: index * 100 },
    isolationData: { isolationIndex: 1 + index / 100 },
    tradeStats: { tradeLatencyMs: 7_000 + index, coverRate: 0.4, teammateKnocks: 1 },
    team: [
      { name: "Player_A", playerId: "a", damageDealt: index * 100, kills: index, assists: 0, DBNOs: 1 },
      { name: "Teammate_B", playerId: "b", damageDealt: 100, kills: 1, assists: 1, DBNOs: 0 },
    ],
    ...overrides,
  };
  return {
    match_id: matchId,
    player_id: "player_a",
    platform: "steam",
    updated_at: createdAt,
    data: { fullResult },
  };
}

describe("strict squad analysis population and scope",()=>{
  beforeEach(()=>{vi.resetModules();});
  it("filters non-human/non-BR rows, selects latest ten, then best five only within that ten", async () => {
    const rowsByIndex = new Map(
      Array.from({ length: 12 }, (_, index) => [index + 1, canonicalRow(index + 1)] as const),
    );
    // Deliberately adversarial source order: the database query's arrival
    // order must not become the latest-ten order.
    const rows = [
      rowsByIndex.get(8),
      rowsByIndex.get(2),
      rowsByIndex.get(12),
      rowsByIndex.get(5),
      rowsByIndex.get(1),
      rowsByIndex.get(11),
      rowsByIndex.get(4),
      rowsByIndex.get(10),
      rowsByIndex.get(3),
      rowsByIndex.get(9),
      rowsByIndex.get(6),
      rowsByIndex.get(7),
      // Same canonical ID as match-5, but an older/lower-quality payload.
      canonicalRow(5, {
        createdAt: "2026-08-01T00:00:00.000Z",
        benchmark: { score: 0 },
        stats: { name: "Player_A", winPlace: 99, damageDealt: 1 },
      }),
      canonicalRow(20, { gameMode: "squad-fpp", matchType: "official", benchmark: { score: 100 } }),
      canonicalRow(21, { gameMode: "squad-fpp", matchType: "official", populationEvidenceVersion: undefined }),
      canonicalRow(22, { gameMode: "squad-fpp", matchType: "tdm" }),
      canonicalRow(23, { gameMode: "squad-fpp", matchType: "custom" }),
      canonicalRow(24, { gameMode: "squad-fpp", isBotMatch: true }),
      canonicalRow(25, { gameMode: "unknown", matchType: "official" }),
    ];

    const processed = queryChain({ data: rows, error: null });
    const { benchmarkChains } = configureSquadClient(processed);
    const { getSquadAnalysisData } = await import("@/lib/pubg-analysis/squadAnalysis");
    const result = await getSquadAnalysisData("Player_A", "steam", "Teammate_B");
    const analysis = result as any;

    expect(analysis.matchesSummary).toHaveLength(10);
    expect(analysis.matchesSummary.map((match: any) => match.matchId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `match-${index + 1}`),
    );
    expect(analysis.matchesSummary.find((match: any) => match.matchId === "match-5")?.winPlace).toBe(5);
    expect(analysis.selectedMatchIds).toHaveLength(5);
    expect(analysis.selectedMatchIds).toEqual([
      "match-10",
      "match-9",
      "match-8",
      "match-7",
      "match-6",
    ]);
    expect(analysis.selectedMatchIds).not.toContain("match-20");
    expect(analysis.bestMatchCount).toBe(5);
    expect(analysis.latestMatchCount).toBe(10);
    expect(processed.limit).toHaveBeenCalledWith(100);
    expect(benchmarkChains).toHaveLength(0);
  });


  it('never substitutes individual legacy fields or benchmarks for team observations',async()=>{
    const row=canonicalRow(1,{isolationData:{isolationIndex:.5},tradeStats:{teammateKnocks:1,revCount:9,smokeRescues:8,tradeLatencyMs:100,enemyTeamWipes:7,coverRate:100,coverRateSampleCount:10}});
    const {from}=configureSquadClient(queryChain({data:[row],error:null}));
    const {getSquadAnalysisData}=await import('@/lib/pubg-analysis/squadAnalysis');
    const a:any=await getSquadAnalysisData('Player_A','steam','Teammate_B');
    expect(a.stats).toEqual({avgIsolation:null,avgTradeLatency:null,totalSmokeRescues:null,totalRevives:null,avgCoverRate:null,totalTeamWipes:null,totalTeammateKnocks:null,totalTradeKills:null});
    expect(Object.values(a.scores)).toEqual([null,null,null,null,null]);expect(a.squadGrade).toBeNull();
    expect(Object.values(a.benchmarkStats).every(v=>v===null)).toBe(true);
    expect(from).toHaveBeenCalledTimes(1);expect(a.roleProfiles).toHaveLength(2);
  });
  it('weights team trade events and uses the same team recovery denominator',async()=>{
    const rows=[canonicalRow(1,{squadObservation:observation({tradeLatencyTotalMs:2000})}),canonicalRow(2,{squadObservation:observation({knocks:5,revives:2,tradeKills:2,tradeLatencyTotalMs:12000})})];
    configureSquadClient(queryChain({data:rows,error:null}));const {getSquadAnalysisData}=await import('@/lib/pubg-analysis/squadAnalysis');
    const a:any=await getSquadAnalysisData('Player_A','steam','Teammate_B');
    expect(a.stats).toMatchObject({avgTradeLatency:4667,totalTeammateKnocks:8,totalRevives:3,totalTradeKills:3,totalSmokeRescues:0});
    expect(a.squadGrade).toBeNull();
    const prompt=buildSquadAiCoachingPrompt({...a,nickname:'Player_A'});
    expect(prompt.squadReportSummary).toContain('4.67초');expect(prompt.squadReportSummary).not.toContain('12000');
  });
  it('keeps measured instant trades and zero observations, but no-opportunity latency is null',async()=>{
    const {getSquadAnalysisData}=await import('@/lib/pubg-analysis/squadAnalysis');
    for(const tradeKills of [0,1]){
      configureSquadClient(queryChain({data:[canonicalRow(1,{squadObservation:observation({tradeKills,tradeLatencyTotalMs:0,revives:0,smokeRescues:0})})],error:null}));
      const a:any=await getSquadAnalysisData('Player_A','steam','Teammate_B');
      expect(a.stats.avgTradeLatency).toBe(tradeKills?0:null);expect(a.stats.totalRevives).toBe(0);
    }
  });
  it.each([undefined,observation({version:0}),observation({status:'missing',issues:['incomplete_match_events']}),observation({teamAccountIds:['a','wrong']})])('withholds mixed or incompatible team observations (%j)',async bad=>{
    configureSquadClient(queryChain({data:[canonicalRow(1,{squadObservation:observation()}),canonicalRow(2,{squadObservation:bad})],error:null}));
    const {getSquadAnalysisData}=await import('@/lib/pubg-analysis/squadAnalysis');const a:any=await getSquadAnalysisData('Player_A','steam','Teammate_B');
    expect(a.stats.totalRevives).toBeNull();expect(a.stats.avgTradeLatency).toBeNull();
  });
  it('does not need an individual tier to show observed team facts',async()=>{
    configureSquadClient(queryChain({data:[canonicalRow(1,{benchmark:{score:50,tier:'BLAH'},squadObservation:observation()})],error:null}));
    const {getSquadAnalysisData}=await import('@/lib/pubg-analysis/squadAnalysis');const a:any=await getSquadAnalysisData('Player_A','steam','Teammate_B');
    expect(a.stats.totalRevives).toBe(1);expect(a.benchmarkStats.tier).toBeNull();
  });
  it.each(['', '  ', 42])('uses valid team accountId when playerId is malformed (%j)',async playerId=>{
    const row=canonicalRow(1,{squadObservation:observation(),
      team:canonicalRow(1).data.fullResult.team.map(member=>({...member,accountId:member.playerId,playerId})),
    });
    configureSquadClient(queryChain({data:[row],error:null}));
    const {getSquadAnalysisData}=await import('@/lib/pubg-analysis/squadAnalysis');
    const result:any=await getSquadAnalysisData('Player_A','steam','Teammate_B');
    expect(result.stats.totalRevives).toBe(1);
  });
  it('reports old squad arithmetic as upgrade pending, not missing match history',async()=>{
    configureSquadClient(queryChain({data:[canonicalRow(1,{calculationVersion:undefined})],error:null}));
    const {getSquadAnalysisData}=await import('@/lib/pubg-analysis/squadAnalysis');
    expect(await getSquadAnalysisData('Player_A','steam')).toMatchObject({errorCode:'PUBG_CALCULATION_UPGRADE_REQUIRED',retryable:false});
  });
  it('reports pending squad history even when a current duo result is available',async()=>{
    configureSquadClient(queryChain({data:[canonicalRow(1,{calculationVersion:1}),canonicalRow(2,{gameMode:'duo'})],error:null}));
    const {getSquadAnalysisData}=await import('@/lib/pubg-analysis/squadAnalysis');
    expect(await getSquadAnalysisData('Player_A','steam')).toMatchObject({errorCode:'PUBG_CALCULATION_UPGRADE_REQUIRED',retryable:false});
  });
  it('still fails when the canonical processed-record query fails' ,async()=>{
    configureSquadClient(queryChain({data:null,error:{message:'database unavailable'}}));
    const {getSquadAnalysisData}=await import('@/lib/pubg-analysis/squadAnalysis');
    await expect(getSquadAnalysisData('Player_A','steam','Teammate_B')).rejects.toThrow('Database error');
  });
});
