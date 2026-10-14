-- 20261014220000 의 예약 집계가 108개 등록과 집계를 한 트랜잭션에서 해, 집계가 길어지면(디스크 읽기 20초 이상)
-- 커밋되지 않은 등록 행 때문에 같은 조합을 등록하려는 요청이 잠금을 기다리다 503 이 났다. 등록과 집계를 다른 실행으로 나눈다.
-- 10초마다 한 조합만 집계한다(조합마다 짧은 트랜잭션). 순서: 등록 행, 확정이 필요한 잠정 행,
-- 지난 2주 안에 조회됐지만 이번 주 결과가 없는 조합. 먼저 실제로 조회된 버전마다 108개 조합을 등록한다.
create or replace function public.refresh_pubg_rankings_cache()
returns integer language plpgsql volatile security invoker set search_path='' set plan_cache_mode='force_custom_plan' as $$
declare
  target record; private_keys text[]; params jsonb; modes text[]; next_key text; w record; current_row record; seeded integer;
begin
  if not pg_try_advisory_xact_lock(20261014150000) then return 0; end if;
  select * into w from public.pubg_ranking_week();
  private_keys:=public.pubg_ranking_private_keys();
  insert into public.pubg_response_cache(cache_key,payload,expires_at,updated_at)
  select public.pubg_ranking_cache_key(t.tab,m.modes,mt.match_type,v.calculation,v.filter,v.population,v.result,private_keys,w.week_start),
    -- 미리 채운 행은 실제 조회가 아니므로 조회 시각을 남기지 않는다.
    jsonb_build_object('entries','[]'::jsonb,'requested_at','-infinity'::timestamptz,
      'params',jsonb_build_object('tab',t.tab,'modes',m.modes,'match_type',mt.match_type,'calculation',v.calculation,
        'filter',v.filter,'population',v.population,'result',v.result)),
    clock_timestamp()-interval '1 second','-infinity'
  from (select distinct (c.payload->'params'->>'calculation')::integer as calculation,(c.payload->'params'->>'filter')::integer as filter,
      (c.payload->'params'->>'population')::integer as population,(c.payload->'params'->>'result')::integer as result
    from public.pubg_response_cache c
    where c.cache_key like 'rankings:v2:%' and c.payload ? 'params'
      and (c.payload->>'requested_at')::timestamptz>clock_timestamp()-interval '14 days') v
  cross join (values ('damage'),('kills'),('tier')) t(tab)
  cross join public.pubg_ranking_mode_sets() m(modes)
  cross join (values ('all'),('official'),('competitive')) mt(match_type)
  on conflict (cache_key) do nothing;
  -- 등록한 행은 이번 실행에서 바로 커밋한다. 같은 트랜잭션에서 오래 집계하면 그동안 같은 조합을 등록하려는 요청이 잠금을 기다리다 8초 제한에 걸린다.
  get diagnostics seeded = row_count;
  if seeded > 0 then return 0; end if;
  for target in
    select c.cache_key,c.payload->'params' as params,(c.payload->>'requested_at')::timestamptz as requested_at
    from public.pubg_response_cache c
    where c.cache_key like 'rankings:v2:%' and c.payload ? 'params'
      and (c.updated_at='-infinity'::timestamptz
        or c.payload->>'week_start'=to_jsonb(w.week_start)#>>'{}'
        or (c.payload->>'requested_at')::timestamptz>clock_timestamp()-interval '14 days')
    order by c.updated_at
  loop
    params:=target.params;
    select array_agg(m order by m) into modes from jsonb_array_elements_text(params->'modes') m;
    next_key:=public.pubg_ranking_cache_key(params->>'tab',modes,params->>'match_type',(params->>'calculation')::integer,
      (params->>'filter')::integer,(params->>'population')::integer,(params->>'result')::integer,private_keys,w.week_start);
    select c.updated_at,c.expires_at,(c.payload->>'finalized')::boolean as finalized into current_row
    from public.pubg_response_cache c where c.cache_key=next_key;
    if found and current_row.updated_at>'-infinity'::timestamptz and current_row.expires_at>clock_timestamp()
      and (coalesce(current_row.finalized,false) or clock_timestamp()<w.finalize_at) then continue; end if;
    if not pg_try_advisory_xact_lock(hashtextextended(next_key,0)) then continue; end if;
    if public.pubg_ranking_build(params->>'tab',modes,params->>'match_type',(params->>'calculation')::integer,
      (params->>'filter')::integer,(params->>'population')::integer,(params->>'result')::integer,
      private_keys,target.requested_at) is null then continue; end if;
    if public.pubg_ranking_private_keys() is distinct from private_keys then raise exception 'Ranking privacy changed during refresh'; end if;
    return 1;
  end loop;
  return 0;
end $$;

revoke all on function public.refresh_pubg_rankings_cache() from public,anon,authenticated;
grant execute on function public.refresh_pubg_rankings_cache() to service_role;
