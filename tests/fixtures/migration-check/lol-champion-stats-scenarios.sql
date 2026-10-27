begin;
set local role service_role;
do $$
declare
  v_payload jsonb; v_row record; v_detail jsonb; v_columns text[]; v_table text;
begin
  v_payload := jsonb_build_object(
    'champions',jsonb_build_array(
      jsonb_build_object('position','TOP','champion',266,'win',true,'kills',5,'deaths',2,'assists',3,'cs',200,'gold',12000,'damage',20000,'duration',1800,'gd15',500),
      jsonb_build_object('position','TOP','champion',86,'win',false,'kills',2,'deaths',5,'assists',1,'cs',180,'gold',9000,'damage',15000,'duration',1800,'gd15',-500)),
    'bans',jsonb_build_array(55,64),
    'builds',jsonb_build_array(
      jsonb_build_object('position','TOP','champion',266,'kind','core_items','value','6692>3071>6333','win',true),
      jsonb_build_object('position','TOP','champion',266,'kind','item','value','6692','win',true),
      jsonb_build_object('position','TOP','champion',266,'kind','item','value','6692','win',true),
      jsonb_build_object('position','TOP','champion',266,'kind','runes','value','8000:8010,9111,9104,8299|8400:8444,8453|5005,5008,5001','win',true),
      jsonb_build_object('position','TOP','champion',266,'kind','skill_order','value','Q>E>W','win',true)),
    'matchups',jsonb_build_array(
      jsonb_build_object('position','TOP','champion',266,'opponent',86,'win',true,'gd15',500),
      jsonb_build_object('position','TOP','champion',86,'opponent',266,'win',false,'gd15',-500)));
  if not public.ingest_lol_stat_match('KR_970001','98.5',420,'EMERALD',true,null,v_payload) then raise exception 'first ingest rejected'; end if;
  -- 같은 경기는 다시 누적하지 않는다.
  if public.ingest_lol_stat_match('KR_970001','98.5',420,'EMERALD',true,null,v_payload) then raise exception 'duplicate accepted'; end if;
  v_payload := jsonb_set(v_payload,'{champions,0,win}','false');
  v_payload := jsonb_set(v_payload,'{champions,0,gd15}','null');
  perform public.ingest_lol_stat_match('KR_970002','98.5',420,'DIAMOND',false,null,v_payload - 'builds');
  perform public.ingest_lol_stat_match('KR_970003',null,420,'GOLD',false,'remake','{}');
  perform public.ingest_lol_stat_match('KR_970004','98.5',420,'IRON',false,null,'{"champions":[],"bans":[],"builds":[],"matchups":[]}');

  if (select array_agg(tier||':'||matches||':'||timeline_matches order by tier) from public.lol_stat_totals where patch='98.5')
    <>array['DIAMOND:1:0','EMERALD:1:1','IRON:1:0'] then raise exception 'totals incorrect'; end if;
  if (select skipped_reason from public.lol_stat_processed_matches where match_id='KR_970003')<>'remake'
    or exists(select 1 from public.lol_stat_totals where tier='GOLD') then raise exception 'skipped match counted'; end if;
  -- 같은 경기 안에서 반복된 빌드 행은 묶어서 센다.
  if (select games from public.lol_stat_builds where patch='98.5' and kind='item' and value='6692')<>2 then raise exception 'build grouping incorrect'; end if;

  select * into strict v_row from public.get_lol_champion_stats('98.5',420,array['EMERALD','DIAMOND']) where champion_id=266;
  if v_row.games<>2 or v_row.wins<>1 or v_row.matches<>2 or v_row.team_position<>'TOP' then raise exception 'stats rpc incorrect: %',v_row; end if;
  select * into strict v_row from public.get_lol_champion_stats('98.5',420,array['EMERALD','DIAMOND']) where champion_id=86;
  if v_row.bans<>0 then raise exception 'unbanned champion has bans'; end if;
  if (select sum(bans) from public.lol_stat_bans where patch='98.5' and champion_id=55)<>2 then raise exception 'bans incorrect'; end if;
  if (select array_agg(patch) from public.get_lol_stat_patches(420))<>array['98.5'] then raise exception 'patch list incorrect'; end if;

  v_detail := public.get_lol_champion_detail('98.5',420,array['EMERALD','DIAMOND'],266);
  if (v_detail->>'matches')::integer<>2 or (v_detail->>'timelineMatches')::integer<>1 or (v_detail->>'bans')::integer<>0
    or v_detail#>>'{positions,0,team_position}'<>'TOP' or (v_detail#>>'{positions,0,games}')::integer<>2
    or (v_detail#>>'{positions,0,gd15_count}')::integer<>1 or (v_detail#>>'{positions,0,gd15_sum}')::integer<>500
    or jsonb_array_length(v_detail->'builds')<>4 or (v_detail#>>'{matchups,0,games}')::integer<>2 then
    raise exception 'detail rpc incorrect: %',v_detail; end if;

  begin
    perform public.ingest_lol_stat_match('KR_970005','98.5',420,'UNRANKED',false,null,'{}');
    raise exception 'invalid tier accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.ingest_lol_stat_match('KR_970006','98.5',420,'GOLD',false,null,
      '{"builds":[{"position":"TOP","champion":1,"kind":"item","value":"drop table","win":true}]}');
    raise exception 'unsafe build value accepted';
  exception when check_violation then null;
  end;
  if exists(select 1 from public.lol_stat_processed_matches where match_id='KR_970006') then raise exception 'failed ingest left processed row'; end if;

  -- 익명 집계에 식별 필드가 추가되지 않도록 컬럼을 고정한다.
  foreach v_table in array array['lol_stat_processed_matches','lol_stat_champions','lol_stat_builds','lol_stat_matchups'] loop
    select array_agg(column_name::text order by ordinal_position) into v_columns from information_schema.columns
      where table_schema='public' and table_name=v_table;
    if exists(select 1 from unnest(v_columns) c where c ~ 'puuid|riot|name|summoner') then raise exception 'identifier column in %',v_table; end if;
  end loop;
end $$;
reset role;
do $$
declare v_role text; v_table text;
begin
  foreach v_role in array array['anon','authenticated'] loop
    foreach v_table in array array['lol_stat_processed_matches','lol_stat_totals','lol_stat_champions','lol_stat_bans','lol_stat_builds',
      'lol_stat_matchups','lol_stat_collector_state'] loop
      if has_table_privilege(v_role,'public.'||v_table,'select,insert,update,delete') then raise exception 'stat table public access %',v_table; end if;
      if not (select relrowsecurity from pg_class where oid=('public.'||v_table)::regclass) then raise exception 'stat RLS missing %',v_table; end if;
    end loop;
    if has_function_privilege(v_role,'public.ingest_lol_stat_match(text,text,integer,text,boolean,text,jsonb)','execute')
      or has_function_privilege(v_role,'public.get_lol_champion_stats(text,integer,text[])','execute')
      or has_function_privilege(v_role,'public.get_lol_champion_detail(text,integer,text[],integer)','execute') then
      raise exception 'stat RPC public access'; end if;
  end loop;
end $$;
rollback;
