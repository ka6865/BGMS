/** Team observations, independent of the player requesting the analysis. */
export const SQUAD_OBSERVATION_VERSION = 1;
export type SquadObservation = {
  version: number;
  scope: 'squad';
  teamAccountIds: string[];
  status: 'observed' | 'missing' | 'unsupported';
  issues: string[];
  knocks: number | null;
  revives: number | null;
  smokeRescues: number | null;
  tradeKills: number | null;
  tradeLatencyTotalMs: number | null;
};
type Point = { x: number; y: number; z: number };
type Knock = { ts: number; point: Point | null; smokes: Array<Point | null> };
type TelemetryEvent = Record<string, any>;
const id = (actor: any): string | null => [actor?.accountId, actor?.playerId]
  .find(value => typeof value === 'string' && value.trim()) ?? null;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const point = (actor: any): Point | null => {
  const p = actor?.location ?? actor?.loc;
  return p && finite(p.x) && finite(p.y) && finite(p.z) && (p.x !== 0 || p.y !== 0) ? { x:p.x, y:p.y, z:p.z } : null;
};
const lifecycle = new Set(['LogPlayerCreate','LogPlayerRecall','LogPlayerRecallShip','LogPlayerRedeploy','LogPlayerRedeployBRStart','LogPlayerRedeployBrStart']);
const relevant = new Set(['LogMatchStart','LogMatchEnd','LogPlayerMakeGroggy','LogPlayerMakeDBNO','LogPlayerKill','LogPlayerKillV2','LogPlayerRevive','LogPlayerUseThrowable','LogThrowableUse',...lifecycle]);

export class SquadObservationCollector {
  private readonly team: Set<string>;
  private readonly issues = new Set<string>();
  private readonly knocks = new Map<string, Knock>();
  private readonly revenge = new Map<string, { ts:number; victim:string }>();
  private readonly dead = new Set<string>();
  private readonly revived = new Set<string>();
  private readonly creditedKills = new Set<string>();
  private readonly throws = new Set<string>();
  private started = false;
  private ended = false;
  private lastTime = -Infinity;
  private knockCount = 0;
  private reviveCount = 0;
  private smokeCount = 0;
  private smokeComplete = true;
  private tradeCount = 0;
  private tradeTotalMs = 0;
  constructor(teamAccountIds: ReadonlySet<string>, private readonly mode: string) {
    this.team = new Set([...teamAccountIds].filter(value=>typeof value==='string' && value.trim()));
  }
  observe(e: TelemetryEvent, ts: number): void {
    if (!relevant.has(e?._T)) return;
    if (!finite(ts)) { this.issues.add('invalid_timestamp'); return; }
    if (ts < this.lastTime) this.issues.add('out_of_order_events');
    this.lastTime = ts;
    const type = e._T;
    if (type === 'LogMatchStart') {
      if (this.started) this.issues.add('duplicate_match_start');
      this.started = true; return;
    }
    if (type === 'LogMatchEnd') { this.ended = true; return; }
    if (!this.started || this.ended) return;
    const victim = id(e.victim), attacker = id(e.attacker);
    if (lifecycle.has(type)) {
      const actors = [e.character, e.victim, e.recallingPlayer, e.recalledPlayer,
        ...(Array.isArray(e.characters) ? e.characters : []),
        ...(Array.isArray(e.recalledPlayers) ? e.recalledPlayers : [])]
        .map(actor=>actor?.character ?? actor).filter(Boolean);
      if (!actors.length) this.issues.add('missing_return_identity');
      for (const actor of actors) {
        const key = id(actor);
        if (!key) { this.issues.add('missing_return_identity'); continue; }
        this.dead.delete(key); this.revived.delete(key); this.creditedKills.delete(key); this.knocks.delete(key); this.revenge.delete(key);
        for (const [enemy, episode] of this.revenge) if (episode.victim===key) this.revenge.delete(enemy);
      }
      return;
    }
    if (type==='LogPlayerMakeGroggy' || type==='LogPlayerMakeDBNO') {
      if (!victim) { this.issues.add('missing_knock_identity'); return; }
      if (!this.team.has(victim) || this.knocks.has(victim) || this.dead.has(victim)) return;
      this.revived.delete(victim);
      this.knockCount++;
      this.knocks.set(victim,{ ts,point:point(e.victim),smokes:[] });
      if (attacker && !this.team.has(attacker)) this.revenge.set(attacker,{ts,victim});
      else if (!attacker && !/groggy|bluezone|redzone|fall|drown/i.test(e.damageTypeCategory||'')) this.issues.add('missing_knock_attacker');
      return;
    }
    if (type==='LogPlayerKill' || type==='LogPlayerKillV2') {
      if (!victim) { this.issues.add('missing_death_identity'); return; }
      const killer = id(e.killer);
      // An actor-less legacy kill may precede its attributed KillV2.
      if (killer && !this.creditedKills.has(victim)) {
        this.creditedKills.add(victim);
        const prior = this.revenge.get(victim);
        if (this.team.has(killer) && !this.team.has(victim) && prior && killer!==prior.victim
          && ts>=prior.ts && ts-prior.ts<30_000) {
          this.tradeCount++; this.tradeTotalMs+=ts-prior.ts;
        }
        this.revenge.delete(victim);
      }
      this.dead.add(victim); this.revived.delete(victim); this.knocks.delete(victim);
      return;
    }
    if (type==='LogPlayerRevive') {
      if (!victim) { this.issues.add('missing_revive_identity'); return; }
      if (!this.team.has(victim)) { this.revenge.delete(victim); return; }
      const knock = this.knocks.get(victim);
      if (!knock) {
        if (this.dead.has(victim)) this.issues.add('revive_after_death');
        else if (!this.revived.has(victim)) this.issues.add('missing_knock_for_revive');
        return; // repeated revive events do not add another success
      }
      const reviver = id(e.reviver ?? e.attacker);
      if (!reviver || !this.team.has(reviver) || reviver===victim) { this.issues.add('missing_reviver_identity'); return; }
      this.reviveCount++; this.revived.add(victim);
      if (ts-knock.ts <=30_000) {
        const near = knock.smokes.some(p=>p && knock.point && Math.hypot(p.x-knock.point.x,p.y-knock.point.y,p.z-knock.point.z)<=10_000);
        if (near) this.smokeCount++;
        else if (knock.smokes.length && (!knock.point || knock.smokes.some(p=>!p))) this.smokeComplete=false;
      }
      this.knocks.delete(victim); this.dead.delete(victim);
      return;
    }
    if (type==='LogPlayerUseThrowable' || type==='LogThrowableUse') {
      const actor = e.attacker ?? e.character;
      const thrower = id(actor);
      const weapon = String(e.weapon?.itemId ?? e.weaponId ?? e.item?.itemId ?? '').toLowerCase();
      if (!/smoke|m79/.test(weapon) || !thrower || !this.team.has(thrower)) return;
      const attack = [e.attackId,e.attack_id,e.projectileId].find(v=>(finite(v)&&v>=0)||(typeof v==='string'&&v.trim()&&v!=='-1'));
      const key = `${thrower}:${attack??`${weapon}:${ts}`}`;
      if (this.throws.has(key)) return;
      this.throws.add(key);
      for (const knock of this.knocks.values()) if (ts>=knock.ts && ts-knock.ts<=15_000) knock.smokes.push(point(actor));
    }
  }
  result(): SquadObservation {
    const issues = [...this.issues];
    if (!this.started || !this.ended) issues.push('incomplete_match_events');
    if (this.team.size<2) issues.push('missing_team_identity');
    const supported = ['squad','squad-fpp'].includes(this.mode);
    const status = !supported ? 'unsupported' : issues.length ? 'missing' : 'observed';
    const observed = status==='observed';
    return { version:SQUAD_OBSERVATION_VERSION,scope:'squad',teamAccountIds:[...this.team].sort(),status,issues,
      knocks:observed?this.knockCount:null,revives:observed?this.reviveCount:null,
      smokeRescues:observed&&this.smokeComplete?this.smokeCount:null,
      tradeKills:observed?this.tradeCount:null,tradeLatencyTotalMs:observed?this.tradeTotalMs:null };
  }
}

