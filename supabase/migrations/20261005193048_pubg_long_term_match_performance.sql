-- 상세 자료와 독립된 성과 요약은 기본 전적과 함께 유지한다.
alter table public.pubg_match_performance
  add column if not exists summary jsonb,
  add column if not exists played_at timestamptz,
  add column if not exists summary_version integer,
  add column if not exists source_checksum text,
  alter column score drop not null,
  alter column tier drop not null,
  alter column benchmark drop not null;
alter table public.pubg_match_performance add constraint pubg_performance_summary_bound
  check (summary is null or (jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 32768));
alter table public.pubg_match_performance add constraint pubg_performance_summary_identity
  check (summary is null or (
    played_at is not null and summary_version is not null and summary_version = 1
    and source_checksum is not null and source_checksum ~ '^[a-f0-9]{64}$'
    and summary->>'matchId' is not null and summary->>'matchId' = match_id
    and summary->'stats'->>'playerId' is not null and summary->'stats'->>'playerId' = account_id));

create or replace function public.finish_pubg_performance_job(p_token uuid,p_state text,p_result jsonb default null,p_error text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare j public.pubg_performance_jobs; compact jsonb;
begin
  if p_state not in ('done','retry','excluded','unavailable') then raise exception 'invalid state'; end if;
  select * into j from public.pubg_performance_jobs
  where lease_token=p_token and state='running' and lease_expires_at>now() for update;
  if not found then return false; end if;
  compact := p_result->'retainedPerformance';
  if compact is not null then
    if p_state not in ('done','excluded') or jsonb_typeof(compact)<>'object'
      or (compact->>'platform') is distinct from j.platform
      or (compact->>'account_id') is distinct from j.account_id
      or (compact->>'match_id') is distinct from j.match_id
      or (compact->>'player_id') is distinct from j.player_id
      or (compact->>'calculation_version')::integer is distinct from j.calculation_version
      or (compact->>'result_version')::integer is distinct from j.result_version
      or (compact->>'summary_version')::integer is distinct from 1
      or jsonb_typeof(compact->'summary') is distinct from 'object'
      or (compact->>'source_checksum') !~ '^[a-f0-9]{64}$'
    then raise exception 'compact identity invalid'; end if;
    insert into public.pubg_match_performance(platform,account_id,match_id,player_id,calculation_version,result_version,
      score,tier,benchmark,ranking_eligible,summary,played_at,summary_version,source_checksum)
    values(j.platform,j.account_id,j.match_id,j.player_id,j.calculation_version,j.result_version,
      (compact->>'score')::double precision,compact->>'tier',nullif(compact->'benchmark','null'::jsonb),
      p_state='done' and coalesce((compact->>'ranking_eligible')::boolean,false),compact->'summary',
      (compact->>'played_at')::timestamptz,1,compact->>'source_checksum')
    on conflict(platform,account_id,match_id,calculation_version,result_version) do update set
      score=excluded.score,tier=excluded.tier,benchmark=excluded.benchmark,ranking_eligible=excluded.ranking_eligible,
      summary=excluded.summary,played_at=excluded.played_at,summary_version=excluded.summary_version,
      source_checksum=excluded.source_checksum,calculated_at=now();
  elsif p_state='done' then
    -- 배포 중 기존 worker의 결과도 계속 받되 삭제 근거로는 사용하지 않는다.
    if p_result is null or jsonb_typeof(p_result->'benchmark') is distinct from 'object' then raise exception 'result required'; end if;
    insert into public.pubg_match_performance(platform,account_id,match_id,player_id,calculation_version,result_version,score,tier,benchmark,ranking_eligible)
    values(j.platform,j.account_id,j.match_id,j.player_id,j.calculation_version,j.result_version,
      (p_result->'benchmark'->>'score')::double precision,p_result->'benchmark'->>'tier',p_result->'benchmark',
      coalesce((p_result->>'rankingEligible')::boolean,false))
    on conflict(platform,account_id,match_id,calculation_version,result_version) do update set
      score=excluded.score,tier=excluded.tier,benchmark=excluded.benchmark,ranking_eligible=excluded.ranking_eligible,calculated_at=now();
  end if;
  update public.pubg_performance_jobs set state=case when p_state='retry' and attempts>=3 then 'unavailable' else p_state end,
    next_attempt_at=now()+interval '1 hour',last_error=left(p_error,200),lease_token=null,lease_expires_at=null,updated_at=now()
    where lease_token=p_token;
  return true;
end $$;

create or replace function public.cleanup_pubg_performance_retention(p_keep_days integer default 90)
returns table(performance_rows bigint,job_rows bigint,budget_rows bigint)
language plpgsql security invoker set search_path='' as $$
declare cutoff timestamptz; day_cutoff date;
begin
  if p_keep_days is null or p_keep_days < 1 or p_keep_days > 3650 then raise exception 'invalid retention days'; end if;
  cutoff := now() - make_interval(days => p_keep_days);
  day_cutoff := ((now() at time zone 'UTC')::date - p_keep_days);
  -- 성과와 기본 전적은 보존한다. 실행 기록과 사용량 카운터만 정리한다.
  performance_rows := 0;
  delete from public.pubg_performance_jobs where ctid in (select ctid from public.pubg_performance_jobs
    where updated_at < cutoff and state in ('done','excluded','unavailable') order by updated_at limit 500);
  get diagnostics job_rows = row_count;
  delete from public.pubg_performance_budget where day < day_cutoff;
  get diagnostics budget_rows = row_count;
  return next;
end $$;
revoke all on function public.finish_pubg_performance_job(uuid,text,jsonb,text) from public,anon,authenticated;
revoke all on function public.cleanup_pubg_performance_retention(integer) from public,anon,authenticated;
grant execute on function public.finish_pubg_performance_job(uuid,text,jsonb,text) to service_role;
grant execute on function public.cleanup_pubg_performance_retention(integer) to service_role;

-- 저장을 마친 행을 서버에서 제외해 수만 건의 원본을 매번 내려받지 않는다.
create or replace function public.list_unretained_match_performance(p_limit integer default 100,p_player_id text default null)
returns setof public.processed_match_telemetry
language sql stable security invoker set search_path='' as $$
  select s.* from public.processed_match_telemetry s
  where (p_player_id is null or s.player_id=lower(trim(p_player_id)))
    and s.platform in ('steam','kakao')
    and s.data->'fullResult'->'stats'->>'playerId' ~ '^account\.[A-Za-z0-9_-]+$'
    and s.data->'fullResult'->>'v' ~ '^[0-9]+$'
    and coalesce(s.data->'fullResult'->>'calculationVersion','0') ~ '^[0-9]+$'
    and lower(trim(s.data->'fullResult'->'stats'->>'name'))=s.player_id
    and not exists (select 1 from public.pubg_match_performance p where p.platform=s.platform
      and p.player_id=s.player_id and p.match_id=s.match_id
      and p.account_id=s.data->'fullResult'->'stats'->>'playerId'
      and p.result_version=(s.data->'fullResult'->>'v')::integer
      and p.calculation_version=coalesce(s.data->'fullResult'->>'calculationVersion','0')::integer
      and p.summary_version=1 and p.summary is not null)
  order by s.updated_at,s.platform,s.player_id,s.match_id
  limit greatest(0,least(coalesce(p_limit,100),1000));
$$;
revoke all on function public.list_unretained_match_performance(integer,text) from public,anon,authenticated;
grant execute on function public.list_unretained_match_performance(integer,text) to service_role;
