import {describe,expect,it} from 'vitest';
import {aggregateMatches} from '../lib/pubg-analysis/summaryAggregate';
const measured=(sum:number,count:number)=>({tradeStats:{reactionLatencyMs:3},duelStats:{firstReplyEvidence:{version:1,eligibleCount:count,within3sCount:count,latencySumMs:sum,noReplyCount:0,alreadyFiringCount:0,unknownCount:0}}});
describe('shared summary aggregation',()=>{
 it('weights qualified reply equally by measured match, not by encounter',()=>{
  const result=aggregateMatches([measured(100,1),measured(4000,2),{tradeStats:{reactionLatencyMs:3000}}]);
  expect(result.avgMeasuredReactionLatency).toBe('1.05s');
  expect(result.metricMatchCounts.reaction_latency).toBe(2);
  expect(result.rawMetricValues.reaction_latency).toBe(1.05);
 });
 it('keeps raw-only and no-hit observations out of measured time',()=>{
  const result=aggregateMatches([{tradeStats:{reactionLatencyMs:3}}, {tradeStats:{},duelStats:{firstReplyEvidence:{version:1,eligibleCount:1,within3sCount:0,latencySumMs:0,noReplyCount:1,alreadyFiringCount:0,unknownCount:0}}}]);
  expect(result.avgMeasuredReactionLatency).toBe('측정 불가');
  expect(result.counterObservedMatches).toBe(1);
  expect(result.counterFailureRate).toBe(100);
 });
 it('preserves initiative opportunity weighting and missing rates',()=>{
  expect(aggregateMatches([{initiative_rate:100,initiativeSampleCount:1},{initiative_rate:0,initiativeSampleCount:3}]).userInitiativeRate).toBe(25);
  expect(aggregateMatches([]).userInitiativeRate).toBeNull();
 });
});


describe("versioned personal role evidence", () => {
  const role = { version: 1, validWeaponHits: 8, distanceHitCount: 8,
    distanceDamage: {short: 150, mid: 100, long: 50}, maxHitDist: 210,
    pressureIndex: 1.6, focusFireCount: 2, rescueCount: 1, rescueOpportunityCount: 1,
    positionSampleCount: 10, edgePlayCount: 4 };
  it("aggregates deduplicated rescue episodes and exact damage without changing legacy totals", () => {
    const match={roleEvidence:role,tradeStats:{revCount:1,smokeRescues:1,teammateKnocks:1},goldenTimeDamage:{early:149,mid1:149,mid2:0,late:0}};
    const result=aggregateMatches([match,match,match]);
    expect(result.roleEvidence).toMatchObject({version:1,matchCount:3,rescueCount:3,rescueOpportunityCount:3,
      distanceDamage:{short:450,mid:300,long:150},maxHitDist:210,focusFireCount:6,
      goldenTimeDamage:{early:447,mid1:447,mid2:0,late:0}});
    expect(result.totalRevCount+result.totalSmokeRescues).toBe(6);
  });
  it("rejects a mixed legacy window and invalid numerators instead of treating missing evidence as zero", () => {
    expect(aggregateMatches([{roleEvidence:role},{}]).roleEvidence).toBeNull();
    expect(aggregateMatches([{roleEvidence:{...role,rescueCount:2}}]).roleEvidence).toBeNull();
    expect(aggregateMatches([{roleEvidence:{...role,validWeaponHits:NaN}}]).roleEvidence).toBeNull();
  });
  it("does not dilute observed metric denominators with missing matches", () => {
    const result=aggregateMatches([{roleEvidence:role,duelStats:{wins:3,losses:1,reversalAttempts:2,reversals:1}}, {roleEvidence:role}]);
    expect(result.roleEvidence?.metricMatchCounts.duelWin).toBe(1);
    expect(result.roleEvidence?.metricMatchCounts.reversal).toBe(1);
  });
  it("keeps observed zero and missing pressure/maximum distance separate", () => {
    const zero={...role,validWeaponHits:0,distanceHitCount:0,maxHitDist:null,pressureIndex:null,
      distanceDamage:{short:0,mid:0,long:0},focusFireCount:0,rescueCount:0,rescueOpportunityCount:0,positionSampleCount:0,edgePlayCount:0};
    expect(aggregateMatches([{roleEvidence:zero}]).roleEvidence).toMatchObject({maxHitDist:null,pressureIndex:null,focusFireCount:0,goldenTimeDamage:null});
    expect(aggregateMatches([{roleEvidence:{...role,maxHitDist:0}}]).roleEvidence?.maxHitDist).toBe(0);
  });
});

