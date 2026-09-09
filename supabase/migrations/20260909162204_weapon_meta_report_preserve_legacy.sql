-- Read-only report. Existing samples and strict benchmark/comparison RPCs are untouched.
-- Legacy baseline is an explicitly labelled reference, never promoted to verified evidence.
CREATE OR REPLACE FUNCTION public.get_weapon_meta_report(
  p_patch_version text, p_patch_started_at timestamptz,
  p_match_type text DEFAULT 'all', p_baseline_source text DEFAULT 'auto'
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF p_patch_version IS NULL OR length(btrim(p_patch_version))=0
    OR p_patch_started_at IS NULL OR p_patch_started_at>now()
    OR p_match_type IS NULL OR p_match_type NOT IN ('all','official','competitive')
    OR p_baseline_source IS NULL OR p_baseline_source NOT IN ('auto','verified','legacy') THEN
    RAISE EXCEPTION 'Invalid weapon meta report parameters' USING ERRCODE='22023';
  END IF;
  WITH base AS MATERIALIZED (
    SELECT s.*, CASE WHEN s.played_at<p_patch_started_at THEN 'pre' ELSE 'post' END AS period,
      coalesce(s.filter_version=8 AND s.population_evidence_version=1,false)
        AND s.match_type IN ('official','competitive') AS verified,
      s.filter_version IS NULL AND s.population_evidence_version IS NULL
        AND s.match_type IN ('official','competitive') AS legacy
    FROM public.weapon_meta_match_samples s
    WHERE s.played_at>=p_patch_started_at-interval '14 days' AND s.played_at<now()
      AND s.patch_version=CASE WHEN s.played_at<p_patch_started_at THEN 'pre_'||p_patch_version ELSE p_patch_version END
      AND (p_match_type='all' OR s.match_type=p_match_type)
  ), population AS (
    SELECT period, count(DISTINCT (match_id,platform,player_id)) AS stored,
      count(DISTINCT (match_id,platform,player_id)) FILTER(WHERE verified) AS verified,
      count(DISTINCT (match_id,platform,player_id)) FILTER(WHERE legacy) AS legacy,
      count(DISTINCT (match_id,platform,player_id)) FILTER(WHERE match_type NOT IN ('official','competitive')) AS unclassified
    FROM base GROUP BY period
  ), choice AS (
    SELECT CASE WHEN p_baseline_source='legacy' THEN 'legacy_reference'
      WHEN p_baseline_source='auto' AND NOT EXISTS(SELECT 1 FROM base WHERE period='pre' AND verified)
        AND EXISTS(SELECT 1 FROM base WHERE period='pre' AND legacy) THEN 'legacy_reference'
      ELSE 'verified' END AS source
  ), selected AS MATERIALIZED (
    SELECT b.* FROM base b CROSS JOIN choice c
    WHERE (b.period='post' AND b.verified)
      OR (b.period='pre' AND CASE WHEN c.source='legacy_reference' THEN b.legacy ELSE b.verified END)
  ), denominators AS (
    SELECT period,count(DISTINCT (match_id,platform,player_id)) AS player_match_count
    FROM selected GROUP BY period
  ), comparison AS (
    SELECT s.weapon_name,max(s.weapon_category) AS weapon_category,s.period,d.player_match_count,
      count(*) FILTER(WHERE active_pick) AS active_pick_count,
      coalesce(sum(total_damage) FILTER(WHERE active_pick),0) AS total_damage,
      coalesce(sum(total_kills) FILTER(WHERE active_pick),0) AS total_kills,
      coalesce(sum(total_dbnos) FILTER(WHERE active_pick),0) AS total_dbnos,
      coalesce(sum(sustained_hits),0) AS sustained_hits,
      count(*) FILTER(WHERE sustained_hits IS NOT NULL) AS burst_sample_count
    FROM selected s JOIN denominators d USING(period)
    GROUP BY s.weapon_name,s.period,d.player_match_count
  ), matches AS (
    SELECT period,match_id,platform,player_id,
      bool_and(first_sec_hits IS NOT NULL AND sustained_hits IS NOT NULL AND sustained_burst_count IS NOT NULL) AS complete
    FROM selected GROUP BY period,match_id,platform,player_id
  ), collection AS (
    SELECT period,count(*) AS total,count(*) FILTER(WHERE complete) AS completed
    FROM matches GROUP BY period
  ), scope_rows AS (
    SELECT s.*, 'weapon'::text AS scope,weapon_name AS scope_name FROM selected s
    UNION ALL SELECT s.*, 'category',weapon_category FROM selected s
    UNION ALL SELECT s.*, 'category','ALL' FROM selected s
  ), daily_denominators AS (
    SELECT (played_at AT TIME ZONE 'UTC')::date AS date,
      count(DISTINCT (match_id,platform,player_id)) AS player_match_count
    FROM selected GROUP BY 1
  ), daily AS (
    SELECT to_char(d.date,'YYYY-MM-DD') AS date,r.scope,r.scope_name AS weapon_name,
      CASE WHEN r.scope='category' THEN r.scope_name ELSE max(r.weapon_category) END AS weapon_category,
      d.player_match_count,count(DISTINCT (r.match_id,r.platform,r.player_id)) FILTER(WHERE r.active_pick) AS weapon_pick_count
    FROM scope_rows r JOIN daily_denominators d ON (r.played_at AT TIME ZONE 'UTC')::date=d.date
    GROUP BY d.date,r.scope,r.scope_name,d.player_match_count
  ), scopes AS (
    SELECT r.scope,r.scope_name AS weapon_category,r.period,d.player_match_count,
      count(DISTINCT (r.match_id,r.platform,r.player_id)) FILTER(WHERE r.active_pick) AS weapon_pick_count
    FROM scope_rows r JOIN denominators d USING(period) WHERE r.scope='category'
    GROUP BY r.scope,r.scope_name,r.period,d.player_match_count
  )
  SELECT jsonb_build_object(
    'baselineSource',(SELECT source FROM choice),
    'population',coalesce((SELECT jsonb_object_agg(period,to_jsonb(p)-'period') FROM population p),'{}'::jsonb),
    'comparison',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY weapon_name,period) FROM comparison c),'[]'::jsonb),
    'dailyWeaponTrend',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY date,scope,weapon_name) FROM daily d),'[]'::jsonb),
    'scopePickShares',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY period,weapon_category) FROM scopes s),'[]'::jsonb),
    'burstCollection',jsonb_build_object(
      'pre',coalesce((SELECT to_jsonb(c)-'period' FROM collection c WHERE period='pre'),'{"total":0,"completed":0}'::jsonb),
      'post',coalesce((SELECT to_jsonb(c)-'period' FROM collection c WHERE period='post'),'{"total":0,"completed":0}'::jsonb)
    )
  ) INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.get_weapon_meta_report(text,timestamptz,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_weapon_meta_report(text,timestamptz,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
