\echo 'LoL ranking/master publication and season accumulation: 권한, RLS, 입력 거부, 커밋 잠금, 제외, 정리'
do $$
declare role_name text; signature text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    foreach signature in array array['public.save_lol_ranking_publication(jsonb,integer,timestamptz)',
      'public.save_lol_master_publication(text,integer,integer,jsonb,timestamptz)',
      'public.get_lol_ranking_publication()','public.get_lol_master_publication()',
      'public.list_lol_ranking_exclusion_keys()','public.add_lol_ranking_exclusion(text,text)',
      'public.upsert_lol_season_account(text,text,text,text,text,integer,timestamptz,timestamptz,timestamptz)',
      'public.get_lol_season_account_states(text,text[])','public.commit_lol_season_progress(text,text,bigint,bigint,text[],jsonb,timestamptz)',
      'public.list_lol_season_champion_counts(text,text[])','public.purge_lol_expired_season_accounts(timestamptz)'] loop
      if has_function_privilege(role_name, signature, 'EXECUTE') then raise exception 'public RPC grant: %', signature; end if;
    end loop;
    if has_table_privilege(role_name, 'public.lol_ranking_publication', 'SELECT')
      or has_table_privilege(role_name, 'public.lol_master_publication', 'SELECT')
      or has_table_privilege(role_name, 'public.lol_ranking_exclusions', 'SELECT')
      or has_table_privilege(role_name, 'public.lol_ranking_season_accounts', 'SELECT')
      or has_table_privilege(role_name, 'public.lol_ranking_season_champions', 'SELECT') then raise exception 'public table grant'; end if;
  end loop;
  if exists (select 1 from pg_class where oid in ('public.lol_ranking_publication'::regclass, 'public.lol_master_publication'::regclass,
    'public.lol_ranking_exclusions'::regclass, 'public.lol_ranking_season_accounts'::regclass,
    'public.lol_ranking_season_champions'::regclass) and not relrowsecurity) then raise exception 'RLS missing'; end if;
  if exists (select 1 from pg_proc where proname in ('save_lol_ranking_publication','save_lol_master_publication','get_lol_ranking_publication',
    'get_lol_master_publication','list_lol_ranking_exclusion_keys','add_lol_ranking_exclusion','upsert_lol_season_account',
    'get_lol_season_account_states','commit_lol_season_progress','list_lol_season_champion_counts','purge_lol_expired_season_accounts')
    and (prosecdef or not ('search_path=""' = any(proconfig)))) then raise exception 'unsafe RPC'; end if;
end $$;

set role service_role;
do $$
declare
  h1 text := repeat('a', 64);
  h2 text := repeat('b', 64);
  h3 text := repeat('c', 64);
  a1 text := repeat('1', 64);
  a2 text := repeat('2', 64);
  a3 text := repeat('3', 64);
  rows_ jsonb;
  champs jsonb;
  board jsonb;
  master jsonb;
  states jsonb;
  removed integer;
  n integer;
  stale_seen boolean;