/** Missing/legacy/mixed records never borrow the requester's individual numbers. */
export function aggregateSquadObservations(matches: Array<{matchId:string;observation?:SquadObservation;expectedTeamAccountIds?:string[]}>) {
  const rows = new Map<string,SquadObservation | undefined>();
  let conflict = false;
  for (const match of matches) {
    if (match.expectedTeamAccountIds && (!match.expectedTeamAccountIds.every(v=>typeof v==='string'&&v.trim())
      || JSON.stringify([...new Set(match.expectedTeamAccountIds)].sort())!==JSON.stringify([...(match.observation?.teamAccountIds??[])].sort()))) conflict=true;
    if (!match.matchId || (rows.has(match.matchId) && JSON.stringify(rows.get(match.matchId))!==JSON.stringify(match.observation))) conflict=true;
    rows.set(match.matchId,match.observation);
  }
  const values = [...rows.values()];
  const team = values[0]?.teamAccountIds;
  const count = (v:unknown):v is number => finite(v)&&Number.isSafeInteger(v)&&v>=0;
  const valid = !conflict && values.length>0 && values.every(row=>row?.version===SQUAD_OBSERVATION_VERSION
    && row.scope==='squad' && row.status==='observed' && Array.isArray(row.issues) && row.issues.length===0
    && Array.isArray(row.teamAccountIds) && row.teamAccountIds.length>=2
    && new Set(row.teamAccountIds).size===row.teamAccountIds.length && row.teamAccountIds.every(v=>typeof v==='string'&&v.trim())
    && JSON.stringify([...row.teamAccountIds].sort())===JSON.stringify([...(team??[])].sort())
    && count(row.knocks) && count(row.revives) && row.revives<=row.knocks
    && count(row.tradeKills) && row.tradeKills<=row.knocks && count(row.tradeLatencyTotalMs)
    && (row.tradeKills===0 ? row.tradeLatencyTotalMs===0 : row.tradeLatencyTotalMs<row.tradeKills*30_000)
    && (row.smokeRescues===null || count(row.smokeRescues)&&row.smokeRescues<=row.revives));
  const sum = (key:'knocks'|'revives'|'smokeRescues'|'tradeKills'|'tradeLatencyTotalMs'):number|null => {
    if (!valid || values.some(row=>row![key]===null)) return null;
    const total=values.reduce((n,row)=>n+row![key]!,0);
    return Number.isSafeInteger(total)?total:null;
  };
  const trades=sum('tradeKills'),latency=sum('tradeLatencyTotalMs');
  return { scope:'squad' as const,version:SQUAD_OBSERVATION_VERSION,status:valid?'observed' as const:'missing' as const,
    matchCount:values.length,knocks:sum('knocks'),revives:sum('revives'),smokeRescues:sum('smokeRescues'),tradeKills:trades,
    avgTradeLatency:trades!==null&&trades>0&&latency!==null?latency/trades:null };
}
