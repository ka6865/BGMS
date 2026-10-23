begin;
set local lock_timeout = '2s';

create table public.lol_ops_daily (
  day date not null,
  metric text not null,
  value bigint not null default 0 check (value >= 0),
  primary key (day, metric)
);
alter table public.lol_ops_daily enable row level security;
revoke all on public.lol_ops_daily from public, anon, authenticated;
grant select, insert, update, delete on public.lol_ops_daily to service_role;

create or replace function public.increment_lol_ops_metric(p_metric text, p_by integer)
returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_day date := (pg_catalog.timezone('Asia/Seoul', pg_catalog.clock_timestamp()))::date;
begin
  if p_metric is null or p_metric not in (
    'riot_success','riot_429','riot_5xx','riot_network','riot_timeout','riot_key_error',
    'riot_4xx','search_cache_hit','search_cache_miss','detail_cache_hit',
    'detail_cache_miss','raw_reuse','db_error','db_timeout'
  ) then
    raise exception 'invalid LoL ops metric' using errcode = '22023';
  end if;
  if p_by is null or p_by not between 1 and 1000 then
    raise exception 'p_by must be between 1 and 1000' using errcode = '22023';
  end if;
  insert into public.lol_ops_daily (day, metric, value)
  values (v_day, p_metric, p_by)
  on conflict (day, metric) do update
    set value = public.lol_ops_daily.value + excluded.value;
end;
$$;

create or replace function public.preview_lol_expired_data()
returns jsonb language sql stable security invoker set search_path = '' as $$
  with cutoff as (select pg_catalog.clock_timestamp() as at), counts as (
    select
      (select pg_catalog.count(*) from public.lol_api_cache, cutoff
       where expires_at <= cutoff.at) as cache_rows,
      (select pg_catalog.count(*) from public.lol_matches, cutoff
       where expires_at <= cutoff.at) as match_rows,
      (select pg_catalog.count(*) from public.lol_accounts, cutoff
       where last_accessed_at < cutoff.at - interval '90 days') as account_rows,
      (select pg_catalog.count(*) from public.lol_collection_leases, cutoff
       where lease_until <= cutoff.at) as lease_rows
  )
  select pg_catalog.jsonb_build_object(
    'cache_rows', cache_rows,
    'match_rows', match_rows,
    'account_rows', account_rows,
    'lease_rows', lease_rows
  ) from counts;
$$;

