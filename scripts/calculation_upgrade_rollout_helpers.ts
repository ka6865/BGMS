import { stableHash } from './calculation_upgrade_batch';
export type RolloutRow = {id:number;match_id:string;platform:'steam'|'kakao';player_id:string;created_at:string};
export type RolloutMatch = {matchId:string;platform:'steam'|'kakao';rows:RolloutRow[]};
/** Freeze identities before mutations; a shrinking pending result set cannot shift this cursor. */
export function groupRolloutRows(rows: RolloutRow[]): RolloutMatch[] {
  const seen=new Set<number>(), groups=new Map<string,RolloutMatch>();
  for(const row of rows){
    if(!Number.isSafeInteger(row.id)||row.id<1||seen.has(row.id)||!['steam','kakao'].includes(row.platform)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.match_id)
      ||!row.player_id||!Number.isFinite(Date.parse(row.created_at)))throw new Error('invalid_rollout_identity');
    seen.add(row.id);const key=`${row.platform}/${row.match_id}`;
    const group=groups.get(key)??{matchId:row.match_id,platform:row.platform,rows:[]};group.rows.push(row);groups.set(key,group);
  }
  return [...groups.values()].sort((a,b)=>Math.max(...b.rows.map(r=>Date.parse(r.created_at)))-Math.max(...a.rows.map(r=>Date.parse(r.created_at)))||a.platform.localeCompare(b.platform)||a.matchId.localeCompare(b.matchId));
}
export function assertRolloutSnapshot(snapshot: any, project:string): asserts snapshot is {version:1;project:string;calculationVersion:2;rows:RolloutRow[];hash:string} {
  if(snapshot?.version!==1||snapshot.project!==project||snapshot.calculationVersion!==2||!Array.isArray(snapshot.rows)
    ||snapshot.hash!==stableHash(snapshot.rows))throw new Error('rollout_snapshot_mismatch');
  groupRolloutRows(snapshot.rows);
}

export function assertRolloutProgress(state: any, inventoryHash:string, project:string, totalMatches:number): void {
  if(state?.version!==1||state.project!==project||state.inventoryHash!==inventoryHash||state.totalMatches!==totalMatches
    ||!Number.isSafeInteger(state.nextIndex)||state.nextIndex<0||state.nextIndex>totalMatches
    ||!Array.isArray(state.results)||state.results.length!==state.nextIndex
    ||!['prepared','running','paused','completed'].includes(state.phase)
    ||![state.upstreamRequests,state.downloadedBytes].every(n=>Number.isSafeInteger(n)&&n>=0)
    ||state.results.some((r:any,i:number)=>r.index!==i))throw new Error('rollout_state_mismatch');
}
