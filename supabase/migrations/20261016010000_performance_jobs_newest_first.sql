-- 성과 계산 작업을 최근에 플레이한 경기부터 처리하고 하루 상한을 300으로 올린다.
-- 기존에는 예약 시각 순으로 하루 최대 100건(워커 기본 30건)만 처리해, 쌓이는 양을 따라가지 못하고
-- 7일이 지난 작업이 버려졌다. 동시 1건 처리, 예산 차감, lease 계약은 그대로 둔다.
begin;

create or replace function public.claim_pubg_performance_job(p_daily_limit integer default 30)
returns setof public.pubg_performance_jobs
language plpgsql
set search_path to ''
as $function$
declare j public.pubg_performance_jobs; v_day date := (now() at time zone 'UTC')::date; v_used integer;
begin
  perform pg_advisory_xact_lock(73130900);
  if exists(select 1 from public.pubg_performance_jobs where state='running' and lease_expires_at>now()) then return; end if;
  insert into public.pubg_performance_budget(day) values(v_day) on conflict do nothing;
  select used into v_used from public.pubg_performance_budget where day=v_day for update;
  if v_used >= greatest(0,least(coalesce(p_daily_limit,30),300)) then return; end if;
  -- 최근 경기부터 처리해 사용자가 보고 있는 경기의 점수가 먼저 채워지게 한다.
  select candidate.* into j from public.pubg_performance_jobs candidate
    left join lateral (
      select max(m.played_at) as played_at from public.pubg_player_matches m
      where m.platform=candidate.platform and m.account_id=candidate.account_id and m.match_id=candidate.match_id
    ) played on true
    where ((candidate.state in ('pending','retry') and candidate.next_attempt_at<=now())
      or (candidate.state='running' and candidate.lease_expires_at<=now()))
    order by played.played_at desc nulls last, candidate.next_attempt_at, candidate.match_id
    for update of candidate skip locked limit 1;
  if not found then return; end if;
  update public.pubg_performance_budget set used=used+1 where day=v_day;
  return query update public.pubg_performance_jobs set state='running',attempts=attempts+1,
    lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes',updated_at=now()
    where (platform,account_id,match_id,calculation_version,result_version)=
      (j.platform,j.account_id,j.match_id,j.calculation_version,j.result_version) returning *;
end $function$;

revoke all on function public.claim_pubg_performance_job(integer) from public,anon,authenticated;
grant execute on function public.claim_pubg_performance_job(integer) to service_role;

commit;
