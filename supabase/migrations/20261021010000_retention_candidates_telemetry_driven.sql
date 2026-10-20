-- 보존 후보 조회가 커서 이후 전적 전체를 훑다가 statement timeout(57014)에 걸리던 문제를 고친다.
--
-- 기존: pubg_player_matches 를 (played_at, platform, match_id) 커서 인덱스로 순서대로 읽으면서
--       "텔레메트리가 있는 경기인가"를 행마다 사후 필터로 확인했다. 커서와 기준일 사이에
--       텔레메트리 없는 참가자 행이 수십만 개 쌓이면 후보 1000개를 채우려고 거의 전부를 훑어
--       PostgREST 의 8초 제한을 넘는다.
-- 변경: 텔레메트리 레지스트리(map cache, processed telemetry)의 경기 키에서 출발해
--       경기별 최초 played_at 을 식별 인덱스로 한 번씩 찾고, 그 뒤에 커서와 기준일 조건을 건다.
--       읽는 양이 전적 전체가 아니라 텔레메트리가 있는 경기 수에 비례한다.
--
-- 반환 계약은 그대로다. 경기마다 가장 이른 played_at 의 행 하나(player_id 가 가장 작은 행)를
-- (played_at, platform, match_id) 순서로 돌려주며, 입력 검증과 권한도 같다.
create or replace function public.list_retention_archive_candidates(
  p_limit integer,
  p_cutoff timestamptz,
  p_after_played_at timestamptz default null,
  p_after_platform text default null,
  p_after_match_id text default null
)
returns setof public.pubg_player_matches
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000
    or p_cutoff is null
    or p_cutoff > pg_catalog.now() - interval '14 days' then
    raise exception 'retention-candidate-input-invalid' using errcode = '22023';
  end if;

  if not (
    p_after_played_at is null and p_after_platform is null and p_after_match_id is null
  ) and (
    p_after_played_at is null or p_after_platform is null or p_after_match_id is null
    or p_after_platform not in ('steam', 'kakao')
    or p_after_match_id !~ '^[A-Za-z0-9_-]{1,128}$'
    or p_after_played_at >= p_cutoff
  ) then
    raise exception 'retention-candidate-cursor-invalid' using errcode = '22023';
  end if;

  return query
  with keys as (
    select c.platform, c.match_id from public.telemetry_map_cache_entries c
    union
    select t.platform, t.match_id from public.processed_match_telemetry t
  ), firsts as (
    select k.platform, k.match_id, f.played_at
    from keys k
    cross join lateral (
      select e.played_at from public.pubg_player_matches e
      where e.platform = k.platform and e.match_id = k.match_id
      order by e.played_at
      limit 1
    ) f
    where k.platform in ('steam', 'kakao')
  ), picked as (
    select x.platform, x.match_id, x.played_at
    from firsts x
    where x.played_at < p_cutoff
      and (p_after_played_at is null
        or (x.played_at, x.platform, x.match_id) > (p_after_played_at, p_after_platform, p_after_match_id))
    order by x.played_at, x.platform, x.match_id
    limit p_limit
  )
  select m.*
  from picked c
  cross join lateral (
    select r.* from public.pubg_player_matches r
    where r.platform = c.platform and r.match_id = c.match_id and r.played_at = c.played_at
    order by r.player_id
    limit 1
  ) m
  order by m.played_at, m.platform, m.match_id, m.player_id;
end;
$$;

revoke all on function public.list_retention_archive_candidates(integer, timestamptz, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.list_retention_archive_candidates(integer, timestamptz, timestamptz, text, text)
  to service_role;
