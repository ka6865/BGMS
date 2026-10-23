begin;
set local lock_timeout = '2s';

create table public.lol_accounts (
  puuid text primary key check (length(puuid) between 1 and 128),
  public_id uuid not null unique default gen_random_uuid(),
  game_name text not null check (length(game_name) between 1 and 64),
  tag_line text not null check (length(tag_line) between 1 and 16),
  platform_id text not null check (platform_id in ('kr','jp1','na1','br1','la1','la2','eun1','euw1','me1','tr1','ru','oc1','sg2','tw2','vn2')),
  regional_route text not null check (regional_route in ('americas','asia','europe','sea')),
  profile_icon_id integer check (profile_icon_id is null or profile_icon_id >= 0),
  summoner_level bigint check (summoner_level is null or summoner_level >= 0),
  account_fetched_at timestamptz not null default now(),
  profile_fetched_at timestamptz,
  ranked_checked_at timestamptz,
  last_accessed_at timestamptz not null default now(),
  check ((platform_id in ('kr','jp1') and regional_route = 'asia')
    or (platform_id in ('na1','br1','la1','la2') and regional_route = 'americas')
    or (platform_id in ('eun1','euw1','me1','tr1','ru') and regional_route = 'europe')
    or (platform_id in ('oc1','sg2','tw2','vn2') and regional_route = 'sea'))
);
create index lol_accounts_name_lookup on public.lol_accounts (lower(game_name), lower(tag_line));
create index lol_accounts_last_accessed on public.lol_accounts (last_accessed_at);

create table public.lol_ranked_entries (
  puuid text not null references public.lol_accounts(puuid) on delete cascade,
  platform_id text not null,
  queue_type text not null check (queue_type in ('RANKED_SOLO_5x5','RANKED_FLEX_SR')),
  tier text not null check (length(tier) <= 24),
  rank text not null check (length(rank) <= 8),
  league_points integer not null check (league_points >= 0),
  wins integer not null check (wins >= 0),
  losses integer not null check (losses >= 0),
  fetched_at timestamptz not null default now(),
  primary key (puuid, platform_id, queue_type),
  check (platform_id in ('kr','jp1','na1','br1','la1','la2','eun1','euw1','me1','tr1','ru','oc1','sg2','tw2','vn2'))
);

create table public.lol_matches (
  match_id text primary key check (match_id ~ '^[A-Z0-9]+_[0-9]{1,20}$'),
  platform_id text not null,
  regional_route text not null,
  queue_id integer not null check (queue_id >= 0),
  map_id integer check (map_id is null or map_id >= 0),
  game_version text not null check (length(game_version) <= 32),
  started_at timestamptz not null,
  duration_seconds integer not null check (duration_seconds >= 0),
  teams jsonb not null check (jsonb_typeof(teams) = 'array' and octet_length(teams::text) <= 16384),
  data_version integer not null check (data_version > 0),
  summary_version integer not null default 1 check (summary_version > 0),
  request_json jsonb not null check (octet_length(request_json::text) <= 1048576),
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null check (expires_at <= fetched_at + interval '7 days'),
  check ((platform_id in ('kr','jp1') and regional_route = 'asia')
    or (platform_id in ('na1','br1','la1','la2') and regional_route = 'americas')
    or (platform_id in ('eun1','euw1','me1','tr1','ru') and regional_route = 'europe')
    or (platform_id in ('oc1','sg2','tw2','vn2') and regional_route = 'sea'))
);
create index lol_matches_expires on public.lol_matches (expires_at);

create table public.lol_match_participants (
  match_id text not null references public.lol_matches(match_id) on delete cascade,
  participant_id smallint not null check (participant_id > 0),
  puuid text,
  team_id smallint not null,
  champion_id integer not null check (champion_id >= 0),
  team_position text,
  win boolean not null,
  kills integer check (kills is null or kills >= 0),
  deaths integer check (deaths is null or deaths >= 0),
  assists integer check (assists is null or assists >= 0),
  cs integer check (cs is null or cs >= 0),
  neutral_minions_killed integer check (neutral_minions_killed is null or neutral_minions_killed >= 0),
  gold_earned integer check (gold_earned is null or gold_earned >= 0),
  damage_to_champions integer check (damage_to_champions is null or damage_to_champions >= 0),
  vision_score integer check (vision_score is null or vision_score >= 0),
  wards_placed integer check (wards_placed is null or wards_placed >= 0),
  wards_killed integer check (wards_killed is null or wards_killed >= 0),
  damage_to_objectives integer check (damage_to_objectives is null or damage_to_objectives >= 0),
  items integer[] check (items is null or cardinality(items) = 7),
  perks jsonb check (perks is null or (jsonb_typeof(perks) = 'object' and octet_length(perks::text) <= 8192)),
  played_at timestamptz not null,
  queue_id integer not null check (queue_id >= 0),
  primary key (match_id, participant_id),
  unique (match_id, puuid)
);
create index lol_match_participants_account_recent on public.lol_match_participants (puuid, played_at desc, match_id desc) where puuid is not null;

