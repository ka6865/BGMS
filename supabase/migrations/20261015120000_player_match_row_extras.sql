-- 전적 목록에 이동 거리·최장 킬 거리와 같은 팀원을 표시하기 위한 기본 전적 보조 값.
-- 공식 경기 응답의 참가자 통계와 roster 에서 관측한 값만 저장하고, 관측하지 못하면 NULL 로 둔다.
-- 팀원은 검색한 플레이어 행에 [{name, account_id}] 목록으로 적는다. 팀원 본인의 기록 행은 만들지 않는다.
begin;

alter table public.pubg_player_matches
  add column if not exists teammates jsonb,
  add column if not exists travel_distance integer,
  add column if not exists longest_kill integer;

-- 신규·갱신 행만 검사한다. 기존 행은 모두 NULL 이므로 전체 검증 스캔을 생략한다.
do $migration$
begin
  if not exists (select 1 from pg_constraint where conname = 'pubg_player_matches_row_extras_check'
      and conrelid = 'public.pubg_player_matches'::regclass) then
    alter table public.pubg_player_matches
      add constraint pubg_player_matches_row_extras_check check (
        (teammates is null or case when jsonb_typeof(teammates) = 'array' then jsonb_array_length(teammates) <= 8 else false end)
        and (travel_distance is null or travel_distance >= 0)
        and (longest_kill is null or longest_kill >= 0)
      ) not valid;
  end if;
end;
$migration$;

