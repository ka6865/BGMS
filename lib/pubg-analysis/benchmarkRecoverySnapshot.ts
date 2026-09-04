/**
 * Exact nullable legacy benchmark values captured by recovery planning.
 *
 * This type lives in a neutral module so the read-only planner does not depend
 * on the persistence consumer boundary.  Persistence re-exports it for the
 * existing route API while both sides keep the same structural CAS shape.
 */
export interface RecoveryBenchmarkSnapshot {
  damage: number | null;
  kills: number | null;
  win_place: number | null;
  game_mode: string | null;
  map_name: string | null;
  counter_latency_ms: number | null;
  initiative_rate: number | null;
  revive_rate: number | null;
  is_crossfire: boolean | null;
  utility_count: number | null;
  smoke_count: number | null;
  frag_count: number | null;
  pressure_index: number | null;
  enemy_death_distance: number | null;
  survival_time: number | null;
  isolation_index: number | null;
  min_dist: number | null;
  height_diff: number | null;
  smoke_rate: number | null;
  trade_rate: number | null;
  solo_kill_rate: number | null;
  reversal_rate: number | null;
  duel_win_rate: number | null;
  trade_latency_ms: number | null;
  lethal_throw_count: number | null;
  tier: string | null;
  score: number | null;
  combat_score: number | null;
  tactical_score: number | null;
  survival_score: number | null;
  supp_count: number | null;
  team_wipes: number | null;
  match_type: string | null;
  death_phase: number | null;
  filter_version: number | null;
  population_evidence_version: number | null;
  source: string | null;
}