create or replace function public.cleanup_lol_expired_batch(p_limit integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_cache_rows bigint;
  v_match_rows bigint;
  v_account_rows bigint;
  v_lease_rows bigint;
  v_remaining jsonb;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'p_limit must be between 1 and 1000' using errcode = '22023';
  end if;
  delete from public.lol_api_cache c
  where c.ctid in (
    select ctid from public.lol_api_cache
    where expires_at <= v_now order by expires_at, cache_key
    limit p_limit for update skip locked
  );
  get diagnostics v_cache_rows = row_count;
  -- 경기별 참가자 cascade 삭제 수는 부모 경기 배치 상한에 포함되지 않는다.
  delete from public.lol_matches m
  where m.ctid in (
    select ctid from public.lol_matches
    where expires_at <= v_now order by expires_at, match_id
    limit p_limit for update skip locked
  );
  get diagnostics v_match_rows = row_count;
  delete from public.lol_accounts a
  where a.ctid in (
    select ctid from public.lol_accounts
    where last_accessed_at < v_now - interval '90 days'
    order by last_accessed_at, puuid
    limit p_limit for update skip locked
  );
  get diagnostics v_account_rows = row_count;
  delete from public.lol_collection_leases l
  where l.ctid in (
    select ctid from public.lol_collection_leases
    where lease_until <= v_now order by lease_until, lease_key
    limit p_limit for update skip locked
  );
  get diagnostics v_lease_rows = row_count;
  v_remaining := public.preview_lol_expired_data();
  return pg_catalog.jsonb_build_object(
    'deleted', pg_catalog.jsonb_build_object(
      'cache_rows', v_cache_rows, 'match_rows', v_match_rows,
      'account_rows', v_account_rows, 'lease_rows', v_lease_rows
    ),
    'remaining', v_remaining
  );
end;
$$;

create or replace function public.get_lol_ops_status()
returns jsonb language sql volatile security invoker set search_path = '' as $$
  with bounds as (
    select (pg_catalog.timezone('Asia/Seoul', pg_catalog.clock_timestamp()))::date as today,
      pg_catalog.clock_timestamp() as now_at
  ), metrics as (
    select d.day, d.metric, d.value from public.lol_ops_daily d, bounds b
    where d.day between b.today - 6 and b.today
  ), rate_limits as (
    select r.host, r.budget_day, r.used_count, r.blocked_until
    from public.lol_rate_limit_state r where r.host in ('global', 'asia', 'kr')
  ), table_sizes as (
    select 'lol_accounts'::text as table_name,
      (select pg_catalog.count(*) from public.lol_accounts) as rows,
      pg_catalog.pg_total_relation_size('public.lol_accounts'::regclass) as total_bytes
    union all select 'lol_ranked_entries',
      (select pg_catalog.count(*) from public.lol_ranked_entries),
      pg_catalog.pg_total_relation_size('public.lol_ranked_entries'::regclass)
    union all select 'lol_ranked_history',
      (select pg_catalog.count(*) from public.lol_ranked_history),
      pg_catalog.pg_total_relation_size('public.lol_ranked_history'::regclass)
    union all select 'lol_matches',
      (select pg_catalog.count(*) from public.lol_matches),
      pg_catalog.pg_total_relation_size('public.lol_matches'::regclass)
    union all select 'lol_match_participants',
      (select pg_catalog.count(*) from public.lol_match_participants),
      pg_catalog.pg_total_relation_size('public.lol_match_participants'::regclass)
    union all select 'lol_api_cache',
      (select pg_catalog.count(*) from public.lol_api_cache),
      pg_catalog.pg_total_relation_size('public.lol_api_cache'::regclass)
    union all select 'lol_rate_limit_state',
      (select pg_catalog.count(*) from public.lol_rate_limit_state),
      pg_catalog.pg_total_relation_size('public.lol_rate_limit_state'::regclass)
    union all select 'lol_collection_leases',
      (select pg_catalog.count(*) from public.lol_collection_leases),
      pg_catalog.pg_total_relation_size('public.lol_collection_leases'::regclass)
    union all select 'lol_ops_daily',
      (select pg_catalog.count(*) from public.lol_ops_daily),
      pg_catalog.pg_total_relation_size('public.lol_ops_daily'::regclass)
  )
  select pg_catalog.jsonb_build_object(
    'today', b.today,
    'todayRiotCalls', coalesce((
      select pg_catalog.sum(m.value) from metrics m
      where m.day = b.today and m.metric like 'riot\_%' escape '\'
    ), 0),
    'metrics', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'day', m.day, 'metric', m.metric, 'value', m.value
      ) order by m.day, m.metric) from metrics m
    ), '[]'::jsonb),
    'rateLimits', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'host', r.host, 'budgetDay', r.budget_day,
        'usedCount', r.used_count, 'blockedUntil', nullif(r.blocked_until,'-infinity'::timestamptz)
      ) order by r.host) from rate_limits r
    ), '[]'::jsonb),
    'cooldownActive', exists (
      select 1 from rate_limits r where r.blocked_until > b.now_at
    ),
    'tables', (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'table', t.table_name, 'rows', t.rows, 'totalBytes', t.total_bytes
      ) order by t.table_name) from table_sizes t
    ),
    'pending', public.preview_lol_expired_data()
  ) from bounds b;
$$;

revoke all on function public.increment_lol_ops_metric(text, integer),
  public.preview_lol_expired_data(), public.cleanup_lol_expired_batch(integer),
  public.get_lol_ops_status() from public, anon, authenticated;
grant execute on function public.increment_lol_ops_metric(text, integer),
  public.preview_lol_expired_data(), public.cleanup_lol_expired_batch(integer),
  public.get_lol_ops_status() to service_role;

commit;