create table public.lol_api_cache (
  cache_key text primary key check (length(cache_key) between 1 and 512),
  kind text not null check (kind in ('search','match_details')),
  platform_id text not null,
  regional_route text not null,
  data_version text not null check (length(data_version) between 1 and 32),
  payload jsonb not null check (octet_length(payload::text) <= 262144),
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null check (expires_at > fetched_at and expires_at <= fetched_at + case when kind = 'search' then interval '2 minutes' else interval '7 days' end),
  check ((platform_id in ('kr','jp1') and regional_route = 'asia')
    or (platform_id in ('na1','br1','la1','la2') and regional_route = 'americas')
    or (platform_id in ('eun1','euw1','me1','tr1','ru') and regional_route = 'europe')
    or (platform_id in ('oc1','sg2','tw2','vn2') and regional_route = 'sea'))
);
create index lol_api_cache_expiry on public.lol_api_cache (expires_at);

create table public.lol_rate_limit_state (
  host text primary key check (host in ('global','asia','kr')),
  next_permit_at timestamptz not null default now(),
  blocked_until timestamptz not null default '-infinity',
  min_interval_ms integer not null default 1500 check (min_interval_ms >= 1500),
  last_started_at timestamptz,
  budget_day date not null default (timezone('UTC', now()))::date,
  used_count integer not null default 0 check (used_count >= 0),
  app_rate_limit text,
  app_rate_count text,
  method_rate_limit text,
  method_rate_count text,
  headers_observed_at timestamptz
);
insert into public.lol_rate_limit_state (host) values ('global'),('asia'),('kr');

create table public.lol_collection_leases (
  lease_key text primary key check (length(lease_key) between 1 and 256),
  lease_type text not null check (lease_type in ('collection','request')),
  lease_token uuid not null,
  lease_until timestamptz not null,
  request_host text check (request_host is null or request_host in ('asia','kr')),
  permit_at timestamptz
);
create index lol_collection_leases_expiry on public.lol_collection_leases (lease_until);
grant usage on schema public to service_role;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'lol_accounts','lol_ranked_entries','lol_matches','lol_match_participants',
    'lol_api_cache','lol_rate_limit_state','lol_collection_leases'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
  end loop;
end $$;

create or replace function public.acquire_lol_collection_lease(p_key text, p_ttl_seconds integer)
returns table (lease_token uuid, lease_until timestamptz)
language plpgsql security invoker set search_path = '' as $$
declare v_token uuid := gen_random_uuid(); v_until timestamptz;
begin
  if p_key is null or length(p_key) not between 1 and 256 or p_key like 'request:%'
    or p_ttl_seconds not between 1 and 120 then raise exception 'invalid lease request' using errcode = '22023'; end if;
  insert into public.lol_collection_leases (lease_key, lease_type, lease_token, lease_until)
  values (p_key, 'collection', v_token, pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_ttl_seconds))
  on conflict (lease_key) do update set lease_token = excluded.lease_token,
    lease_until = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_ttl_seconds)
    where public.lol_collection_leases.lease_type = 'collection'
      and public.lol_collection_leases.lease_until <= pg_catalog.clock_timestamp()
  returning public.lol_collection_leases.lease_token,public.lol_collection_leases.lease_until into v_token,v_until;
  if not found then return; end if;
  return query select v_token, v_until;
end $$;

create or replace function public.release_lol_collection_lease(p_key text, p_token uuid)
returns boolean language sql security invoker set search_path = '' as $$
  with deleted as (
    delete from public.lol_collection_leases
    where lease_key = p_key and lease_type = 'collection' and lease_token = p_token
    returning 1
  ) select exists(select 1 from deleted)
$$;

create or replace function public.reserve_lol_riot_request(p_host text)
returns table (granted boolean, lease_token uuid, permit_at timestamptz, retry_after_seconds integer, reason text)
language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz; v_day date;
  v_global public.lol_rate_limit_state%rowtype; v_host public.lol_rate_limit_state%rowtype;
  v_live integer; v_permit timestamptz; v_token uuid := gen_random_uuid(); v_retry integer;
