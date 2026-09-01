-- PUBG analysis population provenance boundary.
--
-- Rows written before this migration intentionally remain NULL and therefore
-- untrusted.  Application writers must provide both current markers
-- explicitly (filter_version = 8, population_evidence_version = 1); this
-- migration never backfills legacy rows as trusted evidence.

ALTER TABLE public.global_benchmarks
  ADD COLUMN IF NOT EXISTS population_evidence_version integer;

ALTER TABLE public.weapon_meta_match_samples
  ADD COLUMN IF NOT EXISTS filter_version integer;

ALTER TABLE public.weapon_meta_match_samples
  ADD COLUMN IF NOT EXISTS population_evidence_version integer;

COMMENT ON COLUMN public.global_benchmarks.population_evidence_version IS
  'Population provenance marker; NULL is legacy/untrusted, current trusted value is 1.';

COMMENT ON COLUMN public.weapon_meta_match_samples.filter_version IS
  'Population filter marker; NULL is legacy/untrusted, current trusted value is 8.';

COMMENT ON COLUMN public.weapon_meta_match_samples.population_evidence_version IS
  'Population provenance marker; NULL is legacy/untrusted, current trusted value is 1.';

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS.  The catalog guards keep
-- this migration rerunnable while NOT VALID avoids rewriting/validating a
-- potentially dirty historical population.  CHECK constraints still apply
-- to every new or updated row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.global_benchmarks'::regclass
      AND conname = 'global_benchmarks_population_evidence_version_check'
  ) THEN
    ALTER TABLE public.global_benchmarks
      ADD CONSTRAINT global_benchmarks_population_evidence_version_check
      CHECK (population_evidence_version IS NULL OR population_evidence_version = 1)
      NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.weapon_meta_match_samples'::regclass
      AND conname = 'weapon_meta_match_samples_filter_version_check'
  ) THEN
    ALTER TABLE public.weapon_meta_match_samples
      ADD CONSTRAINT weapon_meta_match_samples_filter_version_check
      CHECK (filter_version IS NULL OR filter_version = 8)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.weapon_meta_match_samples'::regclass
      AND conname = 'weapon_meta_match_samples_population_evidence_version_check'
  ) THEN
    ALTER TABLE public.weapon_meta_match_samples
      ADD CONSTRAINT weapon_meta_match_samples_population_evidence_version_check
      CHECK (population_evidence_version IS NULL OR population_evidence_version = 1)
      NOT VALID;
  END IF;
END
$$;

