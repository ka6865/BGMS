import { describe, expect, it } from 'vitest';
import { finiteReplayPoint, orderedReplayEvents, replayPlayerStatus } from '@/lib/replay/orderedEvents';

describe('replay temporal evidence',()=>{
  it('orders timestamps without changing cached source and rejects invalid time',()=>{
    const source=[{relativeTimeMs:120000},{relativeTimeMs:10000},{relativeTimeMs:NaN}];
    expect(orderedReplayEvents(source)).toEqual([source[1],source[0]]);expect(source[0].relativeTimeMs).toBe(120000);
  });
  it('shows the correct life before and after recall even with unordered events',()=>{
    const events=[{type:'kill',victim:'A',relativeTimeMs:300},{type:'create',name:'A',relativeTimeMs:200},{type:'kill',victim:'A',relativeTimeMs:100}];
    expect(replayPlayerStatus(events,'a',50)).toBe('normal');
    expect(replayPlayerStatus(events,'a',150)).toBe('dead');
    expect(replayPlayerStatus(events,'a',250)).toBe('normal');
    expect(replayPlayerStatus(events,'a',350)).toBe('dead');
  });
  it('preserves valid map-edge zero coordinates while rejecting missing and nonfinite ones',()=>{
    expect(finiteReplayPoint(0,100)).toBe(true);expect(finiteReplayPoint(100,0)).toBe(true);
    expect(finiteReplayPoint(null,100)).toBe(false);expect(finiteReplayPoint(Infinity,100)).toBe(false);
  });
});
