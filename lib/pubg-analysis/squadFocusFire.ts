/** Experimental observation, not a calibrated score or proof of cover intent. */
export const SQUAD_FOCUS_FIRE_VERSION = 1;
export const SQUAD_FOCUS_FIRE_WINDOW_MS = 5_000;

export type SquadFocusFireObservation = {
  version: number;
  windowMs: number;
  calibration: "pending";
  status: "observed" | "no_opportunity" | "missing" | "unsupported";
  numerator: number | null;
  denominator: number | null;
  rate: number | null;
  issues: string[];
};

type Event = Record<string, any>;
type Episode = { startedAt: number; attackers: Set<string> };
const relevant = new Set([
  "LogMatchStart", "LogMatchEnd", "LogPlayerTakeDamage", "LogPlayerMakeGroggy", "LogPlayerMakeDBNO",
  "LogPlayerKill", "LogPlayerKillV2", "LogPlayerRevive", "LogPlayerCreate", "LogPlayerRedeploy", "LogPlayerRedeployBRStart",
  "LogPlayerRecall", "LogPlayerRecallShip",
]);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const accountId = (actor: any): string | null => typeof actor?.accountId === "string" && actor.accountId.trim() ? actor.accountId : null;

/** One observer per match/team. Reuses the engine's event pass and no network. */
export class SquadFocusFireCollector {
  private readonly team: Set<string>;
  private readonly mode: string;
  private readonly active = new Map<string, Episode>();
  private readonly down = new Set<string>();
  private readonly dead = new Set<string>();
  private readonly issues = new Set<string>();
  private started = false;
  private ended = false;
  private previousTime = -Infinity;
  private numerator = 0;
  private denominator = 0;

  constructor(teamAccountIds: ReadonlySet<string>, mode: string, private readonly windowMs = SQUAD_FOCUS_FIRE_WINDOW_MS) {
    this.mode = mode.trim().toLowerCase();
    this.team = new Set([...teamAccountIds].filter((id) => typeof id === "string" && id.trim() && !id.startsWith("ai.")));
    if (!finite(windowMs) || windowMs <= 0) throw new Error("Focus-fire window must be positive");
  }

  observe(event: Event, ts: number): void {
    if (this.mode !== "squad" && this.mode !== "squad-fpp") return;
    if (!relevant.has(event?._T)) return;
    if (!finite(ts)) { this.issues.add("invalid_timestamp"); return; }
    if (ts < this.previousTime) this.issues.add("out_of_order_events");
    this.previousTime = ts;
    const type = event._T;
    if (type === "LogMatchStart") {
      if (this.started) this.issues.add("duplicate_match_start");
      this.started = true;
      return;
    }
    if (type === "LogMatchEnd") { this.ended = true; return; }
    if (!this.started || this.ended) return;
    const victim = accountId(event.victim);
    if (["LogPlayerMakeGroggy", "LogPlayerMakeDBNO", "LogPlayerKill", "LogPlayerKillV2"].includes(type)) {
      if (!victim) { this.issues.add("missing_life_identity"); return; }
      if (type === "LogPlayerMakeGroggy" || type === "LogPlayerMakeDBNO") this.down.add(victim);
      else this.dead.add(victim);
      this.active.delete(victim);
      if (this.team.has(victim) && this.readyMembers() < 2) this.active.clear();
      return;
    }
    if (type === "LogPlayerRevive") {
      if (!victim) this.issues.add("missing_life_identity");
      else this.down.delete(victim);
      return;
    }
    if (["LogPlayerCreate", "LogPlayerRedeploy", "LogPlayerRedeployBRStart"].includes(type)) {
      const actors = type === "LogPlayerRedeployBRStart" ? event.characters : [event.character];
      if (!Array.isArray(actors)) { this.issues.add("missing_life_identity"); return; }
      for (const wrapped of actors) {
        const id = accountId(wrapped?.character ?? wrapped);
        if (!id) this.issues.add("missing_life_identity");
        else { this.down.delete(id); this.dead.delete(id); this.active.delete(id); }
      }
      return;
    }
    // Recall schemas differ by mode. Withhold instead of guessing when the
    // full return-to-combat lifecycle cannot be reconstructed reliably.
    if (type === "LogPlayerRecall" || type === "LogPlayerRecallShip") {
      this.issues.add("recall_lifecycle_unverified");
      return;
    }
    if (type !== "LogPlayerTakeDamage" || event.damageTypeCategory !== "Damage_Gun") return;
    const attacker = accountId(event.attacker);
    if (!attacker || !this.team.has(attacker)) return;
    if (!victim) { this.issues.add("missing_damage_identity"); return; }
    if (this.team.has(victim) || attacker === victim || victim.startsWith("ai.")) return;
    const a = event.attacker, v = event.victim;
    if (!finite(a.teamId) || !finite(v.teamId) || !finite(a.health) || !finite(v.health) || !finite(event.damage)) {
      this.issues.add("missing_damage_fields"); return;
    }
    if (a.teamId === v.teamId || event.damage <= 0 || a.health <= 0 || v.health < 0) return;
    // A lethal hit may report health=0 before the subsequent groggy event;
    // exclude finishing shots using the observed life events, not that zero.
    if (this.down.has(attacker) || this.dead.has(attacker) || this.down.has(victim) || this.dead.has(victim)) return;
    if (this.readyMembers() < 2) return;
    let episode = this.active.get(victim);
    if (!episode || ts - episode.startedAt > this.windowMs) {
      episode = { startedAt: ts, attackers: new Set() };
      this.active.set(victim, episode);
      this.denominator += 1;
    }
    const previous = episode.attackers.size;
    episode.attackers.add(attacker);
    if (previous === 1 && episode.attackers.size === 2) this.numerator += 1;
  }

