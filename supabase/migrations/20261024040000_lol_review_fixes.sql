begin;
set local lock_timeout = '2s';

-- 비정상 헤더 차단만 10분으로 줄이고 기존 파서·권한 계약은 유지한다.
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
    v_fail_closed_until := v_now + interval '10 minutes';
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

create or replace function public.delete_lol_account_data(p_puuid text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_riot_id text; v_riot_ids text[]; v_match_ids text[];
  v_accounts bigint; v_ranked bigint; v_history bigint; v_summaries bigint;
  v_teammates bigint; v_participants bigint; v_matches bigint; v_cache bigint; v_leases bigint;
begin
  if p_puuid is null or length(p_puuid) not between 1 and 128 then
    raise exception 'invalid PUUID' using errcode='22023';
  end if;
  select game_name || '#' || tag_line into v_riot_id from public.lol_accounts where puuid=p_puuid for update;
  select coalesce(array_agg(match_id),'{}'::text[]) into v_match_ids from public.lol_matches m
  where exists (select 1 from jsonb_array_elements(coalesce(m.request_json->'info'->'participants','[]'::jsonb)) p where p->>'puuid'=p_puuid)
    or exists (select 1 from public.lol_match_participants p where p.match_id=m.match_id and p.puuid=p_puuid);
  select array_agg(distinct lower(riot_id)) into v_riot_ids from (
    select v_riot_id as riot_id
    union all
    select (p->>'riotIdGameName') || '#' || (p->>'riotIdTagline')
    from public.lol_matches m, jsonb_array_elements(coalesce(m.request_json->'info'->'participants','[]'::jsonb)) p
    where m.match_id=any(v_match_ids) and p->>'puuid'=p_puuid
  ) ids where riot_id is not null;
  -- 계정·관련 경기의 수집만 취소하고 다른 계정과 운영 정리 lease는 보존한다.
  delete from public.lol_collection_leases l where l.lease_type='collection' and (
    l.lease_key='collect:' || p_puuid
    or l.lease_key=any(array(select 'match:' || id from unnest(v_match_ids) id))
    or l.lease_key=any(array(select 'search:v10:' || id from unnest(v_riot_ids) id))
  );
  get diagnostics v_leases = row_count;
  select count(*) into v_ranked from public.lol_ranked_entries where puuid=p_puuid;
  select count(*) into v_history from public.lol_ranked_history where puuid=p_puuid;
  select count(*) into v_summaries from public.lol_player_match_summaries where puuid=p_puuid;
  -- DTO 내부의 과거 이름과 동료 참조도 제거하려고 짧은 캐시는 모두 무효화한다.
  delete from public.lol_api_cache;
  get diagnostics v_cache = row_count;
  update public.lol_player_match_summaries s set teammates=(
    select coalesce(jsonb_agg(t order by n),'[]'::jsonb)
    from jsonb_array_elements(s.teammates) with ordinality x(t,n)
    where t->>'puuid' is distinct from p_puuid and not coalesce(lower(t->>'riotId')=any(v_riot_ids),false)
  ) where exists (
    select 1 from jsonb_array_elements(s.teammates) t where t->>'puuid'=p_puuid or lower(t->>'riotId')=any(v_riot_ids)
  );
  get diagnostics v_teammates = row_count;
  select count(*) into v_participants from public.lol_match_participants where match_id=any(v_match_ids);
  -- 원문의 식별자를 재사용하거나 다시 백필하지 않도록 관련 원문도 제거한다.
  delete from public.lol_matches where match_id=any(v_match_ids);
  get diagnostics v_matches = row_count;
  delete from public.lol_accounts where puuid=p_puuid;
  get diagnostics v_accounts = row_count;
  return jsonb_build_object('account_rows',v_accounts,'ranked_rows',v_ranked,'history_rows',v_history,
    'summary_rows',v_summaries,'teammate_rows',v_teammates,'participant_rows',v_participants,'match_rows',v_matches,'cache_rows',v_cache,'lease_rows',v_leases);
end;
$$;

-- 검색의 180초 lease를 저장소에서도 허용한다.
create or replace function public.acquire_lol_collection_lease(p_key text, p_ttl_seconds integer)
returns table (lease_token uuid, lease_until timestamptz)
language plpgsql security invoker set search_path = '' as $$
declare v_token uuid := gen_random_uuid(); v_until timestamptz;
begin
  if p_key is null or length(p_key) not between 1 and 256 or p_key like 'request:%'
    or p_ttl_seconds not between 1 and 180 then raise exception 'invalid lease request' using errcode = '22023'; end if;
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

revoke all on function public.acquire_lol_collection_lease(text,integer) from public, anon, authenticated;
grant execute on function public.acquire_lol_collection_lease(text,integer) to service_role;

revoke all on function public.record_lol_riot_rate_headers(text,text,text,text,text), public.delete_lol_account_data(text) from public, anon, authenticated;
grant execute on function public.record_lol_riot_rate_headers(text,text,text,text,text), public.delete_lol_account_data(text) to service_role;

commit;
