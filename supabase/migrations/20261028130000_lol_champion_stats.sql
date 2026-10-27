begin;
set local lock_timeout = '2s';

-- 챔피언 통계 수집기 전용 익명 집계. 경기 원문·참가자·PUUID·Riot ID를 저장하지 않고,
-- 수집기가 경기마다 계산한 기여분을 한 트랜잭션에서 누적한다. 티어는 수집 출발 계정의 티어다.
create or replace function public.lol_stat_tiers()
returns text[] language sql immutable security invoker set search_path = '' as $$
  select array['IRON','BRONZE','SILVER','GOLD','PLATINUM','EMERALD','DIAMOND','MASTER','GRANDMASTER','CHALLENGER']::text[];
$$;

create table public.lol_stat_processed_matches (
  match_id text primary key check (match_id ~ '^[A-Z0-9]+_[0-9]{1,20}$'),
  patch text check (patch is null or patch ~ '^[0-9]{1,3}\.[0-9]{1,3}$'),
  queue_id integer not null check (queue_id >= 0),
  tier text not null check (tier = any(public.lol_stat_tiers())),
  has_timeline boolean not null default false,
  skipped_reason text check (skipped_reason in ('custom','remake','short','queue','invalid')),
  processed_at timestamptz not null default now(),
  check ((skipped_reason is null) = (patch is not null))
);
create table public.lol_stat_totals (
  patch text not null, queue_id integer not null, tier text not null check (tier = any(public.lol_stat_tiers())),
  matches bigint not null check (matches > 0),
  timeline_matches bigint not null default 0 check (timeline_matches between 0 and matches),
  updated_at timestamptz not null default now(),
  primary key (patch,queue_id,tier)
);
create table public.lol_stat_champions (
  patch text not null, queue_id integer not null, tier text not null check (tier = any(public.lol_stat_tiers())),
  team_position text not null check (team_position in ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY')),
  champion_id integer not null check (champion_id > 0),
  games bigint not null check (games > 0),
  wins bigint not null check (wins between 0 and games),
  kills bigint not null default 0, deaths bigint not null default 0, assists bigint not null default 0,
  cs bigint not null default 0, gold bigint not null default 0, damage bigint not null default 0,
  duration_seconds bigint not null default 0,
  -- 15분 라인 상대 대비 골드 차이. timeline을 받은 경기만 센다.
  gd15_sum bigint not null default 0, gd15_count bigint not null default 0 check (gd15_count between 0 and games),
  updated_at timestamptz not null default now(),
  primary key (patch,queue_id,tier,team_position,champion_id)
);
create table public.lol_stat_bans (
  patch text not null, queue_id integer not null, tier text not null check (tier = any(public.lol_stat_tiers())),
  champion_id integer not null check (champion_id > 0),
  bans bigint not null check (bans > 0),
  updated_at timestamptz not null default now(),
  primary key (patch,queue_id,tier,champion_id)
);
create table public.lol_stat_builds (
  patch text not null, queue_id integer not null, tier text not null check (tier = any(public.lol_stat_tiers())),
  team_position text not null check (team_position in ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY')),
  champion_id integer not null check (champion_id > 0),
  kind text not null check (kind in ('keystone','runes','spells','item','boots','start_items','core_items','skill_order')),
  value text not null check (value ~ '^[0-9A-Z:,|>+]{1,128}$'),
  games bigint not null check (games > 0),
  wins bigint not null check (wins between 0 and games),
  updated_at timestamptz not null default now(),
  primary key (patch,queue_id,tier,team_position,champion_id,kind,value)
);
create table public.lol_stat_matchups (
  patch text not null, queue_id integer not null, tier text not null check (tier = any(public.lol_stat_tiers())),
  team_position text not null check (team_position in ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY')),
  champion_id integer not null check (champion_id > 0),
  opponent_id integer not null check (opponent_id > 0),
  games bigint not null check (games > 0),
  wins bigint not null check (wins between 0 and games),
  gd15_sum bigint not null default 0, gd15_count bigint not null default 0 check (gd15_count between 0 and games),
  updated_at timestamptz not null default now(),
  primary key (patch,queue_id,tier,team_position,champion_id,opponent_id)
);
-- 수집기 진행 위치(티어 구간별 페이지·순번). 계정 식별자는 넣지 않는다.
create table public.lol_stat_collector_state (
  singleton boolean primary key default true check (singleton),
  cursor jsonb not null default '{}'::jsonb check (jsonb_typeof(cursor)='object' and octet_length(cursor::text) <= 16384),
  updated_at timestamptz not null default now()
);

do $$
declare v_table text;
begin
  foreach v_table in array array['lol_stat_processed_matches','lol_stat_totals','lol_stat_champions','lol_stat_bans',
    'lol_stat_builds','lol_stat_matchups','lol_stat_collector_state'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on public.%I from public, anon, authenticated', v_table);
    execute format('grant select, insert, update, delete on public.%I to service_role', v_table);
  end loop;
end $$;

-- 한 경기의 기여분을 누적한다. 같은 경기는 한 번만 센다.
create or replace function public.ingest_lol_stat_match(
  p_match_id text, p_patch text, p_queue_id integer, p_tier text, p_has_timeline boolean, p_skipped_reason text, p_payload jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_payload jsonb := coalesce(p_payload,'{}'::jsonb);
begin
  if p_match_id is null or p_match_id !~ '^[A-Z0-9]+_[0-9]{1,20}$' or p_queue_id is null or p_queue_id < 0
    or p_tier is null or not (p_tier = any(public.lol_stat_tiers())) or p_has_timeline is null
    or (p_skipped_reason is null and (p_patch is null or p_patch !~ '^[0-9]{1,3}\.[0-9]{1,3}$'))
    or jsonb_typeof(v_payload) <> 'object' or octet_length(v_payload::text) > 65536
    or jsonb_typeof(coalesce(v_payload->'champions','[]')) <> 'array' or jsonb_array_length(coalesce(v_payload->'champions','[]')) > 10
    or jsonb_typeof(coalesce(v_payload->'bans','[]')) <> 'array' or jsonb_array_length(coalesce(v_payload->'bans','[]')) > 20
    or jsonb_typeof(coalesce(v_payload->'builds','[]')) <> 'array' or jsonb_array_length(coalesce(v_payload->'builds','[]')) > 200
    or jsonb_typeof(coalesce(v_payload->'matchups','[]')) <> 'array' or jsonb_array_length(coalesce(v_payload->'matchups','[]')) > 10 then
    raise exception 'invalid LoL stat match' using errcode='22023';
  end if;
  insert into public.lol_stat_processed_matches(match_id,patch,queue_id,tier,has_timeline,skipped_reason)
  values(p_match_id,case when p_skipped_reason is null then p_patch end,p_queue_id,p_tier,p_has_timeline and p_skipped_reason is null,p_skipped_reason)
  on conflict(match_id) do nothing;
  if not found then return false; end if;
  if p_skipped_reason is not null then return true; end if;

  insert into public.lol_stat_totals as t (patch,queue_id,tier,matches,timeline_matches)
  values(p_patch,p_queue_id,p_tier,1,case when p_has_timeline then 1 else 0 end)
  on conflict(patch,queue_id,tier) do update set matches=t.matches+1,timeline_matches=t.timeline_matches+excluded.timeline_matches,
    updated_at=pg_catalog.clock_timestamp();

  insert into public.lol_stat_champions as t (patch,queue_id,tier,team_position,champion_id,games,wins,kills,deaths,assists,cs,gold,damage,
    duration_seconds,gd15_sum,gd15_count)
  select p_patch,p_queue_id,p_tier,r.position,r.champion,count(*),count(*) filter (where r.win),coalesce(sum(r.kills),0),
    coalesce(sum(r.deaths),0),coalesce(sum(r.assists),0),coalesce(sum(r.cs),0),coalesce(sum(r.gold),0),coalesce(sum(r.damage),0),
    coalesce(sum(r.duration),0),coalesce(sum(r.gd15),0),count(r.gd15)
  from jsonb_to_recordset(coalesce(v_payload->'champions','[]')) as r(position text,champion integer,win boolean,kills integer,deaths integer,
    assists integer,cs integer,gold integer,damage integer,duration integer,gd15 integer)
  group by r.position,r.champion order by r.position,r.champion
  on conflict(patch,queue_id,tier,team_position,champion_id) do update set games=t.games+excluded.games,wins=t.wins+excluded.wins,
    kills=t.kills+excluded.kills,deaths=t.deaths+excluded.deaths,assists=t.assists+excluded.assists,cs=t.cs+excluded.cs,
    gold=t.gold+excluded.gold,damage=t.damage+excluded.damage,duration_seconds=t.duration_seconds+excluded.duration_seconds,
    gd15_sum=t.gd15_sum+excluded.gd15_sum,gd15_count=t.gd15_count+excluded.gd15_count,updated_at=pg_catalog.clock_timestamp();

  insert into public.lol_stat_bans as t (patch,queue_id,tier,champion_id,bans)
  select distinct p_patch,p_queue_id,p_tier,b.value::integer,1::bigint
  from jsonb_array_elements_text(coalesce(v_payload->'bans','[]')) b
  order by 4
  on conflict(patch,queue_id,tier,champion_id) do update set bans=t.bans+1,updated_at=pg_catalog.clock_timestamp();

  insert into public.lol_stat_builds as t (patch,queue_id,tier,team_position,champion_id,kind,value,games,wins)
  select p_patch,p_queue_id,p_tier,r.position,r.champion,r.kind,r.value,count(*),count(*) filter (where r.win)
  from jsonb_to_recordset(coalesce(v_payload->'builds','[]')) as r(position text,champion integer,kind text,value text,win boolean)
  group by r.position,r.champion,r.kind,r.value order by r.position,r.champion,r.kind,r.value
  on conflict(patch,queue_id,tier,team_position,champion_id,kind,value) do update set games=t.games+excluded.games,
    wins=t.wins+excluded.wins,updated_at=pg_catalog.clock_timestamp();

  insert into public.lol_stat_matchups as t (patch,queue_id,tier,team_position,champion_id,opponent_id,games,wins,gd15_sum,gd15_count)
  select p_patch,p_queue_id,p_tier,r.position,r.champion,r.opponent,count(*),count(*) filter (where r.win),coalesce(sum(r.gd15),0),count(r.gd15)
  from jsonb_to_recordset(coalesce(v_payload->'matchups','[]')) as r(position text,champion integer,opponent integer,win boolean,gd15 integer)
  group by r.position,r.champion,r.opponent order by r.position,r.champion,r.opponent
  on conflict(patch,queue_id,tier,team_position,champion_id,opponent_id) do update set games=t.games+excluded.games,
    wins=t.wins+excluded.wins,gd15_sum=t.gd15_sum+excluded.gd15_sum,gd15_count=t.gd15_count+excluded.gd15_count,
    updated_at=pg_catalog.clock_timestamp();
  return true;
end $$;

create or replace function public.get_lol_stat_patches(p_queue_id integer)
returns table(patch text,matches bigint,timeline_matches bigint)
language sql stable security invoker set search_path = '' as $$
  select t.patch,sum(t.matches)::bigint,sum(t.timeline_matches)::bigint from public.lol_stat_totals t
  where t.queue_id=p_queue_id group by t.patch
  order by pg_catalog.string_to_array(t.patch,'.')::integer[] desc limit 20;
$$;

create or replace function public.get_lol_champion_stats(p_patch text,p_queue_id integer,p_tiers text[])
returns table(team_position text,champion_id integer,games bigint,wins bigint,bans bigint,matches bigint)
language sql stable security invoker set search_path = '' as $$
  with total as (
    select coalesce(sum(t.matches),0)::bigint as matches from public.lol_stat_totals t
    where t.patch=p_patch and t.queue_id=p_queue_id and t.tier=any(p_tiers)
  ), bans as (
    select b.champion_id,sum(b.bans)::bigint as bans from public.lol_stat_bans b
    where b.patch=p_patch and b.queue_id=p_queue_id and b.tier=any(p_tiers) group by b.champion_id
  )
  select c.team_position,c.champion_id,sum(c.games)::bigint,sum(c.wins)::bigint,coalesce(max(bans.bans),0)::bigint,max(total.matches)
  from public.lol_stat_champions c cross join total left join bans on bans.champion_id=c.champion_id
  where c.patch=p_patch and c.queue_id=p_queue_id and c.tier=any(p_tiers)
  group by c.team_position,c.champion_id order by c.team_position,sum(c.games) desc;
$$;

create or replace function public.get_lol_champion_detail(p_patch text,p_queue_id integer,p_tiers text[],p_champion_id integer)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with total as (
    select coalesce(sum(t.matches),0)::bigint as matches,coalesce(sum(t.timeline_matches),0)::bigint as timeline_matches
    from public.lol_stat_totals t where t.patch=p_patch and t.queue_id=p_queue_id and t.tier=any(p_tiers)
  ), positions as (
    select c.team_position,sum(c.games)::bigint games,sum(c.wins)::bigint wins,sum(c.kills)::bigint kills,sum(c.deaths)::bigint deaths,
      sum(c.assists)::bigint assists,sum(c.cs)::bigint cs,sum(c.gold)::bigint gold,sum(c.damage)::bigint damage,
      sum(c.duration_seconds)::bigint duration_seconds,sum(c.gd15_sum)::bigint gd15_sum,sum(c.gd15_count)::bigint gd15_count
    from public.lol_stat_champions c
    where c.patch=p_patch and c.queue_id=p_queue_id and c.tier=any(p_tiers) and c.champion_id=p_champion_id group by c.team_position
  ), builds as (
    select * from (
      select b.team_position,b.kind,b.value,sum(b.games)::bigint games,sum(b.wins)::bigint wins,
        row_number() over (partition by b.team_position,b.kind order by sum(b.games) desc,b.value) rank
      from public.lol_stat_builds b
      where b.patch=p_patch and b.queue_id=p_queue_id and b.tier=any(p_tiers) and b.champion_id=p_champion_id
      group by b.team_position,b.kind,b.value
    ) ranked where rank<=8
  ), matchups as (
    select m.team_position,m.opponent_id,sum(m.games)::bigint games,sum(m.wins)::bigint wins,
      sum(m.gd15_sum)::bigint gd15_sum,sum(m.gd15_count)::bigint gd15_count
    from public.lol_stat_matchups m
    where m.patch=p_patch and m.queue_id=p_queue_id and m.tier=any(p_tiers) and m.champion_id=p_champion_id
    group by m.team_position,m.opponent_id
  )
  select pg_catalog.jsonb_build_object(
    'matches',(select matches from total),'timelineMatches',(select timeline_matches from total),
    'bans',(select coalesce(sum(b.bans),0) from public.lol_stat_bans b
      where b.patch=p_patch and b.queue_id=p_queue_id and b.tier=any(p_tiers) and b.champion_id=p_champion_id),
    'positions',coalesce((select jsonb_agg(to_jsonb(p) order by p.games desc) from positions p),'[]'::jsonb),
    'builds',coalesce((select jsonb_agg(jsonb_build_object('position',b.team_position,'kind',b.kind,'value',b.value,'games',b.games,'wins',b.wins)
      order by b.team_position,b.kind,b.rank) from builds b),'[]'::jsonb),
    'matchups',coalesce((select jsonb_agg(jsonb_build_object('position',m.team_position,'opponent',m.opponent_id,'games',m.games,'wins',m.wins,
      'gd15Sum',m.gd15_sum,'gd15Count',m.gd15_count) order by m.team_position,m.games desc) from matchups m),'[]'::jsonb)
  );
$$;

revoke all on function public.lol_stat_tiers(),
  public.ingest_lol_stat_match(text,text,integer,text,boolean,text,jsonb),
  public.get_lol_stat_patches(integer),
  public.get_lol_champion_stats(text,integer,text[]),
  public.get_lol_champion_detail(text,integer,text[],integer) from public, anon, authenticated;
grant execute on function public.lol_stat_tiers(),
  public.ingest_lol_stat_match(text,text,integer,text,boolean,text,jsonb),
  public.get_lol_stat_patches(integer),
  public.get_lol_champion_stats(text,integer,text[]),
  public.get_lol_champion_detail(text,integer,text[],integer) to service_role;
commit;