begin
  if p_host not in ('asia','kr') then raise exception 'invalid Riot host' using errcode = '22023'; end if;
  select * into v_global from public.lol_rate_limit_state where host = 'global' for update;
  select * into v_host from public.lol_rate_limit_state where host = p_host for update;
  if v_global.host is null or v_host.host is null then raise exception 'rate limit state missing' using errcode = '55000'; end if;
  v_now := pg_catalog.clock_timestamp(); v_day := (pg_catalog.timezone('UTC',v_now))::date;
  delete from public.lol_collection_leases where lease_type = 'request' and lease_until <= v_now;
  if v_global.budget_day <> v_day then
    update public.lol_rate_limit_state set budget_day = v_day, used_count = 0 where host = 'global' returning * into v_global;
  end if;
  if greatest(v_global.blocked_until, v_host.blocked_until) > v_now then
    v_retry := greatest(1, ceil(extract(epoch from greatest(v_global.blocked_until, v_host.blocked_until) - v_now))::integer);
    return query select false, null::uuid, null::timestamptz, v_retry, 'cooldown'; return;
  end if;
  if v_global.used_count >= 40 then
    v_retry := greatest(1, ceil(extract(epoch from ((v_day + 1)::timestamp at time zone 'UTC') - v_now))::integer);
    return query select false, null::uuid, null::timestamptz, v_retry, 'daily_budget'; return;
  end if;
  select count(*)::integer into v_live from public.lol_collection_leases where lease_type = 'request';
  if v_live >= 2 then return query select false, null::uuid, null::timestamptz, 1, 'concurrency'; return; end if;
  v_permit := greatest(v_now, v_global.next_permit_at);
  update public.lol_rate_limit_state set next_permit_at = v_permit + pg_catalog.make_interval(secs=>v_global.min_interval_ms::double precision/1000), used_count = used_count + 1 where host = 'global';
  insert into public.lol_collection_leases (lease_key, lease_type, lease_token, lease_until, request_host, permit_at)
    values ('request:' || v_token::text, 'request', v_token, v_permit + interval '12 seconds', p_host, v_permit);
  return query select true, v_token, v_permit, 0, 'granted';
end $$;

create or replace function public.start_lol_riot_request(p_token uuid)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql security invoker set search_path = '' as $$
declare v_host text; v_blocked timestamptz; v_permit timestamptz; v_lease_until timestamptz; v_now timestamptz;
  v_global public.lol_rate_limit_state%rowtype; v_retry integer;
begin
  select * into v_global from public.lol_rate_limit_state where host='global' for update;
  if v_global.host is null then raise exception 'global rate limit state missing' using errcode='55000'; end if;
  select request_host,permit_at,lease_until into v_host,v_permit,v_lease_until from public.lol_collection_leases
    where lease_key = 'request:' || p_token::text and lease_token = p_token
      and lease_type = 'request' for update;
  v_now := pg_catalog.clock_timestamp();
  if v_host is null or v_lease_until<=v_now then return query select false, 1; return; end if;
  select blocked_until into v_blocked from public.lol_rate_limit_state where host = v_host;
  select greatest(v_blocked, blocked_until) into v_blocked from public.lol_rate_limit_state where host = 'global';
  if v_blocked > v_now then
    delete from public.lol_collection_leases where lease_key = 'request:' || p_token::text and lease_token = p_token;
    return query select false, greatest(1, ceil(extract(epoch from v_blocked - v_now))::integer); return;
  end if;
  if greatest(v_permit,v_global.last_started_at + pg_catalog.make_interval(secs=>v_global.min_interval_ms::double precision/1000)) > v_now then
    v_retry := greatest(1,ceil(extract(epoch from greatest(v_permit,v_global.last_started_at + pg_catalog.make_interval(secs=>v_global.min_interval_ms::double precision/1000))-v_now))::integer);
    delete from public.lol_collection_leases where lease_key = 'request:' || p_token::text and lease_token = p_token;
    return query select false,v_retry; return;
  end if;
  update public.lol_rate_limit_state set last_started_at=v_now where host='global';
  return query select true, 0;
end $$;

create or replace function public.release_lol_riot_request(p_token uuid)
returns boolean language sql security invoker set search_path = '' as $$
  with deleted as (
    delete from public.lol_collection_leases where lease_key = 'request:' || p_token::text
      and lease_type = 'request' and lease_token = p_token returning 1
  ) select exists(select 1 from deleted)
$$;

create or replace function public.block_lol_riot_requests(p_host text, p_retry_after_seconds integer)
returns timestamptz language plpgsql security invoker set search_path = '' as $$
declare v_until timestamptz;
begin
  if p_host not in ('asia','kr') or p_retry_after_seconds not between 1 and 604800 then
    raise exception 'invalid cooldown' using errcode = '22023';
  end if;
  perform 1 from public.lol_rate_limit_state where host='global' for update;
  perform 1 from public.lol_rate_limit_state where host=p_host for update;
  v_until := pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_retry_after_seconds);
  update public.lol_rate_limit_state set blocked_until = greatest(blocked_until, v_until) where host = 'global';
  update public.lol_rate_limit_state set blocked_until = greatest(blocked_until, v_until) where host = p_host;
  delete from public.lol_collection_leases where lease_type = 'request';
  select blocked_until into v_until from public.lol_rate_limit_state where host = 'global';
  return v_until;
