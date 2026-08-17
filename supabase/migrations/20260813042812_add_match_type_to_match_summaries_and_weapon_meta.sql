-- Keep the PUBG match type next to the compact match summary and weapon-meta
-- sample. Unknown historical rows are deliberately not guessed as ranked.
ALTER TABLE public.pubg_player_matches
  ADD COLUMN IF NOT EXISTS match_type text NOT NULL DEFAULT 'unknown';

ALTER TABLE public.weapon_meta_match_samples
  ADD COLUMN IF NOT EXISTS match_type text NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS idx_pubg_player_matches_mode_pagination
  ON public.pubg_player_matches (player_id, platform, match_type, played_at DESC);

CREATE INDEX IF NOT EXISTS idx_weapon_meta_match_samples_mode_patch_played
  ON public.weapon_meta_match_samples (match_type, patch_version, played_at DESC, weapon_category);

-- First use the compact benchmark table, then the full stored analysis. Both
-- joins use the canonical player/match/platform identity, so they cannot mix
-- another player's match type into this player's history.
UPDATE public.pubg_player_matches AS target
SET match_type = lower(source.match_type)
FROM public.global_benchmarks AS source
WHERE target.match_id = source.match_id
  AND target.platform = source.platform
  AND target.player_id = source.player_id
  AND lower(source.match_type) IN ('official', 'competitive');

UPDATE public.pubg_player_matches AS target
SET match_type = lower(coalesce(source.data #>> '{fullResult,matchType}', source.data #>> '{matchType}'))
FROM public.processed_match_telemetry AS source
WHERE target.match_id = source.match_id
  AND target.platform = source.platform
  AND target.player_id = source.player_id
  AND lower(coalesce(source.data #>> '{fullResult,matchType}', source.data #>> '{matchType}', '')) IN ('official', 'competitive');

UPDATE public.weapon_meta_match_samples AS target
SET match_type = lower(source.match_type)
FROM public.global_benchmarks AS source
WHERE target.match_id = source.match_id
  AND target.platform = source.platform
  AND target.player_id = source.player_id
  AND lower(source.match_type) IN ('official', 'competitive');

UPDATE public.weapon_meta_match_samples AS target
SET match_type = lower(coalesce(source.data #>> '{fullResult,matchType}', source.data #>> '{matchType}'))
FROM public.processed_match_telemetry AS source
WHERE target.match_id = source.match_id
  AND target.platform = source.platform
  AND target.player_id = source.player_id
  AND lower(coalesce(source.data #>> '{fullResult,matchType}', source.data #>> '{matchType}', '')) IN ('official', 'competitive');

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
    SELECT p.period, s.match_id, s.platform, s.player_id, s.weapon_name,
      s.weapon_category, s.active_pick, s.total_damage, s.total_kills,
      s.total_dbnos, s.first_sec_hits, s.sustained_hits, s.sustained_burst_count
    FROM periods p
    JOIN public.weapon_meta_match_samples s
      ON s.played_at >= p.starts_at
      AND s.played_at < p.ends_at
      AND s.patch_version = CASE p.period WHEN 'pre' THEN 'pre_' || p_patch_version ELSE p_patch_version END
      AND (CASE WHEN p_match_type = 'all' THEN s.match_type IN ('official', 'competitive') ELSE s.match_type = p_match_type END)
  ), denominators AS (
    SELECT period, count(DISTINCT (match_id, platform, player_id)) AS player_match_count
    FROM samples GROUP BY period
  )
  SELECT s.weapon_name, max(s.weapon_category), s.period, d.player_match_count,
    count(*) FILTER (WHERE s.active_pick),
    coalesce(sum(s.total_damage) FILTER (WHERE s.active_pick), 0),
    coalesce(sum(s.total_kills) FILTER (WHERE s.active_pick), 0),
    coalesce(sum(s.total_dbnos) FILTER (WHERE s.active_pick), 0),
    coalesce(sum(s.first_sec_hits), 0), coalesce(sum(s.sustained_hits), 0),
    coalesce(sum(s.sustained_burst_count), 0), count(*) FILTER (WHERE s.sustained_hits IS NOT NULL)
  FROM samples s JOIN denominators d USING (period)
  GROUP BY s.weapon_name, s.period, d.player_match_count;
$$;

-- Keep the old three-argument RPC callable until every deployed function has
-- switched to the new mode-aware call.
CREATE OR REPLACE FUNCTION public.get_weapon_meta_comparison(
  p_patch_version text,
  p_patch_started_at timestamptz,
  p_baseline_days integer DEFAULT 14
)
RETURNS TABLE (
  weapon_name text, weapon_category text, period text, player_match_count bigint,
  active_pick_count bigint, total_damage numeric, total_kills bigint, total_dbnos bigint,
  first_sec_hits bigint, sustained_hits bigint, sustained_burst_count bigint, burst_sample_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT * FROM public.get_weapon_meta_comparison(p_patch_version, p_patch_started_at, p_baseline_days, 'all');
$$;

REVOKE ALL ON FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer, text) TO service_role;
