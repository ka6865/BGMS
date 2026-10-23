begin;
set local lock_timeout = '2s';

-- 기존 저장 함수도 이 RPC를 호출하므로 캐시에 동일한 일별 이력이 원자적으로 포함된다.
create or replace function public.get_lol_ranked_history(p_puuid text, p_limit integer)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with bounds as (
    select (current_timestamp at time zone 'Asia/Seoul')::date as today,
      (current_timestamp at time zone 'Asia/Seoul')::date - (greatest(1,least(coalesce(p_limit,30),30))-1) as first_day
  ), queues(queue_type) as (values ('RANKED_SOLO_5x5'),('RANKED_FLEX_SR'))
  select jsonb_object_agg(queues.queue_type,jsonb_build_object(
    'points',coalesce((
      select jsonb_agg(jsonb_build_object(
        'date',(recent.recorded_at at time zone 'Asia/Seoul')::date,
        'recordedAt',recent.recorded_at,'tier',recent.tier,'rank',recent.rank,'lp',recent.league_points,
        'wins',recent.wins,'losses',recent.losses,'isBaseline',recent.is_baseline
      ) order by recent.recorded_at,recent.id)
      from (
        (select distinct on ((recorded_at at time zone 'Asia/Seoul')::date)
          id,recorded_at,tier,rank,league_points,wins,losses,false as is_baseline
        from public.lol_ranked_history
        where puuid=p_puuid and queue_type=queues.queue_type
          and recorded_at >= bounds.first_day::timestamp at time zone 'Asia/Seoul'
          and recorded_at < (bounds.today+1)::timestamp at time zone 'Asia/Seoul'
        order by (recorded_at at time zone 'Asia/Seoul')::date,recorded_at desc,id desc)
        union all
        (select id,recorded_at,tier,rank,league_points,wins,losses,true as is_baseline
        from public.lol_ranked_history
        where puuid=p_puuid and queue_type=queues.queue_type
          and recorded_at < bounds.first_day::timestamp at time zone 'Asia/Seoul'
        order by recorded_at desc,id desc limit 1)
      ) recent
    ),'[]'::jsonb),
    'highest',(
      select jsonb_build_object('recordedAt',recorded_at,'tier',tier,'rank',rank,'lp',league_points)
      from public.lol_ranked_history where puuid=p_puuid and queue_type=queues.queue_type
      order by coalesce(array_position(array['IRON','BRONZE','SILVER','GOLD','PLATINUM','EMERALD','DIAMOND','MASTER','GRANDMASTER','CHALLENGER'],tier),0) desc,
        coalesce(array_position(array['IV','III','II','I'],rank),0) desc,league_points desc,recorded_at,id
      limit 1
    ),
    'trackingSince',(
      select min(recorded_at) from public.lol_ranked_history where puuid=p_puuid and queue_type=queues.queue_type
    )
  )) from queues cross join bounds;
$$;
revoke all on function public.get_lol_ranked_history(text,integer) from public, anon, authenticated;
grant execute on function public.get_lol_ranked_history(text,integer) to service_role;

commit;
