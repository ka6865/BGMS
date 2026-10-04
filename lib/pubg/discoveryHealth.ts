import type { SupabaseClient } from "@supabase/supabase-js";

export const DISCOVERY_STATES = ["pending", "retry", "running", "saved", "unavailable"] as const;
export type DiscoveryHealthSnapshot = {
  measuredAt: string; atomic: false;
  states: Record<typeof DISCOVERY_STATES[number], number>;
  readyCount: number; expiredLeaseCount: number;
  oldestReadyFirstSeenAt: string | null; lastSavedAt: string | null;
  oldestReadyAgeMinutes: number | null; minutesSinceLastSaved: number | null;
  warnings: string[];
};

export function discoveryHealthWarnings(input: { readyCount: number; oldestReadyAgeMinutes: number | null; minutesSinceLastSaved: number | null; expiredLeaseCount: number }): string[] {
  const warnings: string[] = [];
  if (input.readyCount > 0 && input.oldestReadyAgeMinutes !== null && input.oldestReadyAgeMinutes >= 1440) warnings.push("backlog_older_than_24h");
  if (input.readyCount > 0 && (input.minutesSinceLastSaved === null || input.minutesSinceLastSaved >= 120)) warnings.push("no_collection_progress_for_2h");
  if (input.expiredLeaseCount > 0) warnings.push("expired_collection_leases");
  return warnings;
}

export async function readDiscoveryHealth(db: SupabaseClient, now = Date.now()): Promise<DiscoveryHealthSnapshot> {
  const measuredAt = new Date(now).toISOString();
  const stateCounts = await Promise.all(DISCOVERY_STATES.map(async state => {
    const result = await db.from("pubg_player_match_discovery").select("match_id", { head: true, count: "exact" }).eq("state", state);
    if (result.error || result.count === null) throw new Error("discovery-health-state-read-failed");
    return [state, result.count] as const;
  }));
  const [ready, expired, saved] = await Promise.all([
    db.from("pubg_player_match_discovery").select("first_seen_at", { count: "exact" }).in("state", ["pending", "retry"]).lte("next_attempt_at", measuredAt).order("first_seen_at").limit(1),
    db.from("pubg_player_match_discovery").select("match_id", { head: true, count: "exact" }).eq("state", "running").lte("lease_expires_at", measuredAt),
    db.from("pubg_player_match_discovery").select("saved_at").eq("state", "saved").order("saved_at", { ascending: false, nullsFirst: false }).limit(1),
  ]);
  if (ready.error || expired.error || saved.error || ready.count === null || expired.count === null) throw new Error("discovery-health-progress-read-failed");
  const oldestReadyFirstSeenAt = ready.data?.[0]?.first_seen_at ?? null;
  const lastSavedAt = saved.data?.[0]?.saved_at ?? null;
  const age = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? Math.max(0, Math.floor((now - Date.parse(value)) / 60000)) : null;
  const progress = { readyCount: ready.count, expiredLeaseCount: expired.count, oldestReadyAgeMinutes: age(oldestReadyFirstSeenAt), minutesSinceLastSaved: age(lastSavedAt) };
  return { measuredAt, atomic: false, states: Object.fromEntries(stateCounts) as DiscoveryHealthSnapshot["states"], oldestReadyFirstSeenAt, lastSavedAt, ...progress, warnings: discoveryHealthWarnings(progress) };
}
