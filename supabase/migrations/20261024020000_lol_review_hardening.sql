begin;
set local lock_timeout = '2s';

-- 공개 요청은 원본 IP 대신 용도별 HMAC만 보관한다.
create table public.lol_public_rate_limits (
  bucket_key text primary key check (bucket_key ~ '^(search|read):[0-9a-f]{64}$'),
  window_start timestamptz not null,
  expires_at timestamptz not null check (expires_at > window_start),
  count integer not null check (count > 0)
);
create index lol_public_rate_limits_expiry_idx on public.lol_public_rate_limits(expires_at);
alter table public.lol_public_rate_limits enable row level security;
revoke all on public.lol_public_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.lol_public_rate_limits to service_role;

-- 기존 API 캐시는 짧은 만료 후 삭제되므로 마지막 성공 버전은 한 행으로 별도 보관한다.
create table public.lol_data_dragon_versions (
  singleton boolean primary key default true check (singleton),
  version text not null check (version ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'),
  fetched_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table public.lol_data_dragon_versions enable row level security;
revoke all on public.lol_data_dragon_versions from public, anon, authenticated;
grant select, insert, update, delete on public.lol_data_dragon_versions to service_role;

create function public.consume_lol_public_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_count integer;
  v_expires timestamptz;
begin
  if p_key is null or p_key !~ '^(search|read):[0-9a-f]{64}$'
    or p_limit is null or p_limit not between 1 and 1000
    or p_window_seconds is null or p_window_seconds not between 1 and 3600 then
    raise exception '잘못된 공개 요청 제한 인자' using errcode = '22023';
  end if;
  insert into public.lol_public_rate_limits(bucket_key, window_start, expires_at, count)
  values (p_key, v_now, v_now + pg_catalog.make_interval(secs => p_window_seconds), 1)
  on conflict (bucket_key) do update set
    window_start = case when lol_public_rate_limits.expires_at <= v_now then v_now else lol_public_rate_limits.window_start end,
    expires_at = case when lol_public_rate_limits.expires_at <= v_now
      then v_now + pg_catalog.make_interval(secs => p_window_seconds) else lol_public_rate_limits.expires_at end,
    count = case when lol_public_rate_limits.expires_at <= v_now then 1 else least(lol_public_rate_limits.count + 1, p_limit + 1) end
  returning count, expires_at into v_count, v_expires;
  return pg_catalog.jsonb_build_object('allowed', v_count <= p_limit,
    'retry_after', case when v_count <= p_limit then 0 else greatest(1, ceil(extract(epoch from (v_expires - v_now)))::integer) end);
end;
$$;
revoke all on function public.consume_lol_public_rate_limit(text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_lol_public_rate_limit(text,integer,integer) to service_role;

-- PG17의 FK 선두 열 검사에서 빠진 증강 참조만 보완한다.
create index lol_augments_first_seen_patch_idx on public.lol_augments(first_seen_patch);
create index lol_augments_last_seen_patch_idx on public.lol_augments(last_seen_patch);
create index lol_augment_aliases_source_idx on public.lol_augment_aliases(source_id);
create index lol_augment_patch_changes_platform_idx on public.lol_augment_patch_changes(platform_id);
create index lol_augment_patch_changes_source_idx on public.lol_augment_patch_changes(source_id);
create index lol_augment_ingestion_runs_source_idx on public.lol_augment_ingestion_runs(source_id);
create index lol_augment_publication_patch_idx on public.lol_augment_publication(client_patch);
create index lol_augment_publication_run_idx on public.lol_augment_publication(run_id);

create or replace function public.preview_lol_expired_data()
returns jsonb language sql stable security invoker set search_path = '' as $$
  with cutoff as (select pg_catalog.clock_timestamp() as at), counts as (
    select
      (select pg_catalog.count(*) from public.lol_api_cache, cutoff
       where expires_at <= cutoff.at) as cache_rows,
      (select pg_catalog.count(*) from public.lol_matches, cutoff
       where expires_at <= cutoff.at) as match_rows,
      0::bigint as account_rows,
      (select pg_catalog.count(*) from public.lol_collection_leases, cutoff
       where lease_until <= cutoff.at) as lease_rows,
      (select pg_catalog.count(*) from public.lol_public_rate_limits, cutoff
       where expires_at <= cutoff.at) as public_rate_limit_rows
  )
  select pg_catalog.jsonb_build_object(
    'cache_rows', cache_rows,
    'match_rows', match_rows,
    'account_rows', account_rows,
    'lease_rows', lease_rows,
    'public_rate_limit_rows', public_rate_limit_rows
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
  v_public_rate_limit_rows bigint;
  v_deleted bigint;
  v_day date := (pg_catalog.timezone('Asia/Seoul', pg_catalog.clock_timestamp()))::date;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'p_limit must be between 1 and 1000' using errcode = '22023';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(20261024020000) then
    raise exception '정리 배치가 이미 실행 중입니다' using errcode = '55P03';
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
  v_account_rows := 0;
  delete from public.lol_collection_leases l
  where l.ctid in (
    select ctid from public.lol_collection_leases
    where lease_until <= v_now order by lease_until, lease_key
    limit p_limit for update skip locked
  );
  get diagnostics v_lease_rows = row_count;
  delete from public.lol_public_rate_limits r
  where r.ctid in (
    select ctid from public.lol_public_rate_limits
    where expires_at <= v_now order by expires_at, bucket_key
    limit p_limit for update skip locked
  );
  get diagnostics v_public_rate_limit_rows = row_count;
  v_remaining := public.preview_lol_expired_data();
  v_deleted := v_cache_rows + v_match_rows + v_lease_rows + v_public_rate_limit_rows;
  insert into public.lol_ops_daily(day, metric, value) values (v_day, 'cleanup_deleted', v_deleted)
  on conflict (day, metric) do update set value = public.lol_ops_daily.value + excluded.value;
  insert into public.lol_ops_daily(day, metric, value) values
    (v_day, 'cleanup_remaining', (select coalesce(pg_catalog.sum(value::bigint), 0) from pg_catalog.jsonb_each_text(v_remaining))),
    (v_day, 'cleanup_duration_ms', greatest(0, ceil(extract(epoch from (pg_catalog.clock_timestamp() - v_now)) * 1000)::bigint))
  on conflict (day, metric) do update set value = excluded.value;
  return pg_catalog.jsonb_build_object(
    'deleted', pg_catalog.jsonb_build_object(
      'cache_rows', v_cache_rows, 'match_rows', v_match_rows,
      'account_rows', v_account_rows, 'lease_rows', v_lease_rows,
      'public_rate_limit_rows', v_public_rate_limit_rows
    ),
    'remaining', v_remaining
  );
end;
$$;


commit;
