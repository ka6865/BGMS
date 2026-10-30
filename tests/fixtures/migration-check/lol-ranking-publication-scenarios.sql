\echo 'LoL ranking/mastery publication: 권한, RLS, 입력 거부, 교체, 제외 경로'
do $$
declare role_name text; signature text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    foreach signature in array array['public.save_lol_ranking_publication(jsonb,integer,jsonb,timestamptz)',
      'public.get_lol_ranking_publication()','public.get_lol_mastery_publication()',
      'public.list_lol_ranking_exclusion_keys()','public.add_lol_ranking_exclusion(text)'] loop
      if has_function_privilege(role_name, signature, 'EXECUTE') then raise exception 'public RPC grant: %', signature; end if;
    end loop;
    if has_table_privilege(role_name, 'public.lol_ranking_publication', 'SELECT')
      or has_table_privilege(role_name, 'public.lol_mastery_publication', 'SELECT')
      or has_table_privilege(role_name, 'public.lol_ranking_exclusions', 'SELECT') then raise exception 'public table grant'; end if;
  end loop;
  if exists (select 1 from pg_class where oid in ('public.lol_ranking_publication'::regclass,
    'public.lol_mastery_publication'::regclass, 'public.lol_ranking_exclusions'::regclass) and not relrowsecurity) then
    raise exception 'RLS missing';
  end if;
  if exists (select 1 from pg_proc where proname in ('save_lol_ranking_publication','get_lol_ranking_publication',
    'get_lol_mastery_publication','list_lol_ranking_exclusion_keys','add_lol_ranking_exclusion')
    and (prosecdef or not ('search_path=""' = any(proconfig)))) then
    raise exception 'unsafe RPC';
  end if;
end $$;

set role service_role;
do $$
declare
  board jsonb;
  masters jsonb;
  h1 text := repeat('a', 64);
  h2 text := repeat('b', 64);
  h3 text := repeat('c', 64);
  rows jsonb;
  removed integer;
  total integer;