begin
  rows_ := jsonb_build_array(
    jsonb_build_object('rank', 1, 'riot_id', 'Alpha#KR1', 'tier', 'CHALLENGER', 'league_points', 1200, 'wins', 10, 'losses', 5),
    jsonb_build_object('rank', 2, 'riot_id', 'Beta#KR2', 'tier', 'GRANDMASTER', 'league_points', 900, 'wins', 7, 'losses', 6),
    jsonb_build_object('rank', 3, 'riot_id', 'Gamma#KR3', 'tier', 'GRANDMASTER', 'league_points', 800, 'wins', 3, 'losses', 4));
  perform public.save_lol_ranking_publication(rows_, 3, now() - interval '2 minutes');
  board := public.get_lol_ranking_publication();
  if jsonb_array_length(board->'payload') <> 3 or (board->>'playerCount')::integer <> 3 then raise exception 'ranking save failed'; end if;
  if board::text ~ 'riot_id_hmac|puuid' then raise exception 'key leaked into ranking publication'; end if;

  begin
    perform public.save_lol_ranking_publication(jsonb_build_array(jsonb_build_object('rank', 1, 'riot_id', 'Alpha#KR1',
      'tier', 'CHALLENGER', 'league_points', 1, 'wins', 1, 'losses', 1, 'riot_id_hmac', h1)), 1, now());
    raise exception 'expected rejection: key in ranking row';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.save_lol_ranking_publication(rows_, 3, now() - interval '3 days');
    raise exception 'expected rejection: stale ranking';
  exception when sqlstate '55000' then null;
  end;

  -- 장인(D안): 판수 15 이상, 승률 50% 이상만 게시 행에 들어간다.
  champs := jsonb_build_array(jsonb_build_object('champion_id', 266, 'eligible_count', 2, 'rows', jsonb_build_array(
    jsonb_build_object('rank', 1, 'riot_id', 'Alpha#KR1', 'tier', 'CHALLENGER', 'league_points', 1200, 'games', 40, 'wins', 25),
    jsonb_build_object('rank', 2, 'riot_id', 'Beta#KR2', 'tier', 'GRANDMASTER', 'league_points', 900, 'games', 15, 'wins', 8))));
  perform public.save_lol_master_publication('2026-01-08', 50, 3, champs, now() - interval '1 minute');
  master := public.get_lol_master_publication();
  if (master->>'season') <> '2026-01-08' or (master->>'coverage')::integer <> 50 then raise exception 'master save failed'; end if;
  if master::text ~ 'riot_id_hmac|puuid|account_hmac' then raise exception 'key leaked into master publication'; end if;

  begin
    perform public.save_lol_master_publication('2026-01-08', 50, 3, jsonb_build_array(jsonb_build_object('champion_id', 266,
      'eligible_count', 1, 'rows', jsonb_build_array(jsonb_build_object('rank', 1, 'riot_id', 'Alpha#KR1', 'tier', 'CHALLENGER',
      'league_points', 1, 'games', 14, 'wins', 9)))), now());
    raise exception 'expected rejection: 14 games';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.save_lol_master_publication('2026-01-08', 50, 3, jsonb_build_array(jsonb_build_object('champion_id', 266,
      'eligible_count', 1, 'rows', jsonb_build_array(jsonb_build_object('rank', 1, 'riot_id', 'Alpha#KR1', 'tier', 'CHALLENGER',
      'league_points', 1, 'games', 20, 'wins', 9)))), now());
    raise exception 'expected rejection: win rate below 50';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.save_lol_master_publication('2026-01-08', 50, 3, jsonb_build_array(jsonb_build_object('champion_id', 266,
      'eligible_count', 1, 'rows', jsonb_build_array(jsonb_build_object('rank', 1, 'riot_id', 'Alpha#KR1', 'tier', 'CHALLENGER',
      'league_points', 1, 'games', 20, 'wins', 12, 'riot_id_hmac', h1)))), now());
    raise exception 'expected rejection: key in master row';
  exception when sqlstate '22023' then null;
  end;

  -- 시즌 계정 행과 판수 커밋. 제외된 Riot ID는 행을 만들지 못한다.
  perform public.upsert_lol_season_account('2026-01-08', a1, h1, 'Alpha#KR1', 'CHALLENGER', 1200, now(), now(), now() + interval '60 days');
  perform public.upsert_lol_season_account('2026-01-08', a2, h2, 'Beta#KR2', 'GRANDMASTER', 900, now(), now(), now() + interval '60 days');
  perform public.upsert_lol_season_account('2026-01-08', a3, h3, 'Gamma#KR3', 'GRANDMASTER', 800, now(), now(), now() + interval '60 days');

  perform public.commit_lol_season_progress('2026-01-08', a1, null, 1000, array['m1','m2'],
    jsonb_build_array(jsonb_build_object('champion_id', 266, 'games', 2, 'wins', 1)), now());
  states := public.get_lol_season_account_states('2026-01-08', array[a1]);
  if (states->0->>'cursorMs')::bigint <> 1000 then raise exception 'cursor not saved'; end if;

  -- 같은 커서로 다시 커밋하면 잠금 검사가 거절하고 판수는 늘지 않는다(이중 집계 방지).
  begin
    perform public.commit_lol_season_progress('2026-01-08', a1, null, 1000, array['m1','m2'],
      jsonb_build_array(jsonb_build_object('champion_id', 266, 'games', 2, 'wins', 1)), now());
    raise exception 'expected rejection: stale cursor';
  exception when sqlstate '40001' then stale_seen := true;
  end;
  select games into n from public.lol_ranking_season_champions where season_key = '2026-01-08' and account_hmac = a1 and champion_id = 266;
  if n <> 2 then raise exception 'double count after stale commit: %', n; end if;

  -- 다음 커밋은 읽은 커서(1000)를 기대값으로 넘기고 판수를 더한다.
  perform public.commit_lol_season_progress('2026-01-08', a1, 1000, 2000, array['m3'],
    jsonb_build_array(jsonb_build_object('champion_id', 266, 'games', 1, 'wins', 1)), now());
  select games, wins into n, removed from public.lol_ranking_season_champions where season_key = '2026-01-08' and account_hmac = a1 and champion_id = 266;
  if n <> 3 or removed <> 2 then raise exception 'progress delta wrong: games=% wins=%', n, removed; end if;

  -- 다른 시즌은 같은 계정이라도 섞이지 않는다.
  perform public.upsert_lol_season_account('2026-02-01', a1, h1, 'Alpha#KR1', 'CHALLENGER', 1200, now(), now(), now() + interval '60 days');
  select count(*) into n from public.lol_ranking_season_champions where season_key = '2026-02-01';
  if n <> 0 then raise exception 'season isolation broken'; end if;

  -- 삭제 요청: 제외 키 저장, 게시본과 장인 행에서 빼고 순위를 다시 매긴다, 시즌 계정 행을 지운다.
  perform public.upsert_lol_season_account('2026-01-08', a2, h2, 'Beta#KR2', 'GRANDMASTER', 900, now(), now(), now() + interval '60 days');
  begin
    perform public.add_lol_ranking_exclusion('not-hex', 'Beta#KR2');
    raise exception 'expected rejection: invalid exclusion key';
  exception when sqlstate '22023' then null;
  end;
  removed := public.add_lol_ranking_exclusion(h2, 'beta#kr2');
  if removed <> 1 then raise exception 'exclusion removed % ranking rows', removed; end if;
  board := public.get_lol_ranking_publication();
  if jsonb_array_length(board->'payload') <> 2 or (board->'payload'->1->>'rank')::integer <> 2
    or board->'payload'->1->>'riot_id' <> 'Gamma#KR3' then raise exception 'ranks not renumbered'; end if;
  master := public.get_lol_master_publication();
  if (master->'champions'->0->>'eligibleCount')::integer <> 1 then raise exception 'master eligible count not reduced'; end if;
  if jsonb_array_length(master->'champions'->0->'rows') <> 1 then raise exception 'excluded master row remained'; end if;
  if exists (select 1 from public.lol_ranking_season_accounts where riot_id_hmac = h2) then raise exception 'season row not deleted'; end if;
  begin
    perform public.upsert_lol_season_account('2026-01-08', a2, h2, 'Beta#KR2', 'GRANDMASTER', 900, now(), now(), now() + interval '60 days');
    raise exception 'expected rejection: excluded account re-added';
  exception when sqlstate '23514' then null;
  end;
  if not (public.list_lol_ranking_exclusion_keys() ? h2) then raise exception 'exclusion key not stored'; end if;

  -- 시즌 종료 후 30일이 지난 행만 정리하고, 종료 시각이 없는 행과 아직 30일이 안 된 행은 남긴다.
  update public.lol_ranking_season_accounts set season_end = now() - interval '31 days' where account_hmac = a3;
  update public.lol_ranking_season_accounts set season_end = now() - interval '10 days' where account_hmac = a1;
  n := public.purge_lol_expired_season_accounts(now());
  if n <> 1 then raise exception 'purge removed % rows', n; end if;
  if exists (select 1 from public.lol_ranking_season_accounts where account_hmac = a3) then raise exception 'expired season row remained'; end if;
  if not exists (select 1 from public.lol_ranking_season_accounts where account_hmac = a1) then raise exception 'unexpired season row removed'; end if;
end $$;
reset role;
