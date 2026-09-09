-- Keep original rows, but environmental explosions are not gun adoption or damage.
-- Exclude all registered maintenance gaps, including gaps in the previous 14 days.
-- Daily chart dates use the same Korean time zone as the period labels.
CREATE OR REPLACE FUNCTION public.get_weapon_meta_patch_report(
 p_patch_version text DEFAULT NULL,p_match_type text DEFAULT 'all'
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE result jsonb; target public.weapon_meta_patches; ends_at timestamptz;
BEGIN
 IF p_match_type IS NULL OR p_match_type NOT IN ('all','official','competitive') THEN
  RAISE EXCEPTION 'Invalid match type' USING ERRCODE='22023';
 END IF;
 SELECT * INTO target FROM public.weapon_meta_patches
 WHERE p_patch_version IS NULL OR version=p_patch_version ORDER BY starts_at DESC LIMIT 1;
 IF target.version IS NULL THEN RAISE EXCEPTION 'Unknown patch' USING ERRCODE='22023'; END IF;
 SELECT min(maintenance_started_at) INTO ends_at FROM public.weapon_meta_patches WHERE starts_at>target.starts_at;
 WITH selected AS MATERIALIZED (
  SELECT s.*,CASE WHEN s.played_at<target.maintenance_started_at THEN 'pre' ELSE 'post' END AS period
  FROM public.weapon_meta_match_samples s
  WHERE s.played_at>=target.maintenance_started_at-interval '14 days'
   AND s.played_at<least(coalesce(ends_at,now()),now())
   AND (s.played_at<target.maintenance_started_at OR s.played_at>=target.starts_at)
   AND NOT EXISTS (SELECT 1 FROM public.weapon_meta_patches p WHERE s.played_at>=p.maintenance_started_at AND s.played_at<p.starts_at)
   AND s.weapon_name NOT ILIKE '%gaspump%'
   AND s.platform IN ('steam','kakao')
   AND s.match_type IN ('official','competitive')
   AND (p_match_type='all' OR s.match_type=p_match_type)
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
    SELECT (played_at AT TIME ZONE 'Asia/Seoul')::date AS date,
      count(DISTINCT (match_id,platform,player_id)) AS player_match_count
    FROM selected GROUP BY 1
  ), daily AS (
    SELECT to_char(d.date,'YYYY-MM-DD') AS date,r.scope,r.scope_name AS weapon_name,
      CASE WHEN r.scope='category' THEN r.scope_name ELSE max(r.weapon_category) END AS weapon_category,
      d.player_match_count,count(DISTINCT (r.match_id,r.platform,r.player_id)) FILTER(WHERE r.active_pick) AS weapon_pick_count
    FROM scope_rows r JOIN daily_denominators d ON (r.played_at AT TIME ZONE 'Asia/Seoul')::date=d.date
    GROUP BY d.date,r.scope,r.scope_name,d.player_match_count
  ), scopes AS (
    SELECT r.scope,r.scope_name AS weapon_category,r.period,d.player_match_count,
      count(DISTINCT (r.match_id,r.platform,r.player_id)) FILTER(WHERE r.active_pick) AS weapon_pick_count
    FROM scope_rows r JOIN denominators d USING(period) WHERE r.scope='category'
    GROUP BY r.scope,r.scope_name,r.period,d.player_match_count
  )
  SELECT jsonb_build_object(
    'patchVersion',target.version,'patchStartedAt',target.starts_at,
    'preStartedAt',target.maintenance_started_at-interval '14 days',
    'preEndedAt',target.maintenance_started_at,'postEndedAt',ends_at,
    'timingStatus',target.timing_status,
    'scheduled',target.starts_at>now(),
    'patches',(SELECT jsonb_agg(jsonb_build_object('version',version,'startsAt',starts_at) ORDER BY starts_at DESC) FROM public.weapon_meta_patches),
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
REVOKE ALL ON FUNCTION public.get_weapon_meta_patch_report(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_weapon_meta_patch_report(text,text) TO service_role;
NOTIFY pgrst,'reload schema';