describe("version 2 team role evidence", () => {
  const personal = { version: 1, validWeaponHits: 1, distanceHitCount: 1,
    distanceDamage: {short: 1, mid: 0, long: 0}, maxHitDist: 10, pressureIndex: 1,
    focusFireCount: 1, rescueCount: 1, rescueOpportunityCount: 1,
    positionSampleCount: 1, edgePlayCount: 0 };
  const teamMatch = (teamImpact: unknown, tradeStats: unknown, killContribution: unknown, role = personal) => ({
    roleEvidence: role, teamContext: {myRosterSize: 4}, teamImpact, tradeStats, killContribution,
  });
  const observed = () => teamMatch(
    {teamDamageShare: 40}, {tradeKills: 1, teammateKnocks: 2, tradeLatencyMs: 2000, baitCount: 2, suppCount: 1},
    {solo: 1, cleanup: 1, assist: 1}, {...personal, focusFireCount: 2},
  );
  const teamEvidence = (matches: any[]) => {
    const evidence = aggregateMatches(matches, {roleEvidenceVersion:2}).roleEvidence;
    if (!evidence || evidence.version !== 2) throw new Error("expected version 2 role evidence");
    return evidence.team;
  };
  it("preserves default v1 and only adds v2 on explicit request", () => {
    const matches = [observed()];
    const legacy = aggregateMatches(matches);
    expect(legacy.roleEvidence).toMatchObject({version:1, matchCount:1, rescueCount:1});
    expect(legacy.roleEvidence).not.toHaveProperty("team");
    expect(aggregateMatches(matches, {roleEvidenceVersion:2}).roleEvidence).toMatchObject({
      version:2, matchCount:1, rescueCount:1,
      team: {matchCount:1, rescueCount:1, rescueOpportunityCount:1, teamDamageShare:40,
        teamDamageShareMatches:1, tradeKills:1, teammateKnocks:2, tradeRateMatches:1,
        tradeLatencySec:2, tradeLatencyMatches:1, baitPerMatch:2, supportPerMatch:1,
        supportMatches:1, focusFirePerMatch:2, crossfireMatches:1},
    });
    expect(teamEvidence(matches).assistShare).toBeCloseTo(100/3);
  });
  it("uses team-only denominators, does not dilute a team match with a roster-one match", () => {
    const solo = {...observed(), teamContext:{myRosterSize:1}};
    const result = teamEvidence([observed(), solo]);
    expect(result).toMatchObject({matchCount:1, teamDamageShare:40, teamDamageShareMatches:1});
  });
  it("keeps independent missing denominators and observed zero distinct", () => {
    const partial = teamMatch({teamDamageShare:0}, {tradeKills:0, teammateKnocks:null, tradeLatencyMs:null, baitCount:0, suppCount:null},
      {solo:0, cleanup:0, assist:0}, {...personal, focusFireCount:0});
    const result = teamEvidence([observed(), partial]);
    expect(result).toMatchObject({teamDamageShare:20,teamDamageShareMatches:2,tradeKills:1,teammateKnocks:2,tradeRateMatches:1,
      tradeLatencySec:2,tradeLatencyMatches:1,baitPerMatch:2,supportPerMatch:1,supportMatches:1,
      focusFirePerMatch:1,crossfireMatches:2});
    expect(result?.assistShare).toBeCloseTo(100/3);
    const zeroMatch = teamMatch({teamDamageShare:0}, {tradeKills:0, teammateKnocks:0, tradeLatencyMs:null, baitCount:0, suppCount:0},
      {solo:0, cleanup:0, assist:0}, {...personal, focusFireCount:0});
    const zero = teamEvidence([zeroMatch]);
    expect(zero).toMatchObject({teamDamageShare:0,baitPerMatch:0,focusFirePerMatch:0,assistShare:null,crossfireMatches:1});
  });
  it("takes rescue totals once from validated personal evidence and withholds invalid metric rows", () => {
    const malformed = observed();
    malformed.teamImpact = {teamDamageShare:101};
    malformed.tradeStats = {tradeKills:null, teammateKnocks:1, tradeLatencyMs:0, baitCount:2, suppCount:-1};
    malformed.killContribution = {solo:1, cleanup:1, assist:5};
    const result = teamEvidence([observed(), malformed]);
    expect(result).toMatchObject({rescueCount:2,rescueOpportunityCount:2,teamDamageShare:40,teamDamageShareMatches:1,
      tradeKills:1,teammateKnocks:2,tradeRateMatches:1,tradeLatencySec:2,tradeLatencyMatches:1,
      baitPerMatch:2,supportPerMatch:1,supportMatches:1,focusFirePerMatch:2,crossfireMatches:2});
  });
});
