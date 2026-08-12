-- Idempotent player-match weapon facts. Aggregation happens at read time so a
-- re-analysis cannot inflate the patch comparison.
CREATE TABLE IF NOT EXISTS public.weapon_meta_match_samples (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match_id text NOT NULL,
  platform text NOT NULL,
  player_id text NOT NULL,
  played_at timestamptz NOT NULL,
  patch_version text NOT NULL,
  weapon_category text NOT NULL,
  weapon_name text NOT NULL,
  active_pick boolean NOT NULL DEFAULT false,
  total_kills integer NOT NULL DEFAULT 0,
  total_dbnos integer NOT NULL DEFAULT 0,
  total_damage numeric(12, 2) NOT NULL DEFAULT 0,
  hit_count integer NOT NULL DEFAULT 0,
  first_sec_hits integer,
  sustained_hits integer,
  sustained_burst_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_weapon_meta_match_sample UNIQUE (match_id, platform, player_id, weapon_name)
);

ALTER TABLE public.weapon_meta_match_samples ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.weapon_meta_match_samples TO service_role;

CREATE INDEX IF NOT EXISTS idx_weapon_meta_match_samples_patch_played
  ON public.weapon_meta_match_samples (patch_version, played_at DESC, weapon_category);

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
  burst_sample_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH periods AS (
    SELECT 'pre'::text AS period, p_patch_started_at - make_interval(days => p_baseline_days) AS starts_at, p_patch_started_at AS ends_at
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
    FROM periods p
    JOIN public.weapon_meta_match_samples s
      ON s.played_at >= p.starts_at AND s.played_at < p.ends_at
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
    count(*) FILTER (WHERE s.sustained_hits IS NOT NULL) AS burst_sample_count
  FROM samples s
  JOIN denominators d USING (period)
  GROUP BY s.weapon_name, s.period, d.player_match_count;
$$;

REVOKE ALL ON FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer) TO service_role;
