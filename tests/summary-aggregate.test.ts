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
