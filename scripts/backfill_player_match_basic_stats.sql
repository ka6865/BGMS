-- One-time, idempotent fill from stored official stats. No PUBG/telemetry downloads.
-- Run after player_match_basic_combat_stats migration; only NULL fields are updated.
WITH source AS MATERIALIZED (
  SELECT p.player_id, p.platform, p.match_id,
    CASE WHEN jsonb_typeof(t.data #> '{fullResult,stats,DBNOs}') = 'number'
      THEN (t.data #>> '{fullResult,stats,DBNOs}')::numeric END AS knocks,
    CASE WHEN jsonb_typeof(t.data #> '{fullResult,stats,timeSurvived}') = 'number'
      THEN (t.data #>> '{fullResult,stats,timeSurvived}')::numeric END AS survival_time
  FROM public.pubg_player_matches p
  JOIN public.processed_match_telemetry t USING (player_id, platform, match_id)
  WHERE (p.knocks IS NULL OR p.survival_time IS NULL)
    AND lower(t.data #>> '{fullResult,stats,name}') = p.player_id
    AND coalesce(t.data #>> '{fullResult,matchId}', p.match_id) = p.match_id
), updated AS (
  UPDATE public.pubg_player_matches p SET
    knocks = coalesce(p.knocks, CASE WHEN s.knocks BETWEEN 0 AND 2147483647 THEN floor(s.knocks)::integer END),
    survival_time = coalesce(p.survival_time, CASE WHEN s.survival_time BETWEEN 0 AND 2147483647 THEN floor(s.survival_time)::integer END)
  FROM source s
  WHERE p.player_id=s.player_id AND p.platform=s.platform AND p.match_id=s.match_id
    AND ((p.knocks IS NULL AND s.knocks BETWEEN 0 AND 2147483647)
      OR (p.survival_time IS NULL AND s.survival_time BETWEEN 0 AND 2147483647))
  RETURNING p.player_id
)
SELECT count(*) AS updated_rows FROM updated;
