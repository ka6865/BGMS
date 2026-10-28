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
