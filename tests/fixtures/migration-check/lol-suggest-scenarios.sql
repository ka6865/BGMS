begin;
set local role service_role;
insert into public.lol_accounts(puuid,game_name,tag_line,platform_id,regional_route) values
  ('suggest-a','Suggest Fixture','KR1','kr','asia'),('suggest-b','Suggest Fixture','KR2','kr','asia'),
  ('suggest-c','Suggest Fixture','NA1','na1','americas'),('suggest-d','Sugg%_literal','KR1','kr','asia'),
  ('suggest-e','SuggZZliteral','KR1','kr','asia');
do $$ begin
  if (select count(*) from public.suggest_lol_accounts('suggest fix'))<>2
    or (select count(*) from public.suggest_lol_accounts('Suggest Fixture#kr1'))<>1
    or (select count(*) from public.suggest_lol_accounts('Sugg%_'))<>1
    or exists(select 1 from public.suggest_lol_accounts('s'))
    or exists(select 1 from public.suggest_lol_accounts('aa#bb#cc'))
    or exists(select 1 from public.suggest_lol_accounts(E'Suggest\n')) then
    raise exception 'suggestion prefix/tag/literal/routing validation failed'; end if;
end $$;
insert into public.lol_accounts(puuid,game_name,tag_line,platform_id,regional_route)
select 'suggest-limit-'||i,'Suggest Limit '||i,'KR1','kr','asia' from generate_series(1,20) i;
do $$ begin
  if (select count(*) from public.suggest_lol_accounts('Suggest Limit'))<>8 then raise exception 'suggestion limit failed'; end if;
end $$;
reset role;
do $$ declare v_role text; begin
  foreach v_role in array array['anon','authenticated'] loop
    if has_function_privilege(v_role,'public.suggest_lol_accounts(text)','EXECUTE') then raise exception 'suggestion RPC exposed'; end if;
  end loop;
end $$;
rollback;
