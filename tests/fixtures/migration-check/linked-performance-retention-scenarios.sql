begin;

insert into public.profiles(id,pubg_nickname,pubg_platform,last_active_at) values
('00000000-0000-0000-0000-000000009301',' LR-A ',' STEAM ',null),
('00000000-0000-0000-0000-000000009302','lr-a','steam',now()-interval '1 year'),
('00000000-0000-0000-0000-000000009303','lr-b','kakao',null);

insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,account_id)
values
('lr-a','steam','lr-old',now()-interval '30 days','squad','Baltic_Main','account.lra'),
('lr-a','steam','lr-recent',now()-interval '13 days','squad','Baltic_Main','account.lra'),
('lr-a','steam','lr-boundary',now()-interval '14 days','squad','Baltic_Main','account.lra'),
('lr-a','steam','lr-wrong-account',now()-interval '30 days','squad','Baltic_Main','account.other'),
('lr-a','steam','lr-bad-version',now()-interval '30 days','squad','Baltic_Main','account.lra'),
('lr-a','steam','lr-saved-summary',now()-interval '30 days','squad','Baltic_Main','account.lra'),
('lr-a','kakao','lr-other-platform',now()-interval '30 days','squad','Baltic_Main','account.lra'),
('lr-b','kakao','lr-kakao',now()-interval '30 days','squad','Baltic_Main','account.lrb'),
('lr-unlinked','steam','lr-unlinked',now()-interval '30 days','squad','Baltic_Main','account.lrunlinked');

insert into public.processed_match_telemetry(match_id,platform,player_id,data)
select m.match_id,m.platform,m.player_id,jsonb_build_object('fullResult',jsonb_build_object(
  'matchId',m.match_id,'platform',m.platform,'player_id',m.player_id,
  'v',case when m.match_id='lr-bad-version' then '99999999999999999999999999999999' else '73' end,
  'calculationVersion',2,'stats',jsonb_build_object('playerId','account.'||replace(m.player_id,'-',''),'name',m.player_id)))
from public.pubg_player_matches m where m.match_id like 'lr-%';

insert into public.pubg_match_performance(platform,account_id,match_id,player_id,calculation_version,result_version,
  summary,summary_version,played_at,source_checksum,ranking_eligible)
values('steam','account.lra','lr-saved-summary','lr-a',2,73,
  '{"matchId":"lr-saved-summary","stats":{"playerId":"account.lra"}}',1,now()-interval '30 days',repeat('a',64),false);

do $$ declare n integer; before_cursor jsonb; after_cursor jsonb; begin
  if has_function_privilege('anon','public.list_linked_unretained_match_performance(text,text,integer)','execute')
    or has_function_privilege('authenticated','public.list_linked_unretained_match_performance(text,text,integer)','execute')
    or not has_function_privilege('service_role','public.list_linked_unretained_match_performance(text,text,integer)','execute') then
    raise exception 'linked listing must be service-only';
  end if;
  select to_jsonb(c) into before_cursor from public.pubg_archive_cleanup_cursor c where id=1;
  select count(*) into n from public.list_linked_unretained_match_performance(' STEAM ',' LR-A ',100);
  if n<>1 then raise exception 'expected exactly one expired linked source, got %',n; end if;
  if not exists(select from public.list_linked_unretained_match_performance('steam','lr-a',100) where match_id='lr-old') then
    raise exception 'inactive normalized linked identity was excluded';
  end if;
  select count(*) into n from public.list_linked_unretained_match_performance('kakao','lr-b',100);
  if n<>1 then raise exception 'linked kakao source missing'; end if;
  select count(*) into n from public.list_linked_unretained_match_performance('kakao','lr-a',100);
  if n<>0 then raise exception 'unlinked platform source selected'; end if;
  select count(*) into n from public.list_linked_unretained_match_performance('steam','lr-unlinked',100);
  if n<>0 then raise exception 'unlinked source selected'; end if;
  select to_jsonb(c) into after_cursor from public.pubg_archive_cleanup_cursor c where id=1;
  if before_cursor is distinct from after_cursor then raise exception 'cleanup cursor changed'; end if;
  begin
    perform public.list_linked_unretained_match_performance('xbox','lr-a',100);
    raise exception 'invalid platform accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.list_linked_unretained_match_performance('steam','lr-a',0);
    raise exception 'invalid limit accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;

insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,account_id)
select 'lr-a','steam','lr-cap-'||i,now()-interval '30 days','squad','Baltic_Main','account.lra'
from generate_series(1,101) g(i);
insert into public.processed_match_telemetry(match_id,platform,player_id,data)
select 'lr-cap-'||i,'steam','lr-a',jsonb_build_object('fullResult',jsonb_build_object(
  'v',73,'calculationVersion',2,'stats',jsonb_build_object('playerId','account.lra','name','lr-a')))
from generate_series(1,101) g(i);
do $$ declare n integer; begin
  select count(*) into n from public.list_linked_unretained_match_performance('steam','lr-a',1000);
  if n<>100 then raise exception 'identity limit must be 100, got %',n; end if;
  delete from public.profiles where id in ('00000000-0000-0000-0000-000000009301','00000000-0000-0000-0000-000000009302');
  select count(*) into n from public.list_linked_unretained_match_performance('steam','lr-a',100);
  if n<>0 then raise exception 'unlinked profile was not rechecked'; end if;
  raise notice 'PASS: linked performance scope, age, identity, ACL, cap and cursor';
end $$;
rollback;