-- The view's existing columns remain in their original order and types so
-- benchmarkLookup callers keep working.  New provenance markers and metric
-- populations are appended because CREATE OR REPLACE VIEW may only add
-- columns at the end of an existing view.
CREATE OR REPLACE VIEW public.benchmark_stats_by_tier
WITH (security_invoker = true)
AS
SELECT
  b.tier,
  b.game_mode,
  b.match_type,
  count(*) AS match_count,
  avg(NULLIF(b.damage, -1::double precision)) AS avg_damage,
  avg(NULLIF(b.kills, -1)) AS avg_kills,
  avg(NULLIF(b.survival_time, -1)) AS avg_survival_time,
  avg(NULLIF(b.duel_win_rate, -1::double precision)) AS avg_duel_win_rate,
  avg(NULLIF(b.initiative_rate, -1::double precision)) AS avg_initiative_rate,
  avg(NULLIF(b.trade_rate, -1::double precision)) AS avg_trade_rate,
  avg(NULLIF(b.revive_rate, -1::double precision)) AS avg_revive_rate,
  avg(NULLIF(b.smoke_rate, -1::double precision)) AS avg_smoke_rate,
  avg(NULLIF(b.pressure_index, -1::double precision)) AS avg_pressure_index,
  avg(NULLIF(b.team_wipes, -1)) AS avg_team_wipes,
  avg(NULLIF(b.reversal_rate, -1::double precision)) AS avg_reversal_rate,
  avg(NULLIF(b.isolation_index, -1::double precision)) AS avg_isolation_index,
  avg(NULLIF(b.min_dist, -1::double precision)) AS avg_min_dist,
  avg(NULLIF(b.counter_latency_ms, -1::double precision)) AS avg_counter_latency_ms,
  avg(NULLIF(b.trade_latency_ms, -1::double precision)) AS avg_trade_latency_ms,
  avg(NULLIF(b.solo_kill_rate, -1)) AS avg_solo_kill_rate,
  avg(NULLIF(b.death_phase, -1)) AS avg_death_phase,
  8::integer AS filter_version,
  1::integer AS population_evidence_version,
  count(*) FILTER (WHERE NULLIF(b.damage, -1::double precision) IS NOT NULL) AS avg_damage_count,
  count(*) FILTER (WHERE NULLIF(b.kills, -1) IS NOT NULL) AS avg_kills_count,
  count(*) FILTER (WHERE NULLIF(b.survival_time, -1) IS NOT NULL) AS avg_survival_time_count,
  count(*) FILTER (WHERE NULLIF(b.duel_win_rate, -1::double precision) IS NOT NULL) AS avg_duel_win_rate_count,
  count(*) FILTER (WHERE NULLIF(b.initiative_rate, -1::double precision) IS NOT NULL) AS avg_initiative_rate_count,
  count(*) FILTER (WHERE NULLIF(b.trade_rate, -1::double precision) IS NOT NULL) AS avg_trade_rate_count,
  count(*) FILTER (WHERE NULLIF(b.revive_rate, -1::double precision) IS NOT NULL) AS avg_revive_rate_count,
  count(*) FILTER (WHERE NULLIF(b.smoke_rate, -1::double precision) IS NOT NULL) AS avg_smoke_rate_count,
  count(*) FILTER (WHERE NULLIF(b.pressure_index, -1::double precision) IS NOT NULL) AS avg_pressure_index_count,
  count(*) FILTER (WHERE NULLIF(b.team_wipes, -1) IS NOT NULL) AS avg_team_wipes_count,
  count(*) FILTER (WHERE NULLIF(b.reversal_rate, -1::double precision) IS NOT NULL) AS avg_reversal_rate_count,
  count(*) FILTER (WHERE NULLIF(b.isolation_index, -1::double precision) IS NOT NULL) AS avg_isolation_index_count,
  count(*) FILTER (WHERE NULLIF(b.min_dist, -1::double precision) IS NOT NULL) AS avg_min_dist_count,
  count(*) FILTER (WHERE NULLIF(b.counter_latency_ms, -1::double precision) IS NOT NULL) AS avg_counter_latency_ms_count,
  count(*) FILTER (WHERE NULLIF(b.trade_latency_ms, -1::double precision) IS NOT NULL) AS avg_trade_latency_ms_count,
  count(*) FILTER (WHERE NULLIF(b.solo_kill_rate, -1) IS NOT NULL) AS avg_solo_kill_rate_count,
  count(*) FILTER (WHERE NULLIF(b.death_phase, -1) IS NOT NULL) AS avg_death_phase_count
FROM public.global_benchmarks AS b
WHERE b.filter_version = 8
  AND b.population_evidence_version = 1
  AND b.match_type IN ('official', 'competitive')
  AND b.game_mode IN ('solo', 'solo-fpp', 'duo', 'duo-fpp', 'squad', 'squad-fpp')
GROUP BY b.tier, b.game_mode, b.match_type;

ALTER VIEW public.benchmark_stats_by_tier OWNER TO postgres;
GRANT SELECT ON TABLE public.benchmark_stats_by_tier TO anon, authenticated;
GRANT ALL ON TABLE public.benchmark_stats_by_tier TO service_role;

-- Partial indexes keep the trusted population small and make the benchmark
-- view and patch-period weapon scans selective without touching legacy rows.
CREATE INDEX IF NOT EXISTS idx_global_benchmarks_population_evidence
  ON public.global_benchmarks (game_mode, match_type, tier, created_at DESC)
  WHERE filter_version = 8
    AND population_evidence_version = 1
    AND match_type IN ('official', 'competitive')
    AND game_mode IN ('solo', 'solo-fpp', 'duo', 'duo-fpp', 'squad', 'squad-fpp');

CREATE INDEX IF NOT EXISTS idx_weapon_meta_match_samples_population_evidence
  ON public.weapon_meta_match_samples (match_type, patch_version, played_at DESC, weapon_category)
  WHERE filter_version = 8
    AND population_evidence_version = 1
    AND match_type IN ('official', 'competitive');

