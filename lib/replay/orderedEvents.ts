/** Replay consumers share timestamp ordering; never mutate cached input arrays. */
export function orderedReplayEvents<T>(events: readonly T[]): T[] {
  const time = (event: any): number => event?.relativeTimeMs;
  return events.filter(event => Number.isFinite(time(event))).sort((a,b) => time(a)-time(b));
}

export function replayPlayerStatus(events: readonly any[], playerName: string, timeMs: number): 'normal'|'groggy'|'dead' {
  const name = playerName.trim().toLowerCase();
  let status: 'normal'|'groggy'|'dead' = 'normal';
  let latest = -Infinity;
  for (const event of events) {
    if (!Number.isFinite(event?.relativeTimeMs) || event.relativeTimeMs > timeMs || event.relativeTimeMs < latest) continue;
    const actor = event.type === 'create' ? event.name : event.victim;
    if (typeof actor !== 'string' || actor.trim().toLowerCase() !== name) continue;
    if (event.type === 'kill') status = 'dead';
    else if (event.type === 'groggy') status = 'groggy';
    else if (event.type === 'revive' || event.type === 'create') status = 'normal';
    else continue;
    latest = event.relativeTimeMs;
  }
  return status;
}

export const finiteReplayPoint = (x: unknown,y: unknown): boolean =>
  typeof x==='number' && Number.isFinite(x) && typeof y==='number' && Number.isFinite(y);
