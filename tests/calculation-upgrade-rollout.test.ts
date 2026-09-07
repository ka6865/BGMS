import {describe,it,expect} from 'vitest';
import {groupRolloutRows,assertRolloutSnapshot,assertRolloutProgress,type RolloutRow} from '../scripts/calculation_upgrade_rollout_helpers';
import {stableHash} from '../scripts/calculation_upgrade_batch';
const row=(id:number,match_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'):RolloutRow=>({id,match_id,platform:'steam',player_id:`player${id}`,created_at:'2026-09-07T00:00:00Z'});
describe('immutable all-user rollout inventory',()=>{
 it('reuses one source for multiple players and does not shift remaining matches after writes',()=>{
  const rows=[row(1),row(2),row(3,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')];
  const groups=groupRolloutRows(rows);expect(groups).toHaveLength(2);expect(groups[0].rows).toHaveLength(2);
  const remaining=groups.slice(1);expect(remaining[0].rows[0].id).toBe(3);
  expect(groupRolloutRows(rows)).toEqual(groups);
 });
 it('binds saved inventory to its project, version and every target identity',()=>{
  const rows=[row(1)],snapshot={version:1,project:'test.supabase.co',calculationVersion:2,rows,hash:stableHash(rows)};
  expect(()=>assertRolloutSnapshot(snapshot,'test.supabase.co')).not.toThrow();
  expect(()=>assertRolloutSnapshot(snapshot,'other.supabase.co')).toThrow();
  expect(()=>assertRolloutSnapshot({...snapshot,rows:[row(2)]},'test.supabase.co')).toThrow();
 });
 it('rejects corrupt resume counters and skipped progress entries',()=>{
  const state={version:1,project:'test',inventoryHash:'hash',totalMatches:2,nextIndex:1,results:[{index:0}],phase:'paused',upstreamRequests:2,downloadedBytes:123};
  expect(()=>assertRolloutProgress(state,'hash','test',2)).not.toThrow();
  expect(()=>assertRolloutProgress({...state,downloadedBytes:null},'hash','test',2)).toThrow();
  expect(()=>assertRolloutProgress({...state,nextIndex:2},'hash','test',2)).toThrow();
 });
 it('rejects duplicate row keys and malformed platform/date/match identities',()=>{
  expect(()=>groupRolloutRows([row(1),row(1)])).toThrow();
  expect(()=>groupRolloutRows([{...row(1),platform:'legacy_unknown'} as any])).toThrow();
  expect(()=>groupRolloutRows([{...row(1),created_at:'unknown'}])).toThrow();
  expect(()=>groupRolloutRows([row(1,'../bad')])).toThrow();
 });
});