-- 기존 계약(검증·원자 저장·계정 충돌 시 전체 취소)을 유지하고 보조 값 세 개만 추가한다.
-- 팀원 항목은 이름 1~64자와 PUBG 계정 ID 형식만 허용한다.
-- 보조 값이 없는 입력은 이전과 똑같이 저장되고, 갱신 시 관측되지 않은 값은 기존 값을 지우지 않는다.
create or replace function public.upsert_pubg_participant_matches(p_records jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare expected_count integer; saved_count integer;
begin
  if p_records is null or jsonb_typeof(p_records) is distinct from 'array'
    or jsonb_array_length(p_records) not between 1 and 100
    or octet_length(p_records::text)>131072 then
    raise exception 'participant-match-batch-invalid' using errcode='22023';
  end if;
  expected_count := jsonb_array_length(p_records);
  if exists(select 1 from jsonb_array_elements(p_records) x where jsonb_typeof(x) <> 'object'
    or coalesce(x->>'account_id','') !~ '^account\.[A-Za-z0-9_-]+$'
    or coalesce(x->>'platform','') not in ('steam','kakao')
    or coalesce(x->>'match_id','') !~ '^[A-Za-z0-9_.-]{1,128}$'
    or coalesce(x->>'retention_scope','') not in ('basic_only','detail')
    or length(coalesce(x->>'player_id','')) not between 1 and 64
    or x->>'player_id' is distinct from lower(trim(x->>'player_id'))
    or jsonb_typeof(x->'ranking_eligible') is distinct from 'boolean'
    or coalesce(lower(x->>'game_mode'),'') in ('','unknown','unavailable')
    or coalesce(lower(x->>'map_name'),'') in ('','unknown','unavailable')
    or coalesce(x->>'match_type','') in ('','unavailable')
    or coalesce(x->>'played_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
    or not pg_catalog.pg_input_is_valid(coalesce(x->>'played_at',''),'timestamp with time zone')
    or jsonb_typeof(x->'kills') is distinct from 'number'
    or jsonb_typeof(x->'damage') is distinct from 'number'
    or jsonb_typeof(x->'win_place') is distinct from 'number'
    or (x ? 'teammates' and case jsonb_typeof(x->'teammates')
      when 'null' then false
      when 'array' then jsonb_array_length(x->'teammates') > 8
        or exists(select 1 from jsonb_array_elements(x->'teammates') m where case when jsonb_typeof(m) <> 'object' then true
          else jsonb_typeof(m->'name') is distinct from 'string' or length(m->>'name') not between 1 and 64
            or coalesce(m->>'account_id','') !~ '^account\.[A-Za-z0-9_-]+$'
            or (select count(*) from jsonb_object_keys(m)) <> 2 end)
      else true end)
    or (x ? 'travel_distance' and jsonb_typeof(x->'travel_distance') not in ('number','null'))
    or (x ? 'longest_kill' and jsonb_typeof(x->'longest_kill') not in ('number','null'))) then
    raise exception 'participant-match-batch-invalid' using errcode='22023';
  end if;
  if (select count(distinct (r.platform,r.match_id,r.played_at)) from jsonb_to_recordset(p_records)
      r(platform text,match_id text,played_at timestamptz))<>1
    or (select count(distinct x->>'account_id') from jsonb_array_elements(p_records) x)<>expected_count
    or (select count(distinct x->>'player_id') from jsonb_array_elements(p_records) x)<>expected_count then
    raise exception 'participant-match-batch-invalid' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_records) r(kills numeric,damage numeric,win_place numeric,knocks numeric,survival_time numeric,
      travel_distance numeric,longest_kill numeric)
    where r.kills not between 0 and 2147483647 or r.kills<>trunc(r.kills)
      or r.damage not between 0 and 2147483647 or r.damage<>trunc(r.damage)
      or r.win_place not between 1 and 2147483647 or r.win_place<>trunc(r.win_place)
      or (r.knocks is not null and (r.knocks not between 0 and 2147483647 or r.knocks<>trunc(r.knocks)))
      or (r.survival_time is not null and (r.survival_time not between 0 and 2147483647 or r.survival_time<>trunc(r.survival_time)))
      or (r.travel_distance is not null and (r.travel_distance not between 0 and 2147483647 or r.travel_distance<>trunc(r.travel_distance)))
      or (r.longest_kill is not null and (r.longest_kill not between 0 and 2147483647 or r.longest_kill<>trunc(r.longest_kill)))) then
    raise exception 'participant-match-batch-invalid' using errcode='22023';
  end if;
  insert into public.pubg_player_matches as stored
    (account_id,retention_scope,ranking_eligible,player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,knocks,survival_time,
     teammates,travel_distance,longest_kill)
  select r.account_id,r.retention_scope,r.ranking_eligible,r.player_id,r.platform,r.match_id,r.played_at,r.game_mode,r.map_name,
    r.kills,r.damage,r.win_place,r.match_type,r.knocks,r.survival_time,r.teammates,r.travel_distance,r.longest_kill
  from jsonb_to_recordset(p_records) r(account_id text,retention_scope text,ranking_eligible boolean,player_id text,
    platform text,match_id text,played_at timestamptz,game_mode text,map_name text,kills integer,damage integer,win_place integer,
    match_type text,knocks integer,survival_time integer,teammates jsonb,travel_distance integer,longest_kill integer)
  order by r.player_id
  on conflict(player_id,platform,match_id) do update set
    account_id=excluded.account_id,retention_scope=excluded.retention_scope,ranking_eligible=excluded.ranking_eligible,
    played_at=excluded.played_at,game_mode=excluded.game_mode,map_name=excluded.map_name,
    kills=excluded.kills,damage=excluded.damage,win_place=excluded.win_place,match_type=excluded.match_type,
    knocks=coalesce(excluded.knocks,stored.knocks),survival_time=coalesce(excluded.survival_time,stored.survival_time),
    teammates=coalesce(excluded.teammates,stored.teammates),travel_distance=coalesce(excluded.travel_distance,stored.travel_distance),
    longest_kill=coalesce(excluded.longest_kill,stored.longest_kill)
  where stored.account_id is null or stored.account_id=excluded.account_id;
  get diagnostics saved_count=row_count;
  if saved_count<>expected_count then
    raise exception 'participant-match-account-conflict' using errcode='22023';
  end if;
  return saved_count;
end;
$$;
revoke all on function public.upsert_pubg_participant_matches(jsonb) from public,anon,authenticated;
grant execute on function public.upsert_pubg_participant_matches(jsonb) to service_role;

commit;