  private readyMembers(): number {
    let count = 0;
    for (const id of this.team) if (!this.down.has(id) && !this.dead.has(id)) count += 1;
    return count;
  }

  result(): SquadFocusFireObservation {
    const supported = this.mode === "squad" || this.mode === "squad-fpp";
    const issues = new Set(this.issues);
    if (!this.started || !this.ended) issues.add("incomplete_match_events");
    if (!this.team.size) issues.add("missing_team_identity");
    const status = !supported ? "unsupported" : issues.size ? "missing" : this.denominator ? "observed" : "no_opportunity";
    const usable = status === "observed" || status === "no_opportunity";
    return {
      version: SQUAD_FOCUS_FIRE_VERSION, windowMs: this.windowMs, calibration: "pending", status,
      numerator: usable ? this.numerator : null,
      denominator: usable ? this.denominator : null,
      rate: status === "observed" ? this.numerator / this.denominator * 100 : null,
      issues: [...issues],
    };
  }
}

/** Selected canonical matches only. Never average percentages or count a match twice. */
export function aggregateSquadFocusFire(matches: { matchId: string; observation?: SquadFocusFireObservation }[]): SquadFocusFireObservation {
  const unique = new Map<string, SquadFocusFireObservation | undefined>();
  let conflictingMatch = false;
  for (const match of matches) {
    if (!match.matchId?.trim()) conflictingMatch = true;
    if (unique.has(match.matchId) && JSON.stringify(unique.get(match.matchId)) !== JSON.stringify(match.observation)) conflictingMatch = true;
    unique.set(match.matchId, match.observation);
  }
  const rows = [...unique.values()];
  const base = { version: SQUAD_FOCUS_FIRE_VERSION, windowMs: SQUAD_FOCUS_FIRE_WINDOW_MS, calibration: "pending" as const };
  const unavailable = (status: "unsupported" | "missing", reason: string): SquadFocusFireObservation => ({
    ...base, status, numerator: null, denominator: null, rate: null, issues: [reason],
  });
  if (conflictingMatch) return unavailable("missing", "conflicting_match_identity");
  if (!rows.length || rows.every((row) => !row)) return unavailable("unsupported", "collection_not_available");
  if (rows.some((row) => !row || row.version !== base.version || row.windowMs !== base.windowMs
    || !Array.isArray(row.issues) || row.issues.length > 0
    || row.calibration !== "pending" || !["observed", "no_opportunity"].includes(row.status)
    || !Number.isInteger(row.numerator) || !Number.isInteger(row.denominator)
    || row.numerator! < 0 || row.denominator! < row.numerator!
    || (row.status === "observed" ? row.denominator! <= 0 || row.rate !== row.numerator! / row.denominator! * 100
      : row.denominator !== 0 || row.numerator !== 0 || row.rate !== null))) {
    return unavailable("missing", "incomplete_or_incompatible_observations");
  }
  const numerator = rows.reduce((sum, row) => sum + row!.numerator!, 0);
  const denominator = rows.reduce((sum, row) => sum + row!.denominator!, 0);
  return { ...base, status: denominator ? "observed" : "no_opportunity", numerator, denominator,
    rate: denominator ? numerator / denominator * 100 : null, issues: [] };
}