-- Return columns were extended with provenance markers.  PostgreSQL cannot
-- change a function's OUT/RETURNS TABLE row type in place, so remove only
-- these exact overloads before recreating them.  No data is changed.
DROP FUNCTION IF EXISTS public.get_weapon_meta_comparison(text, timestamptz, integer);
DROP FUNCTION IF EXISTS public.get_weapon_meta_comparison(text, timestamptz, integer, text);

CREATE OR REPLACE FUNCTION public.get_weapon_meta_comparison(
  p_patch_version text,
  p_patch_started_at timestamptz,
  p_baseline_days integer,
  p_match_type text
)
RETURNS TABLE (
  weapon_name text,
  weapon_category text,
  period text,
  player_match_count bigint,
  active_pick_count bigint,
  total_damage numeric,
  total_kills bigint,
  total_dbnos bigint,
  first_sec_hits bigint,
  sustained_hits bigint,
  sustained_burst_count bigint,
  burst_sample_count bigint,
  filter_version integer,
  population_evidence_version integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH periods AS (
    SELECT 'pre'::text AS period,
      p_patch_started_at - make_interval(days => p_baseline_days) AS starts_at,
      p_patch_started_at AS ends_at
    UNION ALL
    SELECT 'post'::text, p_patch_started_at, now()
  ), samples AS (
    SELECT
      p.period,
      s.match_id,
      s.platform,
      s.player_id,
      s.weapon_name,
      s.weapon_category,
      s.active_pick,
      s.total_damage,
      s.total_kills,
      s.total_dbnos,
      s.first_sec_hits,
      s.sustained_hits,
      s.sustained_burst_count
    FROM periods AS p
    JOIN public.weapon_meta_match_samples AS s
      ON s.played_at >= p.starts_at
      AND s.played_at < p.ends_at
      AND s.patch_version = CASE p.period
        WHEN 'pre' THEN 'pre_' || p_patch_version
        ELSE p_patch_version
      END
      AND s.filter_version = 8
      AND s.population_evidence_version = 1
      AND s.match_type IN ('official', 'competitive')
      AND (
        lower(coalesce(p_match_type, 'all')) = 'all'
        OR s.match_type = lower(p_match_type)
      )
  ), denominators AS (
    SELECT period, count(DISTINCT (match_id, platform, player_id)) AS player_match_count
    FROM samples
    GROUP BY period
  )
  SELECT
    s.weapon_name,
    max(s.weapon_category) AS weapon_category,
    s.period,
    d.player_match_count,
    count(*) FILTER (WHERE s.active_pick) AS active_pick_count,
    coalesce(sum(s.total_damage) FILTER (WHERE s.active_pick), 0) AS total_damage,
    coalesce(sum(s.total_kills) FILTER (WHERE s.active_pick), 0) AS total_kills,
    coalesce(sum(s.total_dbnos) FILTER (WHERE s.active_pick), 0) AS total_dbnos,
    coalesce(sum(s.first_sec_hits), 0) AS first_sec_hits,
    coalesce(sum(s.sustained_hits), 0) AS sustained_hits,
    coalesce(sum(s.sustained_burst_count), 0) AS sustained_burst_count,
    count(*) FILTER (WHERE s.sustained_hits IS NOT NULL) AS burst_sample_count,
    8::integer AS filter_version,
    1::integer AS population_evidence_version
  FROM samples AS s
  JOIN denominators AS d USING (period)
  GROUP BY s.weapon_name, s.period, d.player_match_count;
$$;

CREATE OR REPLACE FUNCTION public.get_weapon_meta_comparison(
  p_patch_version text,
  p_patch_started_at timestamptz,
  p_baseline_days integer DEFAULT 14
)
RETURNS TABLE (
  weapon_name text,
  weapon_category text,
  period text,
  player_match_count bigint,
  active_pick_count bigint,
  total_damage numeric,
  total_kills bigint,
  total_dbnos bigint,
  first_sec_hits bigint,
  sustained_hits bigint,
  sustained_burst_count bigint,
  burst_sample_count bigint,
  filter_version integer,
  population_evidence_version integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT *
  FROM public.get_weapon_meta_comparison(
    p_patch_version,
    p_patch_started_at,
    p_baseline_days,
    'all'
  );
$$;

ALTER FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer, text) OWNER TO postgres;
ALTER FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer, text) TO service_role;
