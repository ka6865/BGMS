-- 플레이어 단위 데이터 표는 공개 키·일반 사용자가 읽을 수 없고, 쓰지 않는 쓰기 권한은 회수된다.
do $$
declare t text;
begin
  foreach t in array array['pubg_player_matches','pubg_player_cache','processed_match_telemetry','match_stats_raw','global_benchmarks','match_master_telemetry'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT') or has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      raise exception '% still readable by client roles', t;
    end if;
    if not has_table_privilege('service_role', 'public.' || t, 'SELECT') then
      raise exception '% lost service_role read', t;
    end if;
  end loop;

  -- 정책 없는 서버 전용 표는 클라이언트 권한이 없다.
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p') and c.relrowsecurity
      and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
      and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT'))
  ) then
    raise exception 'service-only table still grants client SELECT';
  end if;

  -- 공개 유지: 집계·게임 정보
  if to_regclass('public.hotdrop_heatmap') is not null and not has_table_privilege('anon', 'public.hotdrop_heatmap', 'SELECT') then
    raise exception 'hotdrop_heatmap should stay public';
  end if;
  if to_regclass('public.pubg_team_benchmarks') is not null and not has_table_privilege('anon', 'public.pubg_team_benchmarks', 'SELECT') then
    raise exception 'pubg_team_benchmarks should stay public';
  end if;

  -- anon 쓰기 권한은 어디에도 없다.
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
      and (has_table_privilege('anon', c.oid, 'INSERT') or has_table_privilege('anon', c.oid, 'UPDATE')
        or has_table_privilege('anon', c.oid, 'DELETE') or has_table_privilege('anon', c.oid, 'TRUNCATE'))
  ) then
    raise exception 'anon write grant remains';
  end if;
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p') and has_table_privilege('authenticated', c.oid, 'TRUNCATE')
  ) then
    raise exception 'authenticated truncate grant remains';
  end if;

  -- 정책이 있는 로그인 사용자 쓰기는 남는다.
  if not has_column_privilege('authenticated', 'public.profiles', 'nickname', 'UPDATE') then
    raise exception 'profile self update removed';
  end if;
  -- 로그인 사용자 대상 쓰기 정책이 있는 표·명령은 권한이 남고, 없는 곳은 사라진다.
  if exists (
    select 1
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['INSERT','UPDATE','DELETE']) as p(cmd)
    where n.nspname = 'public' and c.relkind in ('r','p')
      and has_table_privilege('authenticated', c.oid, p.cmd)
      and not exists (
        select 1 from pg_policies pol
        where pol.schemaname = 'public' and pol.tablename = c.relname and pol.cmd in (p.cmd, 'ALL')
          and pol.roles && array['public','authenticated']::name[]
      )
  ) then
    raise exception 'authenticated write grant remains without a policy';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'post_likes' and cmd = 'INSERT')
    and not has_table_privilege('authenticated', 'public.post_likes', 'INSERT') then
    raise exception 'post like insert removed';
  end if;
  -- 정책 없는 로그인 사용자 쓰기는 사라진다.
  if to_regclass('public.analytics_events') is not null and has_table_privilege('authenticated', 'public.analytics_events', 'INSERT') then
    raise exception 'analytics_events insert should be service only';
  end if;
  if has_table_privilege('authenticated', 'public.pubg_player_cache', 'UPDATE') then
    raise exception 'pubg_player_cache update should be service only';
  end if;
end;
$$;

-- 새로 만든 표에는 anon 쓰기 권한이 기본으로 붙지 않는다.
begin;
create table public.grant_hardening_probe(id int);
do $$
begin
  if has_table_privilege('anon', 'public.grant_hardening_probe', 'INSERT') then
    raise exception 'default privileges still grant anon writes';
  end if;
end;
$$;
rollback;
