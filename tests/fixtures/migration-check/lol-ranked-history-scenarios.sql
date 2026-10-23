\echo 'LoL ranked history: deduplication, atomic cache, highest tier, ACL and cascade'

set role service_role;
do $$
declare
  v_token uuid;
  v_ranked jsonb := '[]';
  v_step integer;
  v_expected integer;
  v_history jsonb;
  v_account jsonb := '{"puuid":"history-dedup","game_name":"History","tag_line":"KR1","profile_icon_id":1,"summoner_level":30}';
begin
  for v_step in 0..9 loop
    if v_step=1 then
      v_ranked := '[{"queue_type":"RANKED_SOLO_5x5","tier":"GOLD","rank":"IV","league_points":50,"wins":10,"losses":8}]';
    elsif v_step=3 then v_ranked := jsonb_set(v_ranked,'{0,league_points}','51');
    elsif v_step=4 then v_ranked := jsonb_set(v_ranked,'{0,wins}','11');
    elsif v_step=5 then v_ranked := jsonb_set(v_ranked,'{0,losses}','9');
    elsif v_step=6 then v_ranked := jsonb_set(v_ranked,'{0,rank}','"III"');
    elsif v_step=7 then v_ranked := jsonb_set(v_ranked,'{0,tier}','"PLATINUM"');
    end if;
    select lease_token into v_token from public.acquire_lol_collection_lease('history-dedup',90);
    perform public.persist_lol_search_snapshot('history-dedup',v_token,'history-cache','{}','kr','asia','16.21.1',v_account,
      case when v_step=8 then '[]'::jsonb else v_ranked end,'[]');
    v_expected := case when v_step=0 then 0 when v_step<=2 then 1 else least(v_step-1,6) end;
    if (select count(*) from public.lol_ranked_history where puuid='history-dedup')<>v_expected then
      raise exception 'history change detection failed at step %',v_step;
    end if;
    v_history := public.get_lol_ranked_history('history-dedup',30);
    if (select payload->'rankedHistory' from public.lol_api_cache where cache_key='history-cache') is distinct from v_history then
      raise exception 'history is missing from the atomic search cache';
    end if;
    if v_history->'RANKED_FLEX_SR' <> '{"points":[],"highest":null,"trackingSince":null}'::jsonb then
      raise exception 'unranked queue gained history';
    end if;
  end loop;

  -- 경기 저장이 실패하면 같은 검색의 랭크 이력도 함께 롤백한다.
  select lease_token into v_token from public.acquire_lol_collection_lease('history-rollback',90);
  begin
    perform public.persist_lol_search_snapshot('history-rollback',v_token,'history-cache','{}','kr','asia','16.21.1',v_account,
      jsonb_set(v_ranked,'{0,league_points}','99'),'[{"summary":{"matchId":"KR_991"},"raw":{}}]');
    raise exception 'invalid match was accepted';
  exception when sqlstate '22023' then null;
  end;
  if (select count(*) from public.lol_ranked_history where puuid='history-dedup')<>6 then
    raise exception 'ranked history did not roll back with the failed snapshot';
  end if;
  perform public.release_lol_collection_lease('history-rollback',v_token);

  insert into public.lol_accounts(puuid,game_name,tag_line,platform_id,regional_route)
  values ('history-highest','Highest','KR1','kr','asia');
  for v_step in 1..10 loop
    insert into public.lol_ranked_history(puuid,queue_type,tier,rank,league_points,wins,losses,recorded_at)
    values ('history-highest','RANKED_SOLO_5x5',
      (array['IRON','BRONZE','SILVER','GOLD','PLATINUM','EMERALD','DIAMOND','MASTER','GRANDMASTER','CHALLENGER'])[v_step],
      'IV',1,1,0,'2026-01-01'::timestamptz+v_step*interval '1 day');
    v_history := public.get_lol_ranked_history('history-highest',30);
    if v_history#>>'{RANKED_SOLO_5x5,highest,tier}' <>
      (array['IRON','BRONZE','SILVER','GOLD','PLATINUM','EMERALD','DIAMOND','MASTER','GRANDMASTER','CHALLENGER'])[v_step] then
      raise exception 'tier precedence failed at %',v_step;
    end if;
  end loop;
  insert into public.lol_ranked_history(puuid,queue_type,tier,rank,league_points,wins,losses,recorded_at)
  values ('history-highest','RANKED_SOLO_5x5','GRANDMASTER','I',9999,1,0,'2026-01-12'),
    ('history-highest','RANKED_SOLO_5x5','CHALLENGER','III',0,1,0,'2026-01-13'),
    ('history-highest','RANKED_SOLO_5x5','CHALLENGER','II',0,1,0,'2026-01-14'),
    ('history-highest','RANKED_SOLO_5x5','CHALLENGER','I',1,1,0,'2026-01-15'),
    ('history-highest','RANKED_SOLO_5x5','CHALLENGER','I',7,1,0,'2026-01-16'),
    ('history-highest','RANKED_FLEX_SR','SILVER','II',12,1,0,'2026-01-17');
  insert into public.lol_ranked_history(puuid,queue_type,tier,rank,league_points,wins,losses,recorded_at)
  select 'history-highest','RANKED_SOLO_5x5','IRON','IV',n,1,0,'2026-02-01'::timestamptz+n*interval '1 day'
  from generate_series(1,35) n;
  v_history := public.get_lol_ranked_history('history-highest',999);
  if jsonb_array_length(v_history#>'{RANKED_SOLO_5x5,points}')<>1
    or v_history#>>'{RANKED_SOLO_5x5,points,0,lp}'<>'35'
    or v_history#>>'{RANKED_SOLO_5x5,points,0,isBaseline}'<>'true'
    or v_history#>>'{RANKED_SOLO_5x5,highest,tier}'<>'CHALLENGER'
    or v_history#>>'{RANKED_SOLO_5x5,highest,rank}'<>'I'
    or v_history#>>'{RANKED_SOLO_5x5,highest,lp}'<>'7'
    or (v_history#>>'{RANKED_SOLO_5x5,trackingSince}')::timestamptz<>'2026-01-02'::timestamptz
    or v_history#>>'{RANKED_FLEX_SR,highest,tier}'<>'SILVER' then
    raise exception 'bounded recent history / all-time highest / trackingSince / queue isolation failed';
  end if;
  if jsonb_array_length(public.get_lol_ranked_history('history-highest',2)#>'{RANKED_SOLO_5x5,points}')<>1 then
    raise exception 'history limit is ignored';
  end if;
  update public.lol_accounts set last_accessed_at=now()-interval '91 days' where puuid='history-highest';
  perform public.cleanup_lol_expired_data();
  if not exists(select 1 from public.lol_ranked_history where puuid='history-highest') then
    raise exception 'automatic cleanup removed permanent history'; end if;
  delete from public.lol_accounts where puuid='history-highest';
  delete from public.lol_accounts where puuid='history-dedup';
  if exists(select 1 from public.lol_ranked_history where puuid in ('history-highest','history-dedup')) then
    raise exception 'account cleanup did not cascade to ranked history';
  end if;
end $$;
reset role;

do $$
declare v_role text; v_privilege text;
begin
  if not (select relrowsecurity from pg_class where oid='public.lol_ranked_history'::regclass) then
    raise exception 'ranked history RLS is disabled';
  end if;
  foreach v_role in array array['anon','authenticated'] loop
    foreach v_privilege in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if has_table_privilege(v_role,'public.lol_ranked_history',v_privilege) then
        raise exception '% has % access to ranked history',v_role,v_privilege;
      end if;
    end loop;
    if has_function_privilege(v_role,'public.get_lol_ranked_history(text,integer)','EXECUTE')
      or has_sequence_privilege(v_role,'public.lol_ranked_history_id_seq','USAGE') then
      raise exception '% has history RPC or sequence access',v_role;
    end if;
  end loop;
end $$;
set role anon;
do $$ begin
  begin
    perform public.get_lol_ranked_history('history-highest',30);
    raise exception 'anon executed ranked history RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.lol_ranked_history;
    raise exception 'anon read ranked history';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
\echo 'LoL ranked history scenarios passed'
