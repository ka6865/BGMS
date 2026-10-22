-- 전적 테이블의 자동 VACUUM 기준이 낮춰져 가시성 지도가 최신으로 유지되는지 확인한다.
do $$
begin
  if not exists (select 1 from pg_class where oid = 'public.pubg_player_matches'::regclass
      and reloptions @> array['autovacuum_vacuum_scale_factor=0.02', 'autovacuum_vacuum_insert_scale_factor=0.01', 'autovacuum_analyze_scale_factor=0.01']) then
    raise exception 'FAIL: pubg_player_matches autovacuum settings';
  end if;
end;
$$;
