begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- 전역 정리 커서 대신 현재 연동 회원의 원본만 인덱스로 먼저 좁힌다.
create function public.list_linked_unretained_match_performance(
  p_platform text, p_player_id text, p_limit integer default 100
)
returns setof public.processed_match_telemetry
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_platform text := lower(btrim(p_platform));
  v_player_id text := lower(btrim(p_player_id));
begin
  if v_platform is null or v_platform not in ('steam','kakao')
    or v_player_id is null or v_player_id = '' or p_limit is null or p_limit < 1 then
    raise exception 'linked-performance-input-invalid' using errcode = '22023';
  end if;
  if not exists(select 1 from public.profiles p
    where lower(btrim(p.pubg_platform)) = v_platform
      and lower(btrim(p.pubg_nickname)) = v_player_id) then
    return;
  end if;

  return query
  with sources as materialized (
    select s as source,
      case when s.data->'fullResult'->>'v' ~ '^[0-9]{1,10}$'
        then (s.data->'fullResult'->>'v')::bigint end as result_version,
      case when coalesce(s.data->'fullResult'->>'calculationVersion','0') ~ '^[0-9]{1,10}$'
        then coalesce(s.data->'fullResult'->>'calculationVersion','0')::bigint end as calculation_version
    from public.processed_match_telemetry s
    where s.platform = v_platform and s.player_id = v_player_id
      and s.data->'fullResult'->'stats'->>'playerId' ~ '^account\.[A-Za-z0-9_-]+$'
      and lower(btrim(s.data->'fullResult'->'stats'->>'name')) = v_player_id
      and exists(select 1 from public.pubg_player_matches m
        where m.platform = s.platform and m.player_id = s.player_id and m.match_id = s.match_id
          and m.played_at < now() - interval '14 days'
          and (m.account_id is null or m.account_id = s.data->'fullResult'->'stats'->>'playerId'))
  )
  select (v.source).* from sources v
  where v.result_version between 1 and 2147483647 and v.calculation_version between 0 and 2147483647
    and not exists(select 1 from public.pubg_match_performance p
      where p.platform = (v.source).platform and p.player_id = (v.source).player_id
        and p.match_id = (v.source).match_id
        and p.account_id = (v.source).data->'fullResult'->'stats'->>'playerId'
        and p.result_version = v.result_version and p.calculation_version = v.calculation_version
        and p.summary_version >= 1 and p.summary is not null)
  order by (v.source).updated_at, (v.source).match_id
  limit least(p_limit,100);
end;
$$;
revoke all on function public.list_linked_unretained_match_performance(text,text,integer) from public,anon,authenticated;
grant execute on function public.list_linked_unretained_match_performance(text,text,integer) to service_role;

commit;