begin
  rows := jsonb_build_array(
    jsonb_build_object('rank', 1, 'riot_id', 'Alpha#KR1', 'tier', 'CHALLENGER', 'league_points', 1200, 'wins', 10, 'losses', 5, 'riot_id_hmac', h1),
    jsonb_build_object('rank', 2, 'riot_id', 'Beta#KR2', 'tier', 'GRANDMASTER', 'league_points', 900, 'wins', 7, 'losses', 6, 'riot_id_hmac', h2),
    jsonb_build_object('rank', 3, 'riot_id', 'Gamma#KR3', 'tier', 'GRANDMASTER', 'league_points', 800, 'wins', 3, 'losses', 4, 'riot_id_hmac', h3));
  masters := jsonb_build_array(
    jsonb_build_object('champion_id', 266, 'status', 'ok', 'sample_size', 3, 'entries', jsonb_build_array(
      jsonb_build_object('rank', 1, 'riot_id', 'Alpha#KR1', 'champion_points', 500000, 'champion_level', 7, 'riot_id_hmac', h1),
      jsonb_build_object('rank', 2, 'riot_id', 'Beta#KR2', 'champion_points', 300000, 'champion_level', 7, 'riot_id_hmac', h2),
      jsonb_build_object('rank', 3, 'riot_id', 'Gamma#KR3', 'champion_points', 100000, 'champion_level', 6, 'riot_id_hmac', h3))),
    jsonb_build_object('champion_id', 1, 'status', 'insufficient', 'sample_size', 1, 'entries', '[]'::jsonb));

  perform public.save_lol_ranking_publication(rows, 3, masters, now() - interval '1 minute');
  board := public.get_lol_ranking_publication();
  if jsonb_array_length(board->'payload') <> 3 or (board->>'playerCount')::integer <> 3 then raise exception 'save happy path failed'; end if;
  if public.get_lol_ranking_publication()::text ~ 'puuid' then raise exception 'PUUID leaked into publication'; end if;
  if jsonb_array_length(public.get_lol_mastery_publication()->'champions') <> 2 then raise exception 'mastery save failed'; end if;

  -- 교체는 같은 트랜잭션에서 이전 게시본을 지우고 새 행만 남긴다.
  perform public.save_lol_ranking_publication(rows, 3, masters, now());
  if (select count(*) from public.lol_ranking_publication) <> 1 then raise exception 'publication not replaced'; end if;

  begin
    perform public.save_lol_ranking_publication(jsonb_build_array(jsonb_build_object('rank', 1, 'riot_id', 'Alpha#KR1',
      'tier', 'CHALLENGER', 'league_points', 1, 'wins', 1, 'losses', 1, 'riot_id_hmac', h1, 'puuid', 'secret-puuid')), 1, '[]'::jsonb, now());
    raise exception 'expected rejection: puuid in ranking row';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.save_lol_ranking_publication(jsonb_build_array(jsonb_build_object('rank', 1, 'riot_id', 'Alpha#KR1',
      'tier', 'MASTER', 'league_points', 1, 'wins', 1, 'losses', 1, 'riot_id_hmac', h1)), 1, '[]'::jsonb, now());
    raise exception 'expected rejection: non-apex tier';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.save_lol_ranking_publication(jsonb_build_array(
      jsonb_build_object('rank', 1, 'riot_id', 'Alpha#KR1', 'tier', 'CHALLENGER', 'league_points', 1, 'wins', 1, 'losses', 1, 'riot_id_hmac', h1),
      jsonb_build_object('rank', 1, 'riot_id', 'Beta#KR2', 'tier', 'CHALLENGER', 'league_points', 1, 'wins', 1, 'losses', 1, 'riot_id_hmac', h2)),
      2, '[]'::jsonb, now());
    raise exception 'expected rejection: duplicate rank';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.save_lol_ranking_publication(rows, 3, jsonb_build_array(jsonb_build_object('champion_id', 266, 'status', 'ok',
      'sample_size', 1, 'entries', jsonb_build_array(jsonb_build_object('rank', 1, 'riot_id', 'Alpha#KR1', 'champion_points', 1,
      'champion_level', 1, 'riot_id_hmac', h1, 'puuid', 'secret-puuid')))), now());
    raise exception 'expected rejection: puuid in mastery entry';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.save_lol_ranking_publication(rows, 3, masters, now() - interval '3 days');
    raise exception 'expected rejection: stale snapshot';
  exception when sqlstate '55000' then null;
  end;
  begin
    perform public.save_lol_ranking_publication(rows, 3, masters, now() + interval '1 hour');
    raise exception 'expected rejection: future snapshot';
  exception when sqlstate '22023' then null;
  end;

  -- 제외 키는 hex 64자만 받고, 기존 게시본에서 행과 장인 항목을 지운 뒤 순위를 다시 매긴다.
  begin
    perform public.add_lol_ranking_exclusion('not-a-hex-key');
    raise exception 'expected rejection: invalid exclusion key';
  exception when sqlstate '22023' then null;
  end;
  removed := public.add_lol_ranking_exclusion(h2);
  if removed <> 1 then raise exception 'exclusion removed % rows', removed; end if;
  board := public.get_lol_ranking_publication();
  if jsonb_array_length(board->'payload') <> 2 or (board->>'playerCount')::integer <> 2 then raise exception 'exclusion did not shrink publication'; end if;
  if (board->'payload'->1->>'rank')::integer <> 2 or board->'payload'->1->>'riot_id' <> 'Gamma#KR3' then raise exception 'ranks not renumbered'; end if;
  if exists (select 1 from jsonb_array_elements(public.get_lol_mastery_publication()->'champions') c, jsonb_array_elements(c->'entries') e
    where e->>'riot_id_hmac' = h2) then raise exception 'excluded entry remained in mastery board'; end if;
  if (select count(*) from public.lol_mastery_publication where player_count <> 2) > 0 then raise exception 'mastery player_count not updated'; end if;
  if not (public.list_lol_ranking_exclusion_keys() ? h2) then raise exception 'exclusion key not stored'; end if;
  -- 같은 키를 다시 넣어도 목록은 한 번만 남는다.
  total := public.add_lol_ranking_exclusion(h2);
  if total <> 0 then raise exception 'repeated exclusion should not remove rows'; end if;
  if (select count(*) from public.lol_ranking_exclusions where riot_id_hmac = h2) <> 1 then raise exception 'duplicate exclusion key'; end if;
end $$;
reset role;
