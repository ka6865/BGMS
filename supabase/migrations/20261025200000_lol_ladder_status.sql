begin;
set local lock_timeout = '2s';

-- 개인 식별자 없이 한국 서버의 일별 티어 집계만 보관한다.
create table public.lol_ladder_daily (
  day date not null,
  queue text not null check (queue in ('RANKED_SOLO_5x5','RANKED_FLEX_SR')),
  tier text not null check (tier in ('CHALLENGER','GRANDMASTER','MASTER')),
  player_count integer not null check (player_count between 0 and 150000),
  cutoff_lp integer,
  top_lp integer,
  median_lp numeric,
  fresh_blood_count integer not null check (fresh_blood_count between 0 and player_count),
  hot_streak_count integer not null check (hot_streak_count between 0 and player_count),
  observed_at timestamptz not null,
  primary key (day,queue,tier),
  check (day = (observed_at at time zone 'Asia/Seoul')::date),
  check ((player_count = 0 and cutoff_lp is null and top_lp is null and median_lp is null)
    or (player_count > 0 and cutoff_lp is not null and top_lp is not null and median_lp is not null
      and cutoff_lp between 0 and 100000 and top_lp between cutoff_lp and 100000 and median_lp between cutoff_lp and top_lp))
);
alter table public.lol_ladder_daily enable row level security;
revoke all on public.lol_ladder_daily from public, anon, authenticated;
grant select, insert, update on public.lol_ladder_daily to service_role;

create function public.save_lol_ladder_daily(p_rows jsonb, p_observed_at timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_observed_at is null or not pg_catalog.isfinite(p_observed_at) or p_observed_at > now()+interval '5 minutes'
    or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'invalid ladder snapshot';
  end if;
  if jsonb_array_length(p_rows) <> 6 then raise exception 'six ladder aggregates required'; end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r) <> 'object') then
    raise exception 'invalid ladder aggregate';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r cross join lateral jsonb_object_keys(r) k
    where k not in ('queue','tier','player_count','cutoff_lp','top_lp','median_lp','fresh_blood_count','hot_streak_count')) then
    raise exception 'unknown ladder field';
  end if;
  if (select count(distinct (r.queue,r.tier)) from jsonb_to_recordset(p_rows) r(queue text,tier text)) <> 6 then
    raise exception 'duplicate ladder aggregate';
  end if;
  insert into public.lol_ladder_daily(day,queue,tier,player_count,cutoff_lp,top_lp,median_lp,fresh_blood_count,hot_streak_count,observed_at)
  select (p_observed_at at time zone 'Asia/Seoul')::date,r.queue,r.tier,r.player_count,r.cutoff_lp,r.top_lp,r.median_lp,
    r.fresh_blood_count,r.hot_streak_count,p_observed_at
  from jsonb_to_recordset(p_rows) r(queue text,tier text,player_count integer,cutoff_lp integer,top_lp integer,median_lp numeric,
    fresh_blood_count integer,hot_streak_count integer)
  on conflict (day,queue,tier) do update set player_count=excluded.player_count,cutoff_lp=excluded.cutoff_lp,
    top_lp=excluded.top_lp,median_lp=excluded.median_lp,fresh_blood_count=excluded.fresh_blood_count,
    hot_streak_count=excluded.hot_streak_count,observed_at=excluded.observed_at
  where public.lol_ladder_daily.observed_at < excluded.observed_at;
end $$;

create function public.get_lol_ladder_daily(p_days integer default 30)
returns setof public.lol_ladder_daily language sql stable security invoker set search_path = '' as $$
  select * from public.lol_ladder_daily
  where day between (now() at time zone 'Asia/Seoul')::date - (greatest(1,least(coalesce(p_days,30),30))-1)
    and (now() at time zone 'Asia/Seoul')::date
  order by day,queue,tier;
$$;

create function public.get_lol_ladder_last_snapshot()
returns timestamptz language sql stable security invoker set search_path = '' as $$
  select max(observed_at) from public.lol_ladder_daily;
$$;
revoke all on function public.get_lol_ladder_last_snapshot() from public, anon, authenticated;
grant execute on function public.get_lol_ladder_last_snapshot() to service_role;

-- 상태 응답은 공개 공지이지만 캐시의 쓰기와 조회는 서버만 수행한다.
create table public.lol_platform_status_cache (
  platform text primary key check (platform = 'kr'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 1048576),
  fetched_at timestamptz not null default now(),
  next_refresh_at timestamptz not null default now()+interval '5 minutes'
);
alter table public.lol_platform_status_cache enable row level security;
revoke all on public.lol_platform_status_cache from public, anon, authenticated;
grant select, insert, update on public.lol_platform_status_cache to service_role;

create function public.get_lol_platform_status()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('payload',payload,'fetchedAt',fetched_at,'nextRefreshAt',next_refresh_at)
  from public.lol_platform_status_cache where platform='kr';
$$;

create function public.save_lol_platform_status(p_payload jsonb)
returns void language sql security invoker set search_path = '' as $$
  insert into public.lol_platform_status_cache(platform,payload,fetched_at,next_refresh_at)
  values ('kr',p_payload,now(),now()+interval '5 minutes')
  on conflict (platform) do update set payload=excluded.payload,fetched_at=excluded.fetched_at,next_refresh_at=excluded.next_refresh_at;
$$;

-- upstream 장애 중에도 인스턴스가 바뀔 때마다 재호출하지 않고 5분 뒤 재시도한다.
create function public.defer_lol_platform_status()
returns void language sql security invoker set search_path = '' as $$
  insert into public.lol_platform_status_cache(platform,payload,fetched_at,next_refresh_at)
  values ('kr','{}'::jsonb,'epoch'::timestamptz,now()+interval '5 minutes')
  on conflict (platform) do update set next_refresh_at=excluded.next_refresh_at;
$$;

revoke all on function public.save_lol_ladder_daily(jsonb,timestamptz) from public, anon, authenticated;
revoke all on function public.get_lol_ladder_daily(integer) from public, anon, authenticated;
revoke all on function public.get_lol_platform_status() from public, anon, authenticated;
revoke all on function public.save_lol_platform_status(jsonb) from public, anon, authenticated;
revoke all on function public.defer_lol_platform_status() from public, anon, authenticated;
grant execute on function public.save_lol_ladder_daily(jsonb,timestamptz) to service_role;
grant execute on function public.get_lol_ladder_daily(integer) to service_role;
grant execute on function public.get_lol_platform_status() to service_role;
grant execute on function public.save_lol_platform_status(jsonb) to service_role;
grant execute on function public.defer_lol_platform_status() to service_role;
commit;
