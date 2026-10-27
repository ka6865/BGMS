begin;
set local lock_timeout = '2s';

-- 챔피언 밴 집계. 벤치마크 집계와 같은 경기 제외 기준(사용자 설정·다시하기·5분 미만 등)을 따르고,
-- 한 경기에서 두 팀이 같은 챔피언을 밴해도 1회로 센다. 밴률 분모는 처리된 경기 수다.
create table public.lol_champion_ban_processed_matches (
  match_id text primary key,
  patch text not null,
  queue_id integer not null,
  processed_at timestamptz not null default now(),
  skipped_reason text check (skipped_reason in ('invalid_teams'))
);
create index lol_champion_ban_processed_matches_patch_queue_idx
  on public.lol_champion_ban_processed_matches (patch,queue_id) where skipped_reason is null;
create table public.lol_champion_ban_aggregates (
  patch text not null,
  queue_id integer not null,
  champion_id integer not null check (champion_id > 0),
  bans bigint not null check (bans > 0),
  updated_at timestamptz not null default now(),
  primary key (patch,queue_id,champion_id)
);
alter table public.lol_champion_ban_processed_matches enable row level security;
alter table public.lol_champion_ban_aggregates enable row level security;
revoke all on public.lol_champion_ban_processed_matches, public.lol_champion_ban_aggregates from public, anon, authenticated;
grant select, insert, update, delete on public.lol_champion_ban_processed_matches, public.lol_champion_ban_aggregates to service_role;

-- 벤치마크 처리 기록이 있는 경기만 집계한다. 원문이 없으면 다음 수집에서 다시 시도할 수 있도록 기록을 남기지 않는다.
create or replace function public.aggregate_lol_match_bans(p_match_id text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_patch text; v_queue integer; v_reason text; v_raw jsonb; v_teams jsonb;
begin
  select patch,queue_id,skipped_reason into v_patch,v_queue,v_reason
  from public.lol_benchmark_processed_matches where match_id=p_match_id;
  if not found then raise exception 'LoL ban benchmark record missing' using errcode='22023'; end if;
  if v_reason is not null then return jsonb_build_object('aggregated',false,'skipped',true,'reason',v_reason); end if;
  select skipped_reason into v_reason from public.lol_champion_ban_processed_matches where match_id=p_match_id;
  if found then return jsonb_build_object('aggregated',false,'skipped',v_reason is not null,'reason',v_reason); end if;
  select request_json into v_raw from public.lol_matches where match_id=p_match_id;
  if not found or v_raw is null then raise exception 'LoL ban source missing' using errcode='22023'; end if;
  v_teams := v_raw#>'{info,teams}';
  v_reason := case
    when jsonb_typeof(v_teams) is distinct from 'array' or jsonb_array_length(v_teams)<>2 then 'invalid_teams'
    when exists (select 1 from jsonb_array_elements(v_teams) t
      where jsonb_typeof(t->'bans') is distinct from 'array' or jsonb_array_length(t->'bans')>10) then 'invalid_teams'
    end;
  insert into public.lol_champion_ban_processed_matches(match_id,patch,queue_id,skipped_reason)
  values(p_match_id,v_patch,v_queue,v_reason) on conflict(match_id) do nothing;
  if not found then
    select skipped_reason into v_reason from public.lol_champion_ban_processed_matches where match_id=p_match_id;
    return jsonb_build_object('aggregated',false,'skipped',v_reason is not null,'reason',v_reason);
  end if;
  if v_reason is not null then return jsonb_build_object('aggregated',false,'skipped',true,'reason',v_reason); end if;
  -- championId -1은 밴하지 않은 차례다.
  insert into public.lol_champion_ban_aggregates as target (patch,queue_id,champion_id,bans)
  select v_patch,v_queue,champion::integer,1 from (
    select distinct public.lol_benchmark_number(b->'championId') as champion
    from jsonb_array_elements(v_teams) t cross join lateral jsonb_array_elements(t->'bans') b
  ) bans
  where champion>=1 and champion<=2147483647 and champion=trunc(champion)
  order by champion
  on conflict(patch,queue_id,champion_id) do update set bans=target.bans+1, updated_at=pg_catalog.clock_timestamp();
  return jsonb_build_object('aggregated',true,'skipped',false,'reason',null);
end $$;

create or replace function public.get_lol_champion_ban_summary(p_patch text,p_queue_id integer)
returns table(champion_id integer,bans bigint,matches bigint)
language sql stable security invoker set search_path = '' as $$
  with total as (
    select count(*) as matches from public.lol_champion_ban_processed_matches
    where patch=p_patch and queue_id=p_queue_id and skipped_reason is null
  )
  select a.champion_id,a.bans,total.matches from public.lol_champion_ban_aggregates a cross join total
  where a.patch=p_patch and a.queue_id=p_queue_id order by a.bans desc,a.champion_id;
$$;

-- 모든 저장 경로(검색 저장, 상세 저장, 관리자 수집)는 벤치마크 처리 기록을 새로 만들 때 원문을 갖고 있으므로,
-- 처리 기록 생성 시점에 밴도 함께 집계한다.
create or replace function public.lol_benchmark_processed_ban_trigger()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  perform public.aggregate_lol_match_bans(new.match_id);
  return null;
end $$;
create trigger lol_benchmark_processed_matches_bans
  after insert on public.lol_benchmark_processed_matches
  for each row when (new.skipped_reason is null)
  execute function public.lol_benchmark_processed_ban_trigger();

revoke all on function public.aggregate_lol_match_bans(text),public.get_lol_champion_ban_summary(text,integer),
  public.lol_benchmark_processed_ban_trigger() from public, anon, authenticated;
grant execute on function public.aggregate_lol_match_bans(text),public.get_lol_champion_ban_summary(text,integer),
  public.lol_benchmark_processed_ban_trigger() to service_role;

-- 이미 벤치마크로 처리했고 원문이 남아 있는 경기만 백필할 수 있다.
select public.aggregate_lol_match_bans(p.match_id)
from public.lol_benchmark_processed_matches p join public.lol_matches m using (match_id)
where p.skipped_reason is null and m.request_json is not null order by p.match_id;
commit;