end $$;

create or replace function public.record_lol_riot_rate_headers(
  p_host text, p_app_limit text, p_app_count text, p_method_limit text, p_method_count text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_app_limits text[] := case when coalesce(p_app_limit,'')='' then array[]::text[] else pg_catalog.string_to_array(p_app_limit,',') end;
  v_method_limits text[] := case when coalesce(p_method_limit,'')='' then array[]::text[] else pg_catalog.string_to_array(p_method_limit,',') end;
  v_app_counts text[] := case when coalesce(p_app_count,'')='' then array[]::text[] else pg_catalog.string_to_array(p_app_count,',') end;
  v_method_counts text[] := case when coalesce(p_method_count,'')='' then array[]::text[] else pg_catalog.string_to_array(p_method_count,',') end;
  v_parts text[]; v_item text; v_limit_item text; v_limit integer; v_window integer; v_observed integer; v_scope text;
  v_limits text[]; v_counts text[];
  v_interval_ms bigint := 1500; v_cooldown_until timestamptz := '-infinity'; v_fail_closed_until timestamptz;
begin
  if p_host not in ('asia','kr') then raise exception 'invalid Riot host' using errcode = '22023'; end if;
  perform 1 from public.lol_rate_limit_state where host='global' for update;
  perform 1 from public.lol_rate_limit_state where host=p_host for update;
  v_now := pg_catalog.clock_timestamp();
  begin
    if octet_length(coalesce(p_app_limit,''))>256 or octet_length(coalesce(p_app_count,''))>256
      or octet_length(coalesce(p_method_limit,''))>256 or octet_length(coalesce(p_method_count,''))>256 then
      raise exception 'unsupported Riot rate header size' using errcode='22023'; end if;
    foreach v_item in array v_app_limits || v_method_limits loop
      v_parts := pg_catalog.string_to_array(pg_catalog.btrim(v_item),':');
      if pg_catalog.array_length(v_parts,1) is distinct from 2 or v_parts[1] !~ '^[0-9]+$' or v_parts[2] !~ '^[0-9]+$'
        or pg_catalog.length(v_parts[1])>10 or pg_catalog.length(v_parts[2])>5
        or v_parts[1]::numeric<1 or v_parts[1]::numeric>2147483647 or v_parts[2]::integer<1 or v_parts[2]::integer>86400 then
        raise exception 'unsupported Riot rate limit header' using errcode='22023'; end if;
      v_interval_ms := greatest(v_interval_ms,ceil(1000.0*v_parts[2]::integer/(v_parts[1]::integer*0.8))::bigint);
    end loop;
    foreach v_scope in array array['app','method'] loop
      v_limits := case when v_scope='app' then v_app_limits else v_method_limits end;
      v_counts := case when v_scope='app' then v_app_counts else v_method_counts end;
      foreach v_item in array v_counts loop
        v_parts := pg_catalog.string_to_array(pg_catalog.btrim(v_item),':');
        if pg_catalog.array_length(v_parts,1) is distinct from 2 or v_parts[1] !~ '^[0-9]+$' or v_parts[2] !~ '^[0-9]+$'
          or pg_catalog.length(v_parts[1])>10 or pg_catalog.length(v_parts[2])>5
          or v_parts[1]::numeric>2147483647 or v_parts[2]::integer<1 or v_parts[2]::integer>86400 then
          raise exception 'unsupported Riot rate count header' using errcode='22023'; end if;
        v_observed := v_parts[1]::integer; v_window := v_parts[2]::integer; v_limit := null;
        foreach v_limit_item in array v_limits loop
          v_parts := pg_catalog.string_to_array(pg_catalog.btrim(v_limit_item),':');
          if pg_catalog.array_length(v_parts,1)=2 and v_parts[2] ~ '^[0-9]+$' and v_parts[2]::integer=v_window then
            v_limit := case when v_limit is null then v_parts[1]::integer else least(v_limit,v_parts[1]::integer) end;
          end if;
        end loop;
        if v_limit is null then raise exception 'Riot rate count has no matching window' using errcode='22023'; end if;
        if v_observed >= ceil(v_limit*0.8) then v_cooldown_until := greatest(v_cooldown_until,v_now+pg_catalog.make_interval(secs=>v_window)); end if;
      end loop;
    end loop;
  exception when sqlstate '22023' or numeric_value_out_of_range then
    v_fail_closed_until := ((pg_catalog.timezone('UTC',v_now)::date + 1)::timestamp at time zone 'UTC');
    update public.lol_rate_limit_state set blocked_until=greatest(blocked_until,v_fail_closed_until) where host='global';
    update public.lol_rate_limit_state set blocked_until=greatest(blocked_until,v_fail_closed_until) where host=p_host;
    delete from public.lol_collection_leases where lease_type='request';
    return false;
  end;
  update public.lol_rate_limit_state set app_rate_limit = coalesce(left(p_app_limit,256),app_rate_limit),
    app_rate_count = coalesce(left(p_app_count,256),app_rate_count), method_rate_limit = coalesce(left(p_method_limit,256),method_rate_limit),
    method_rate_count = coalesce(left(p_method_count,256),method_rate_count), headers_observed_at = pg_catalog.clock_timestamp()
    where host = p_host;
  if not found then raise exception 'rate limit state missing' using errcode = '55000'; end if;
  update public.lol_rate_limit_state set min_interval_ms=greatest(min_interval_ms,v_interval_ms::integer),
    next_permit_at=greatest(next_permit_at,v_now+pg_catalog.make_interval(secs=>v_interval_ms::double precision/1000)) where host='global';
  if v_cooldown_until > v_now then
    update public.lol_rate_limit_state set blocked_until=greatest(blocked_until,v_cooldown_until) where host='global';
    update public.lol_rate_limit_state set blocked_until=greatest(blocked_until,v_cooldown_until) where host=p_host;
    delete from public.lol_collection_leases where lease_type='request';
  end if;
  return true;
end $$;

create or replace function public.get_lol_api_cache(p_key text, p_kind text, p_platform text, p_route text, p_version text)
returns jsonb language sql security invoker set search_path = '' as $$
  select payload from public.lol_api_cache
  where cache_key = p_key and kind = p_kind and platform_id = p_platform and regional_route = p_route
    and data_version = p_version and expires_at > pg_catalog.clock_timestamp()
$$;

create or replace function public.get_lol_match_request_json(p_match_id text,p_platform text,p_route text)
returns jsonb language sql security invoker set search_path = '' as $$
  select request_json from public.lol_matches
  where match_id = p_match_id and platform_id = p_platform and regional_route = p_route
    and expires_at > pg_catalog.clock_timestamp()
$$;

create or replace function public.persist_lol_search_snapshot(
  p_lease_key text, p_token uuid, p_cache_key text, p_cache_payload jsonb,
  p_platform text, p_route text, p_version text, p_account jsonb, p_ranked jsonb, p_matches jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz; v_lease_until timestamptz; v_match jsonb; v_raw jsonb; v_info jsonb; v_participant jsonb;
  v_puuid text; v_match_id text; v_queue integer; v_played timestamptz; v_started timestamptz; v_data_version integer;
begin
  if p_platform not in ('kr','jp1','na1','br1','la1','la2','eun1','euw1','me1','tr1','ru','oc1','sg2','tw2','vn2')
    or p_route not in ('americas','asia','europe','sea') or length(p_version) > 32
    or jsonb_typeof(p_account) <> 'object' or jsonb_typeof(p_ranked) <> 'array' or jsonb_typeof(p_matches) <> 'array'
    or octet_length(p_cache_payload::text) > 262144 or p_lease_key is null or p_token is null then
    raise exception 'invalid LoL snapshot' using errcode = '22023';
  end if;
  select lease_until into v_lease_until from public.lol_collection_leases where lease_key=p_lease_key and lease_type='collection'
    and lease_token=p_token for update;
  v_now := pg_catalog.clock_timestamp();
  if not found or v_lease_until <= v_now then
    raise exception 'stale LoL collection lease' using errcode = '40001';
  end if;
  v_puuid := p_account->>'puuid';
  if v_puuid is null or length(v_puuid) not between 1 and 128 then raise exception 'invalid PUUID' using errcode='22023'; end if;
  insert into public.lol_accounts (puuid,game_name,tag_line,platform_id,regional_route,profile_icon_id,summoner_level,account_fetched_at,profile_fetched_at,ranked_checked_at,last_accessed_at)
  values (v_puuid,p_account->>'game_name',p_account->>'tag_line',p_platform,p_route,nullif(p_account->>'profile_icon_id','')::integer,
    nullif(p_account->>'summoner_level','')::bigint,v_now,v_now,v_now,v_now)
  on conflict (puuid) do update set game_name=excluded.game_name,tag_line=excluded.tag_line,platform_id=excluded.platform_id,
    regional_route=excluded.regional_route,profile_icon_id=excluded.profile_icon_id,summoner_level=excluded.summoner_level,
    account_fetched_at=v_now,profile_fetched_at=v_now,ranked_checked_at=v_now,last_accessed_at=v_now;
  delete from public.lol_ranked_entries where puuid=v_puuid and platform_id=p_platform;
  insert into public.lol_ranked_entries (puuid,platform_id,queue_type,tier,rank,league_points,wins,losses,fetched_at)
  select v_puuid,p_platform,r.queue_type,r.tier,r.rank,r.league_points,r.wins,r.losses,v_now
  from jsonb_to_recordset(p_ranked) as r(queue_type text,tier text,rank text,league_points integer,wins integer,losses integer);

  for v_match in select value from jsonb_array_elements(p_matches) loop
    v_raw := v_match->'raw'; v_info := v_raw->'info'; v_match_id := v_match->'summary'->>'matchId';
    if v_raw->'metadata'->>'matchId' is distinct from v_match_id or v_match_id is null or jsonb_typeof(v_info->'participants') is distinct from 'array' then
      raise exception 'invalid Riot match payload' using errcode='22023'; end if;
    v_queue := coalesce((v_info->>'queueId')::integer,0);
    v_data_version := coalesce(nullif(v_raw->'metadata'->>'dataVersion','')::integer,1);
    v_started := pg_catalog.to_timestamp((coalesce((v_info->>'gameStartTimestamp')::numeric,(v_info->>'gameCreation')::numeric,
      (v_info->>'gameEndTimestamp')::numeric - coalesce((v_info->>'gameDuration')::numeric,0)*1000) / 1000)::double precision);
    v_played := pg_catalog.to_timestamp((coalesce((v_info->>'gameEndTimestamp')::numeric,(v_info->>'gameStartTimestamp')::numeric,
      (v_info->>'gameCreation')::numeric) / 1000)::double precision);
    if v_info->>'gameStartTimestamp' is null and v_info->>'gameCreation' is null and v_info->>'gameEndTimestamp' is null then
      raise exception 'Riot match timestamp missing' using errcode='22023'; end if;
    insert into public.lol_matches (match_id,platform_id,regional_route,queue_id,map_id,game_version,started_at,duration_seconds,teams,data_version,summary_version,request_json,fetched_at,expires_at)
    values (v_match_id,p_platform,p_route,v_queue,nullif(v_info->>'mapId','')::integer,coalesce(v_info->>'gameVersion','Unknown'),
      v_started,coalesce((v_info->>'gameDuration')::integer,0),coalesce(v_info->'teams','[]'::jsonb),v_data_version,1,v_raw,v_now,v_now+interval '7 days')
    on conflict (match_id) do update set queue_id=excluded.queue_id,map_id=excluded.map_id,game_version=excluded.game_version,
      started_at=excluded.started_at,duration_seconds=excluded.duration_seconds,teams=excluded.teams,data_version=excluded.data_version,
      request_json=case when public.lol_matches.expires_at<=v_now then excluded.request_json else public.lol_matches.request_json end,
      fetched_at=case when public.lol_matches.expires_at<=v_now then excluded.fetched_at else public.lol_matches.fetched_at end,
      expires_at=case when public.lol_matches.expires_at<=v_now then excluded.expires_at else public.lol_matches.expires_at end
      where public.lol_matches.platform_id=excluded.platform_id and public.lol_matches.regional_route=excluded.regional_route;
    if not found then raise exception 'Riot match route conflict' using errcode='23505'; end if;
    for v_participant in select value from jsonb_array_elements(v_info->'participants') loop
      insert into public.lol_match_participants (match_id,participant_id,puuid,team_id,champion_id,team_position,win,kills,deaths,assists,cs,
        neutral_minions_killed,gold_earned,damage_to_champions,vision_score,wards_placed,wards_killed,damage_to_objectives,items,perks,played_at,queue_id)
      values (v_match_id,(v_participant->>'participantId')::smallint,nullif(v_participant->>'puuid',''),coalesce((v_participant->>'teamId')::smallint,0),
        coalesce((v_participant->>'championId')::integer,0),nullif(v_participant->>'teamPosition',''),coalesce((v_participant->>'win')::boolean,false),
        nullif(v_participant->>'kills','')::integer,nullif(v_participant->>'deaths','')::integer,nullif(v_participant->>'assists','')::integer,
        nullif(v_participant->>'totalMinionsKilled','')::integer,nullif(v_participant->>'neutralMinionsKilled','')::integer,
        nullif(v_participant->>'goldEarned','')::integer,nullif(v_participant->>'totalDamageDealtToChampions','')::integer,
        nullif(v_participant->>'visionScore','')::integer,nullif(v_participant->>'wardsPlaced','')::integer,nullif(v_participant->>'wardsKilled','')::integer,
        nullif(v_participant->>'damageDealtToObjectives','')::integer,
        array[(v_participant->>'item0')::integer,(v_participant->>'item1')::integer,(v_participant->>'item2')::integer,(v_participant->>'item3')::integer,
          (v_participant->>'item4')::integer,(v_participant->>'item5')::integer,(v_participant->>'item6')::integer],
        nullif(v_participant->'perks','null'::jsonb),v_played,v_queue)
      on conflict (match_id,participant_id) do update set puuid=excluded.puuid,team_id=excluded.team_id,champion_id=excluded.champion_id,
        team_position=excluded.team_position,win=excluded.win,kills=excluded.kills,deaths=excluded.deaths,assists=excluded.assists,cs=excluded.cs,
        neutral_minions_killed=excluded.neutral_minions_killed,gold_earned=excluded.gold_earned,damage_to_champions=excluded.damage_to_champions,
        vision_score=excluded.vision_score,wards_placed=excluded.wards_placed,wards_killed=excluded.wards_killed,
        damage_to_objectives=excluded.damage_to_objectives,items=excluded.items,perks=excluded.perks,played_at=excluded.played_at,queue_id=excluded.queue_id;
    end loop;
  end loop;
  insert into public.lol_api_cache (cache_key,kind,platform_id,regional_route,data_version,payload,fetched_at,expires_at)
  values (p_cache_key,'search',p_platform,p_route,p_version,p_cache_payload,v_now,v_now+interval '2 minutes')
  on conflict (cache_key) do update set kind=excluded.kind,platform_id=excluded.platform_id,regional_route=excluded.regional_route,
    data_version=excluded.data_version,payload=excluded.payload,fetched_at=v_now,expires_at=excluded.expires_at;
  delete from public.lol_collection_leases where lease_key=p_lease_key and lease_token=p_token;
  return true;
end $$;

create or replace function public.persist_lol_match_details(
  p_lease_key text,p_token uuid,p_cache_key text,p_cache_payload jsonb,p_platform text,p_route text,p_version text,
  p_match jsonb,p_participants jsonb,p_teams jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz; v_lease_until timestamptz; v_match_id text; v_info jsonb; v_participant jsonb; v_queue integer; v_played timestamptz; v_started timestamptz; v_data_version integer; v_match_expires_at timestamptz;
begin
  if jsonb_typeof(p_match)<>'object' or jsonb_typeof(p_participants)<>'array' or jsonb_typeof(p_teams)<>'array'
    or octet_length(p_cache_payload::text)>262144 then raise exception 'invalid match payload' using errcode='22023'; end if;
  select lease_until into v_lease_until from public.lol_collection_leases where lease_key=p_lease_key and lease_type='collection'
    and lease_token=p_token for update;
  v_now := pg_catalog.clock_timestamp();
  if not found or v_lease_until<=v_now then raise exception 'stale LoL collection lease' using errcode='40001'; end if;
  v_match_id := p_match->'metadata'->>'matchId'; v_info := p_match->'info';
  if v_match_id is null or jsonb_typeof(v_info->'participants') is distinct from 'array' then raise exception 'invalid Riot match payload' using errcode='22023'; end if;
  v_queue := coalesce((v_info->>'queueId')::integer,0); v_data_version := coalesce(nullif(p_match->'metadata'->>'dataVersion','')::integer,1);
  v_started := pg_catalog.to_timestamp((coalesce((v_info->>'gameStartTimestamp')::numeric,(v_info->>'gameCreation')::numeric,
    (v_info->>'gameEndTimestamp')::numeric - coalesce((v_info->>'gameDuration')::numeric,0)*1000)/1000)::double precision);
  v_played := pg_catalog.to_timestamp((coalesce((v_info->>'gameEndTimestamp')::numeric,(v_info->>'gameStartTimestamp')::numeric,
    (v_info->>'gameCreation')::numeric)/1000)::double precision);
  if v_info->>'gameStartTimestamp' is null and v_info->>'gameCreation' is null and v_info->>'gameEndTimestamp' is null then
    raise exception 'Riot match timestamp missing' using errcode='22023'; end if;
  insert into public.lol_matches (match_id,platform_id,regional_route,queue_id,map_id,game_version,started_at,duration_seconds,teams,data_version,summary_version,request_json,fetched_at,expires_at)
  values(v_match_id,p_platform,p_route,v_queue,nullif(v_info->>'mapId','')::integer,coalesce(v_info->>'gameVersion','Unknown'),
    v_started,coalesce((v_info->>'gameDuration')::integer,0),p_teams,
    v_data_version,1,p_match,v_now,v_now+interval '7 days')
  on conflict(match_id) do update set queue_id=excluded.queue_id,map_id=excluded.map_id,game_version=excluded.game_version,started_at=excluded.started_at,
    duration_seconds=excluded.duration_seconds,teams=excluded.teams,data_version=excluded.data_version,
    request_json=case when public.lol_matches.expires_at<=v_now then excluded.request_json else public.lol_matches.request_json end,
    fetched_at=case when public.lol_matches.expires_at<=v_now then excluded.fetched_at else public.lol_matches.fetched_at end,
    expires_at=case when public.lol_matches.expires_at<=v_now then excluded.expires_at else public.lol_matches.expires_at end
    where public.lol_matches.platform_id=excluded.platform_id and public.lol_matches.regional_route=excluded.regional_route;
  if not found then raise exception 'Riot match route conflict' using errcode='23505'; end if;
  select expires_at into v_match_expires_at from public.lol_matches where match_id=v_match_id;
  delete from public.lol_match_participants where match_id=v_match_id;
  for v_participant in select value from jsonb_array_elements(p_participants) loop
    insert into public.lol_match_participants (match_id,participant_id,puuid,team_id,champion_id,team_position,win,kills,deaths,assists,cs,
      neutral_minions_killed,gold_earned,damage_to_champions,vision_score,wards_placed,wards_killed,damage_to_objectives,items,perks,played_at,queue_id)
    values(v_match_id,(v_participant->>'participantId')::smallint,nullif(v_participant->>'puuid',''),coalesce((v_participant->>'teamId')::smallint,0),
      coalesce((v_participant->>'championId')::integer,0),nullif(v_participant->>'teamPosition',''),coalesce((v_participant->>'win')::boolean,false),
      nullif(v_participant->>'kills','')::integer,nullif(v_participant->>'deaths','')::integer,nullif(v_participant->>'assists','')::integer,
      nullif(v_participant->>'totalMinionsKilled','')::integer,nullif(v_participant->>'neutralMinionsKilled','')::integer,
      nullif(v_participant->>'goldEarned','')::integer,nullif(v_participant->>'totalDamageDealtToChampions','')::integer,nullif(v_participant->>'visionScore','')::integer,
      nullif(v_participant->>'wardsPlaced','')::integer,nullif(v_participant->>'wardsKilled','')::integer,nullif(v_participant->>'damageDealtToObjectives','')::integer,
      array[(v_participant->>'item0')::integer,(v_participant->>'item1')::integer,(v_participant->>'item2')::integer,(v_participant->>'item3')::integer,
        (v_participant->>'item4')::integer,(v_participant->>'item5')::integer,(v_participant->>'item6')::integer],
      nullif(v_participant->'perks','null'::jsonb),v_played,v_queue);
  end loop;
  insert into public.lol_api_cache(cache_key,kind,platform_id,regional_route,data_version,payload,fetched_at,expires_at)
  values(p_cache_key,'match_details',p_platform,p_route,p_version,p_cache_payload,v_now,least(v_match_expires_at,v_now+interval '7 days'))
  on conflict(cache_key) do update set kind=excluded.kind,platform_id=excluded.platform_id,regional_route=excluded.regional_route,
    data_version=excluded.data_version,payload=excluded.payload,fetched_at=v_now,expires_at=excluded.expires_at;
  delete from public.lol_collection_leases where lease_key=p_lease_key and lease_token=p_token;
  return true;
end $$;

create or replace function public.cleanup_lol_expired_data()
returns table (cache_rows bigint, match_rows bigint, account_rows bigint, lease_rows bigint)
language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.lol_api_cache where expires_at <= pg_catalog.clock_timestamp(); get diagnostics cache_rows = row_count;
  delete from public.lol_matches where expires_at <= pg_catalog.clock_timestamp(); get diagnostics match_rows = row_count;
  delete from public.lol_accounts where last_accessed_at < pg_catalog.clock_timestamp() - interval '90 days'; get diagnostics account_rows = row_count;
  delete from public.lol_collection_leases where lease_until <= pg_catalog.clock_timestamp(); get diagnostics lease_rows = row_count;
  return next;
end $$;

revoke all on function public.acquire_lol_collection_lease(text,integer), public.release_lol_collection_lease(text,uuid),
  public.reserve_lol_riot_request(text), public.release_lol_riot_request(uuid), public.block_lol_riot_requests(text,integer),
  public.start_lol_riot_request(uuid),
  public.record_lol_riot_rate_headers(text,text,text,text,text), public.get_lol_api_cache(text,text,text,text,text),
  public.get_lol_match_request_json(text,text,text),
  public.persist_lol_search_snapshot(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb),
  public.persist_lol_match_details(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb), public.cleanup_lol_expired_data()
  from public, anon, authenticated;
grant execute on function public.acquire_lol_collection_lease(text,integer), public.release_lol_collection_lease(text,uuid),
  public.reserve_lol_riot_request(text), public.release_lol_riot_request(uuid), public.block_lol_riot_requests(text,integer),
  public.start_lol_riot_request(uuid),
  public.record_lol_riot_rate_headers(text,text,text,text,text), public.get_lol_api_cache(text,text,text,text,text),
  public.get_lol_match_request_json(text,text,text),
  public.persist_lol_search_snapshot(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb),
  public.persist_lol_match_details(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb), public.cleanup_lol_expired_data()
  to service_role;

commit;
