\echo 'LoL ladder/status: 권한, 멱등 저장, KST 날짜 경계, 집계 검증, 캐시'
do $$
declare role_name text; signature text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    foreach signature in array array['public.get_lol_ladder_daily(integer)','public.save_lol_ladder_daily(jsonb,timestamptz)',
      'public.get_lol_ladder_last_snapshot()','public.get_lol_platform_status()','public.save_lol_platform_status(jsonb)','public.defer_lol_platform_status()'] loop
      if has_function_privilege(role_name,signature,'EXECUTE') then raise exception 'public RPC grant: %', signature; end if;
    end loop;
    if has_table_privilege(role_name,'public.lol_ladder_daily','SELECT')
      or has_table_privilege(role_name,'public.lol_platform_status_cache','SELECT') then raise exception 'public table grant'; end if;
  end loop;
  if exists (select 1 from pg_class where oid in ('public.lol_ladder_daily'::regclass,'public.lol_platform_status_cache'::regclass)
    and not relrowsecurity) then raise exception 'RLS missing'; end if;
  if exists (select 1 from pg_proc where proname in ('save_lol_ladder_daily','get_lol_ladder_daily','get_lol_platform_status',
    'get_lol_ladder_last_snapshot','save_lol_platform_status','defer_lol_platform_status') and (prosecdef or not ('search_path=""'=any(proconfig)))) then
    raise exception 'unsafe RPC';
  end if;
end $$;
set role service_role;
do $$
declare
  rows jsonb;
  midnight timestamptz := ((now() at time zone 'Asia/Seoul')::date)::timestamp at time zone 'Asia/Seoul';
  value jsonb;
begin
  select jsonb_agg(jsonb_build_object('queue',q,'tier',t,'player_count',2,'cutoff_lp',100,'top_lp',201,'median_lp',150.5,
    'fresh_blood_count',1,'hot_streak_count',0)) into rows
    from unnest(array['RANKED_SOLO_5x5','RANKED_FLEX_SR']) q cross join unnest(array['CHALLENGER','GRANDMASTER','MASTER']) t;
  perform public.save_lol_ladder_daily(rows,midnight-interval '1 microsecond');
  perform public.save_lol_ladder_daily(rows,midnight);
  perform public.save_lol_ladder_daily(rows,midnight);
  if (select count(*) from public.lol_ladder_daily)<>12
    or (select count(*) from public.get_lol_ladder_daily(1))<>6 then raise exception 'KST boundary or idempotency'; end if;
  perform public.save_lol_ladder_daily(jsonb_set(rows,'{0,cutoff_lp}','90'),midnight+interval '1 microsecond');
  perform public.save_lol_ladder_daily(rows,midnight);
  if (select cutoff_lp from public.lol_ladder_daily where day=(midnight at time zone 'Asia/Seoul')::date
      and queue='RANKED_SOLO_5x5' and tier='CHALLENGER')<>90 then raise exception 'older overwrite'; end if;
  if public.get_lol_ladder_last_snapshot() <> midnight+interval '1 microsecond' then raise exception 'last snapshot'; end if;
  begin
    perform public.save_lol_ladder_daily(rows-0,midnight);
    raise exception 'short snapshot accepted';
  exception when invalid_parameter_value or raise_exception then
    if sqlerrm='short snapshot accepted' then raise; end if;
  end;
  begin
    perform public.save_lol_ladder_daily(jsonb_set(rows,'{0,puuid}','"private-id"'),midnight);
    raise exception 'identifier accepted';
  exception when raise_exception then if sqlerrm='identifier accepted' then raise; end if;
  end;
  begin
    perform public.save_lol_ladder_daily(jsonb_set(rows,'{0,fresh_blood_count}','3'),midnight);
    raise exception 'invalid counts accepted';
  exception when check_violation then null;
  end;
  perform public.save_lol_platform_status('{"items":[]}'::jsonb);
  value := public.get_lol_platform_status();
  if value#>'{payload,items}' <> '[]'::jsonb or (value->>'nextRefreshAt')::timestamptz-(value->>'fetchedAt')::timestamptz <> interval '5 minutes' then
    raise exception 'status cache TTL';
  end if;
  perform public.defer_lol_platform_status();
  if public.get_lol_platform_status()#>'{payload,items}' <> '[]'::jsonb then raise exception 'defer erased cache'; end if;
end $$;
reset role;
