begin;
set local lock_timeout = '2s';

-- 전적 첫 화면을 20경기로 늘리면서 2분짜리 검색 캐시 한 건의 상한만 1MB로 올린다. 경기 상세 캐시 상한(256KB)은 유지한다.
alter table public.lol_api_cache drop constraint lol_api_cache_payload_check;
alter table public.lol_api_cache add constraint lol_api_cache_payload_check
  check (octet_length(payload::text) <= case when kind = 'search' then 1048576 else 262144 end);

create or replace function public.persist_lol_search_snapshot(
  p_lease_key text, p_token uuid, p_cache_key text, p_cache_payload jsonb,
  p_platform text, p_route text, p_version text, p_account jsonb, p_ranked jsonb, p_matches jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz; v_lease_until timestamptz; v_match jsonb; v_raw jsonb; v_info jsonb; v_participant jsonb;
  v_puuid text; v_match_id text; v_queue integer; v_played timestamptz; v_started timestamptz; v_data_version integer;
begin
  if p_platform not in ('kr','jp1','na1','br1','la1','la2','eun1','euw1','me1','tr1','ru','oc1','sg2','tw2','vn2')
    or p_route not in ('americas','asia','europe','sea') or length(p_version) > 32
    or jsonb_typeof(p_account) <> 'object' or jsonb_typeof(p_ranked) <> 'array' or jsonb_typeof(p_matches) <> 'array'
    or octet_length(p_cache_payload::text) > 1048576 or p_lease_key is null or p_token is null then
    raise exception 'invalid LoL snapshot' using errcode = '22023';
  end if;
  select lease_until into v_lease_until from public.lol_collection_leases where lease_key=p_lease_key and lease_type='collection'
    and lease_token=p_token for update;
  v_now := pg_catalog.clock_timestamp();
  if not found or v_lease_until <= v_now then
    raise exception 'stale LoL collection lease' using errcode = '40001';
  end if;
  v_puuid := p_account->>'puuid';
  if v_puuid is null or length(v_puuid) not between 1 and 128 then raise exception 'invalid PUUID' using errcode='22023'; end if;
  insert into public.lol_accounts (puuid,game_name,tag_line,platform_id,regional_route,profile_icon_id,summoner_level,account_fetched_at,profile_fetched_at,ranked_checked_at,last_accessed_at)
  values (v_puuid,p_account->>'game_name',p_account->>'tag_line',p_platform,p_route,nullif(p_account->>'profile_icon_id','')::integer,
    nullif(p_account->>'summoner_level','')::bigint,v_now,v_now,v_now,v_now)
  on conflict (puuid) do update set game_name=excluded.game_name,tag_line=excluded.tag_line,platform_id=excluded.platform_id,
    regional_route=excluded.regional_route,profile_icon_id=excluded.profile_icon_id,summoner_level=excluded.summoner_level,
    account_fetched_at=v_now,profile_fetched_at=v_now,ranked_checked_at=v_now,last_accessed_at=v_now;
  perform public.upsert_lol_player_match_summaries(null,v_puuid);
  delete from public.lol_ranked_entries where puuid=v_puuid and platform_id=p_platform;
  insert into public.lol_ranked_entries (puuid,platform_id,queue_type,tier,rank,league_points,wins,losses,fetched_at)
  select v_puuid,p_platform,r.queue_type,r.tier,r.rank,r.league_points,r.wins,r.losses,v_now
  from jsonb_to_recordset(p_ranked) as r(queue_type text,tier text,rank text,league_points integer,wins integer,losses integer);

  -- 계정 upsert의 행 잠금으로 같은 계정의 동시 이력 비교와 저장을 직렬화한다.
  insert into public.lol_ranked_history (puuid,queue_type,tier,rank,league_points,wins,losses,recorded_at)
  select current.puuid,current.queue_type,current.tier,current.rank,current.league_points,current.wins,current.losses,
    pg_catalog.clock_timestamp()
  from public.lol_ranked_entries current
  left join lateral (
    select history.tier,history.rank,history.league_points,history.wins,history.losses,history.id
    from public.lol_ranked_history history
    where history.puuid=current.puuid and history.queue_type=current.queue_type
    order by history.recorded_at desc,history.id desc limit 1
  ) previous on true
  where current.puuid=v_puuid and current.platform_id=p_platform
    and (previous.id is null or (current.tier,current.rank,current.league_points,current.wins,current.losses)
      is distinct from (previous.tier,previous.rank,previous.league_points,previous.wins,previous.losses));

  for v_match in select value from jsonb_array_elements(p_matches) loop
    v_raw := v_match->'raw'; v_info := v_raw->'info'; v_match_id := v_match->'summary'->>'matchId';
    if v_raw->'metadata'->>'matchId' is distinct from v_match_id or v_match_id is null or jsonb_typeof(v_info->'participants') is distinct from 'array' then
      raise exception 'invalid Riot match payload' using errcode='22023'; end if;
    v_queue := coalesce((v_info->>'queueId')::integer,0);
    v_data_version := coalesce(nullif(v_raw->'metadata'->>'dataVersion','')::integer,1);
    v_started := pg_catalog.to_timestamp((coalesce((v_info->>'gameStartTimestamp')::numeric,(v_info->>'gameCreation')::numeric,
      (v_info->>'gameEndTimestamp')::numeric - coalesce((v_info->>'gameDuration')::numeric,0)*1000) / 1000)::double precision);
    v_played := pg_catalog.to_timestamp((coalesce((v_info->>'gameEndTimestamp')::numeric,(v_info->>'gameStartTimestamp')::numeric,
      (v_info->>'gameCreation')::numeric) / 1000)::double precision);
    if v_info->>'gameStartTimestamp' is null and v_info->>'gameCreation' is null and v_info->>'gameEndTimestamp' is null then
      raise exception 'Riot match timestamp missing' using errcode='22023'; end if;
    insert into public.lol_matches (match_id,platform_id,regional_route,queue_id,map_id,game_version,started_at,duration_seconds,teams,data_version,summary_version,request_json,fetched_at,expires_at)
    values (v_match_id,p_platform,p_route,v_queue,nullif(v_info->>'mapId','')::integer,coalesce(v_info->>'gameVersion','Unknown'),
      v_started,coalesce((v_info->>'gameDuration')::integer,0),coalesce(v_info->'teams','[]'::jsonb),v_data_version,1,v_raw,v_now,v_now+interval '7 days')
    on conflict (match_id) do update set queue_id=excluded.queue_id,map_id=excluded.map_id,game_version=excluded.game_version,
      started_at=excluded.started_at,duration_seconds=excluded.duration_seconds,teams=excluded.teams,data_version=excluded.data_version,
      request_json=case when public.lol_matches.expires_at<=v_now then excluded.request_json else public.lol_matches.request_json end,
      fetched_at=case when public.lol_matches.expires_at<=v_now then excluded.fetched_at else public.lol_matches.fetched_at end,
      expires_at=case when public.lol_matches.expires_at<=v_now then excluded.expires_at else public.lol_matches.expires_at end
      where public.lol_matches.platform_id=excluded.platform_id and public.lol_matches.regional_route=excluded.regional_route;
    if not found then raise exception 'Riot match route conflict' using errcode='23505'; end if;
    perform public.aggregate_lol_match_benchmarks(v_match_id);
    for v_participant in select value from jsonb_array_elements(v_info->'participants') loop
      insert into public.lol_match_participants (match_id,participant_id,puuid,team_id,champion_id,team_position,win,kills,deaths,assists,cs,
        neutral_minions_killed,gold_earned,damage_to_champions,vision_score,wards_placed,wards_killed,damage_to_objectives,items,perks,played_at,queue_id)
      values (v_match_id,(v_participant->>'participantId')::smallint,nullif(v_participant->>'puuid',''),coalesce((v_participant->>'teamId')::smallint,0),
        coalesce((v_participant->>'championId')::integer,0),nullif(v_participant->>'teamPosition',''),coalesce((v_participant->>'win')::boolean,false),
        nullif(v_participant->>'kills','')::integer,nullif(v_participant->>'deaths','')::integer,nullif(v_participant->>'assists','')::integer,
        nullif(v_participant->>'totalMinionsKilled','')::integer,nullif(v_participant->>'neutralMinionsKilled','')::integer,
        nullif(v_participant->>'goldEarned','')::integer,nullif(v_participant->>'totalDamageDealtToChampions','')::integer,
        nullif(v_participant->>'visionScore','')::integer,nullif(v_participant->>'wardsPlaced','')::integer,nullif(v_participant->>'wardsKilled','')::integer,
        nullif(v_participant->>'damageDealtToObjectives','')::integer,
        array[(v_participant->>'item0')::integer,(v_participant->>'item1')::integer,(v_participant->>'item2')::integer,(v_participant->>'item3')::integer,
          (v_participant->>'item4')::integer,(v_participant->>'item5')::integer,(v_participant->>'item6')::integer],
        nullif(v_participant->'perks','null'::jsonb),v_played,v_queue)
      on conflict (match_id,participant_id) do update set puuid=excluded.puuid,team_id=excluded.team_id,champion_id=excluded.champion_id,
        team_position=excluded.team_position,win=excluded.win,kills=excluded.kills,deaths=excluded.deaths,assists=excluded.assists,cs=excluded.cs,
        neutral_minions_killed=excluded.neutral_minions_killed,gold_earned=excluded.gold_earned,damage_to_champions=excluded.damage_to_champions,
        vision_score=excluded.vision_score,wards_placed=excluded.wards_placed,wards_killed=excluded.wards_killed,
        damage_to_objectives=excluded.damage_to_objectives,items=excluded.items,perks=excluded.perks,played_at=excluded.played_at,queue_id=excluded.queue_id;
    end loop;
    perform public.upsert_lol_player_match_summaries(v_match_id,null);
  end loop;
  insert into public.lol_api_cache (cache_key,kind,platform_id,regional_route,data_version,payload,fetched_at,expires_at)
  values (p_cache_key,'search',p_platform,p_route,p_version,
    jsonb_set(p_cache_payload,'{rankedHistory}',public.get_lol_ranked_history(v_puuid,30)),v_now,v_now+interval '2 minutes')
  on conflict (cache_key) do update set kind=excluded.kind,platform_id=excluded.platform_id,regional_route=excluded.regional_route,
    data_version=excluded.data_version,payload=excluded.payload,fetched_at=v_now,expires_at=excluded.expires_at;
  delete from public.lol_collection_leases where lease_key=p_lease_key and lease_token=p_token;
  return true;
end $$;

revoke all on function public.persist_lol_search_snapshot(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.persist_lol_search_snapshot(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb) to service_role;

commit;
