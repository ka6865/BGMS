\echo 'LoL daily history: KST boundary, last record per day and pre-window baseline'
set role service_role;
do $$
declare
  v_start timestamptz := (((current_timestamp at time zone 'Asia/Seoul')::date-29)::timestamp at time zone 'Asia/Seoul');
  v_history jsonb;
begin
  insert into public.lol_accounts(puuid,game_name,tag_line,platform_id,regional_route)
    values ('daily-kst','Daily','KR1','kr','asia');
  insert into public.lol_ranked_history(puuid,queue_type,tier,rank,league_points,wins,losses,recorded_at)
  values
    ('daily-kst','RANKED_SOLO_5x5','GOLD','I',80,1,0,v_start-interval '2 days'),
    ('daily-kst','RANKED_SOLO_5x5','GOLD','I',90,2,0,v_start-interval '1 microsecond'),
    ('daily-kst','RANKED_SOLO_5x5','PLATINUM','IV',0,3,0,v_start),
    ('daily-kst','RANKED_SOLO_5x5','PLATINUM','IV',10,4,0,v_start+interval '23 hours 59 minutes'),
    ('daily-kst','RANKED_SOLO_5x5','PLATINUM','IV',20,5,0,v_start+interval '1 day'),
    ('daily-kst','RANKED_SOLO_5x5','PLATINUM','IV',30,6,0,v_start+interval '1 day'),
    ('daily-kst','RANKED_SOLO_5x5','PLATINUM','IV',99,7,0,v_start+interval '30 days'),
    ('daily-kst','RANKED_FLEX_SR','SILVER','I',5,1,0,v_start);
  v_history := public.get_lol_ranked_history('daily-kst',30);
  if jsonb_array_length(v_history#>'{RANKED_SOLO_5x5,points}')<>3
    or v_history#>>'{RANKED_SOLO_5x5,points,0,lp}'<>'90'
    or v_history#>>'{RANKED_SOLO_5x5,points,0,isBaseline}'<>'true'
    or v_history#>>'{RANKED_SOLO_5x5,points,1,lp}'<>'10'
    or v_history#>>'{RANKED_SOLO_5x5,points,1,wins}'<>'4'
    or v_history#>>'{RANKED_SOLO_5x5,points,1,isBaseline}'<>'false'
    or (v_history#>>'{RANKED_SOLO_5x5,points,1,date}')::date<>(current_timestamp at time zone 'Asia/Seoul')::date-29
    or v_history#>>'{RANKED_SOLO_5x5,points,2,lp}'<>'30'
    or jsonb_array_length(v_history#>'{RANKED_FLEX_SR,points}')<>1 then
    raise exception 'daily history lost the KST boundary, last-record tie-break or baseline: %',v_history;
  end if;
  delete from public.lol_accounts where puuid='daily-kst';
end $$;
reset role;
