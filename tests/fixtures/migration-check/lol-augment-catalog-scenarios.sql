begin;
set local timezone='UTC';
create temporary table augment_checks (assertions integer not null);
insert into augment_checks values (0);
grant select,update on augment_checks to anon,authenticated,service_role;

create function pg_temp.check_augment(p_ok boolean,p_label text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception '증강 검증 실패: %',p_label; end if;
  update pg_temp.augment_checks set assertions=assertions+1;
end $$;
create function pg_temp.reject_augment(p_sql text,p_state text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate=p_state then
      update pg_temp.augment_checks set assertions=assertions+1;
      return;
    end if;
    raise;
  end;
  raise exception '증강 검증이 거부하지 않음: %',p_sql;
end $$;

-- 넓은 기존 허용 정책 아래에서도 신규 버킷의 차단이 유지되어야 한다.
create policy augment_test_open_objects on storage.objects for all to anon,authenticated using (true) with check (true);
create policy augment_test_open_buckets on storage.buckets for all to anon,authenticated using (true) with check (true);
insert into storage.objects(bucket_id,name) values ('lol-augment-snapshots','16.21/private.json'),('lol-augment-evidence','private.png');

do $$
declare t text; f record; r text;
begin
  foreach r in array array['anon','authenticated'] loop
    for t in select tablename from pg_tables where schemaname='public' and (
      tablename in ('lol_game_patches','lol_augments') or tablename like 'lol_augment_%'
    ) loop
      perform pg_temp.check_augment(not has_table_privilege(r,'public.' || t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),r || ' 테이블 권한 ' || t);
      perform pg_temp.check_augment((select relrowsecurity from pg_class where oid=('public.' || t)::regclass),'RLS ' || t);
      execute format('set local role %I',r);
      perform pg_temp.reject_augment(format('select * from public.%I',t),'42501');
      reset role;
    end loop;
    for f in select p.oid,p.oid::regprocedure as signature,p.prosecdef,p.proconfig from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (
        'upsert_lol_augment_snapshot','record_lol_augment_patch_changes','acquire_lol_augment_ingestion_lease',
        'finish_lol_augment_ingestion_run','publish_lol_augment_patch','get_lol_augment_catalog'
      ) loop
      perform pg_temp.check_augment(not has_function_privilege(r,f.oid,'EXECUTE'),r || ' RPC 권한 ' || f.signature);
      perform pg_temp.check_augment(not f.prosecdef and 'search_path=""'=any(f.proconfig),'invoker/search_path ' || f.signature);
      perform pg_temp.check_augment(has_function_privilege('service_role',f.oid,'EXECUTE'),'서비스 RPC 권한');
    end loop;
    execute format('set local role %I',r);
    perform pg_temp.reject_augment('select public.get_lol_augment_catalog()','42501');
    perform pg_temp.reject_augment('select public.acquire_lol_augment_ingestion_lease(''16.21'')','42501');
    perform pg_temp.check_augment((select count(*)=0 from storage.objects where bucket_id in ('lol-augment-snapshots','lol-augment-evidence')),'비공개 객체 조회');
    perform pg_temp.check_augment((select count(*)=0 from storage.buckets where id in ('lol-augment-snapshots','lol-augment-evidence')),'비공개 버킷 조회');
    perform pg_temp.reject_augment('insert into storage.objects(bucket_id,name) values(''lol-augment-snapshots'',''denied.json'')','42501');
    perform pg_temp.reject_augment('insert into storage.objects(bucket_id,name) values(''lol-augment-evidence'',''denied.png'')','42501');
    perform pg_temp.reject_augment('insert into storage.buckets(id,name) values(''lol-augment-snapshots'',''denied'')','42501');
    update storage.objects set name='denied' where bucket_id in ('lol-augment-snapshots','lol-augment-evidence');
    perform pg_temp.check_augment(not found,'객체 수정 차단');
    delete from storage.objects where bucket_id in ('lol-augment-snapshots','lol-augment-evidence');
    perform pg_temp.check_augment(not found,'객체 삭제 차단');
    update storage.buckets set public=true where id in ('lol-augment-snapshots','lol-augment-evidence');
    perform pg_temp.check_augment(not found,'버킷 공개 전환 차단');
    delete from storage.buckets where id in ('lol-augment-snapshots','lol-augment-evidence');
    perform pg_temp.check_augment(not found,'버킷 삭제 차단');
    reset role;
  end loop;
end $$;

set local role service_role;
do $$
declare run1 uuid; run2 uuid; expired uuid; source_id uuid; payload jsonb; change jsonb; entry jsonb; result jsonb;
begin
  perform pg_temp.check_augment((select not public and file_size_limit=67108864 and allowed_mime_types=array['application/json']
    from storage.buckets where id='lol-augment-snapshots'),'스냅샷 JSON/64MB');
  perform pg_temp.check_augment((select not public and file_size_limit=5242880 and allowed_mime_types=array['image/png','image/jpeg','image/webp']
    from storage.buckets where id='lol-augment-evidence'),'증거 이미지/5MB');
  insert into storage.objects(bucket_id,name) values('lol-augment-evidence','service.png');
  update storage.objects set name='service-updated.png' where bucket_id='lol-augment-evidence' and name='service.png';
  perform pg_temp.check_augment(found,'서비스 객체 수정');
  delete from storage.objects where bucket_id='lol-augment-evidence' and name='service-updated.png';
  perform pg_temp.check_augment(found,'서비스 객체 삭제');
  perform pg_temp.check_augment(public.get_lol_augment_catalog() is null,'최초 게시본 없음');
  perform pg_temp.reject_augment('select public.acquire_lol_augment_ingestion_lease(''26.21'')','22023');
  perform pg_temp.reject_augment('select public.acquire_lol_augment_ingestion_lease(''16.21'',null,3601)','22023');
  run1 := public.acquire_lol_augment_ingestion_lease('16.21');
  perform pg_temp.check_augment(run1 is not null,'lease 획득');
  perform pg_temp.reject_augment('select public.acquire_lol_augment_ingestion_lease(''16.25'',''00000000-0000-0000-0000-000000000001'')','22023');
  perform pg_temp.check_augment(public.acquire_lol_augment_ingestion_lease('16.21') is null,'lease 경합');
  perform pg_temp.reject_augment(format('select public.finish_lol_augment_ingestion_run(%L,''succeeded'')',run1),'22023');
  entry := jsonb_build_object('platform_id',3118,'name_id','ArcaneAxiom','rarity','gold','is_internal',false,'mode_name','KIWI',
    'state','official_active','in_pool',true,'enabled',true,'quest',false,'ability',false,'build_tags',0,'augment_tags',0,'data_values','[]'::jsonb,'source_hash',repeat('a',64),
    'localizations',jsonb_build_array(
      jsonb_build_object('locale','ko_kr','name','비전 원칙','description','설명','tooltip_raw','@Unknown@','tooltip_rendered',
        jsonb_build_array(jsonb_build_object('text','설명','style','[]'::jsonb)),'render_status','partial','display_source','desc','display_text','설명'),
      jsonb_build_object('locale','en_us','name','Arcane Axiom','description','Damage @Unknown@','tooltip_raw','@Unknown@','tooltip_rendered',
        jsonb_build_array(jsonb_build_object('text','Damage (수치 미확인)','style','[]'::jsonb)),
        'render_status','failed','display_source','desc_partial','display_text','Damage (수치 미확인)')),
    'aliases',jsonb_build_array(jsonb_build_object('alias','비전원칙','kind','search')));
  payload := jsonb_build_object('patch',jsonb_build_object('display_patch','26.21','released_at','2026-10-20T00:00:00Z',
    'ddragon_version','16.21.1','cdragon_version','16.21','verified_at','2026-10-23T00:00:00Z'),
    'snapshot_path','16.21/' || repeat('a',64) || '.json','augments',jsonb_build_array(entry));
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.21'',null)',run1),'22023');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.21'',%L)',run1,
    jsonb_build_object('patch','{}'::jsonb,'augments','[]'::jsonb,'padding',repeat('x',8388609))),'22023');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.21'',%L)',run1,
    jsonb_set(payload,'{augments}',(select jsonb_agg(entry) from generate_series(1,1001)))),'22023');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.21'',%L)',run1,
    jsonb_set(payload,'{augments}',jsonb_build_array(entry,entry))),'22023');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.21'',%L)',run1,
    jsonb_set(payload,'{augments,0,rarity}','"unknown"')),'23514');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.21'',%L)',run1,
    jsonb_set(payload,'{augments,0,mode_name}','"CHERRY"')),'23514');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.21'',%L)',run1,
    jsonb_set(payload,'{augments,0,localizations,0,locale}','"unknown"')),'23514');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.21'',%L)',run1,
    jsonb_set(payload,'{augments,0,localizations,0,description}','" "')),'23514');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.21'',%L)',run1,
    jsonb_set(payload,'{augments,0,localizations,0,display_source}','"unknown"')),'23514');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.21'',%L)',run1,
    jsonb_set(payload,'{patch,display_patch}','"26.22"')),'23514');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.21'',%L)',run1,
    jsonb_set(payload,'{snapshot_path}','"16.22/wrong.json"')),'22023');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.21'',%L)',run1,
    jsonb_set(payload,'{augments,0,aliases}',(select jsonb_agg(jsonb_build_object('alias','x','kind','search')) from generate_series(1,21)))),'22023');
  perform pg_temp.check_augment((select count(*)=0 from public.lol_augments),'잘못된 입력 원자적 롤백');
  perform pg_temp.check_augment(public.upsert_lol_augment_snapshot(run1,'16.21',payload)=1,'스냅샷 저장');
  perform pg_temp.check_augment(public.upsert_lol_augment_snapshot(run1,'16.21',payload)=1,'스냅샷 멱등');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.21'',%L)',run1,
    jsonb_set(payload,'{augments,0,rarity}','"silver"')),'22023');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.22'',%L)',run1,payload),'55000');
  perform pg_temp.check_augment((select count(*)=2 from public.lol_augment_localizations where client_patch='16.21'),'번역 중복 없음');
  perform pg_temp.check_augment((select count(*)=1 from public.lol_augment_aliases where platform_id=3118),'별칭 중복 없음');
  perform pg_temp.check_augment(public.get_lol_augment_catalog('16.21') is null,'명시 패치 초안 비공개');
  perform pg_temp.reject_augment('select public.publish_lol_augment_patch(''16.21'')','55000');
  change := jsonb_build_array(jsonb_build_object('platform_id',3118,'change_type','added','official',true,'summary_ko','신규 증강','review_status','pending'));
  perform pg_temp.check_augment(public.record_lol_augment_patch_changes(run1,'16.21',change)=1,'변경 저장');
  perform public.record_lol_augment_patch_changes(run1,'16.21',change);
  perform pg_temp.check_augment((select count(*)=1 from public.lol_augment_patch_changes where client_patch='16.21'),'변경 멱등');
  perform pg_temp.reject_augment(format('select public.record_lol_augment_patch_changes(%L,''16.21'',%L)',run1,
    jsonb_set(change,'{0,change_type}','"unknown"')),'23514');
  perform pg_temp.reject_augment(format('select public.record_lol_augment_patch_changes(%L,''16.21'',%L)',run1,
    (select jsonb_agg('{}'::jsonb) from generate_series(1,2001))),'22023');
  perform pg_temp.reject_augment(format('select public.record_lol_augment_patch_changes(%L,''16.21'',%L)',run1,
    jsonb_build_array(jsonb_build_object('summary_ko',repeat('x',1048577)))),'22023');
  perform public.finish_lol_augment_ingestion_run(run1,'review');
  perform public.finish_lol_augment_ingestion_run(run1,'review');
  perform pg_temp.reject_augment('select public.publish_lol_augment_patch(''16.21'')','55000');
  update public.lol_augment_patch_changes set review_status='approved' where client_patch='16.21';
  perform public.publish_lol_augment_patch('16.21');
  result := public.get_lol_augment_catalog();
  perform pg_temp.check_augment(result->>'clientPatch'='16.21' and jsonb_array_length(result->'augments')=1,'게시본 조회');
  perform pg_temp.check_augment(result#>>'{augments,0,localizations,en_us,displaySource}'='desc_partial','부분 설명 표시 출처');
  perform pg_temp.check_augment(result#>>'{augments,0,localizations,en_us,text}'='Damage (수치 미확인)','부분 설명 표시 문구');
  perform pg_temp.check_augment(not (result::text like '%snapshot_path%') and not (result::text like '%lease_until%'),'DTO 내부 정보 제외');
  perform pg_temp.check_augment(jsonb_array_length(result->'changes')=1,'승인된 변경 조회');
  perform pg_temp.reject_augment('select public.acquire_lol_augment_ingestion_lease(''16.21'')','55000');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.21'',%L)',run1,payload),'55000');

  run2 := public.acquire_lol_augment_ingestion_lease('16.22');
  payload := jsonb_set(jsonb_set(jsonb_set(jsonb_set(payload,'{patch,display_patch}','"26.22"'),
    '{patch,ddragon_version}','"16.22.1"'),'{patch,cdragon_version}','"16.22"'),
    '{snapshot_path}',to_jsonb('16.22/' || repeat('b',64) || '.json'));
  payload := jsonb_set(payload,'{augments,0,rarity}','"prismatic"');
  perform public.upsert_lol_augment_snapshot(run2,'16.22',payload);
  perform pg_temp.check_augment(public.get_lol_augment_catalog()->>'clientPatch'='16.21','수집 중 이전 게시본 유지');
  perform public.finish_lol_augment_ingestion_run(run2,'succeeded');
  perform public.publish_lol_augment_patch('16.22');
  perform pg_temp.check_augment(public.get_lol_augment_catalog()->>'clientPatch'='16.22','게시 전환');
  perform pg_temp.check_augment(public.get_lol_augment_catalog('16.21')#>>'{augments,0,rarity}'='gold','과거 패치 등급 보존');
  perform pg_temp.check_augment(public.get_lol_augment_catalog()#>>'{augments,0,rarity}'='prismatic','현재 패치 등급');
  perform public.publish_lol_augment_patch('16.21');
  perform pg_temp.check_augment(public.get_lol_augment_catalog()->>'clientPatch'='16.21','이전 게시본 롤백');

  expired := public.acquire_lol_augment_ingestion_lease('16.23');
  update public.lol_augment_ingestion_runs set lease_until=clock_timestamp()-interval '1 second' where id=expired;
  run2 := public.acquire_lol_augment_ingestion_lease('16.23');
  perform pg_temp.check_augment(run2 is not null and run2<>expired,'만료 lease 교체');
  perform pg_temp.check_augment((select status='failed' and error_code='lease_expired' from public.lol_augment_ingestion_runs where id=expired),'만료 실행 이력');
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.23'',%L)',expired,payload),'55000');
  perform pg_temp.reject_augment(format('select public.finish_lol_augment_ingestion_run(%L,''failed'')',expired),'55000');
  perform public.finish_lol_augment_ingestion_run(run2,'blocked','validation_failed');
  perform pg_temp.reject_augment('select public.publish_lol_augment_patch(''16.23'')','55000');
  perform pg_temp.check_augment(public.get_lol_augment_catalog()->>'clientPatch'='16.21','실패 후 이전 게시본 유지');
  insert into public.lol_augment_data_sources(kind,url,enabled) values('client_data','https://raw.communitydragon.org/16.25/',false) returning id into source_id;
  perform pg_temp.reject_augment(format('select public.acquire_lol_augment_ingestion_lease(''16.25'',%L)',source_id),'22023');
  update public.lol_augment_data_sources set enabled=true where id=source_id;
  run2 := public.acquire_lol_augment_ingestion_lease('16.25',source_id);
  update public.lol_augment_data_sources set enabled=false where id=source_id;
  perform pg_temp.reject_augment(format('select public.upsert_lol_augment_snapshot(%L,''16.25'',%L)',run2,payload),'55000');

end $$;
reset role;
select assertions as augment_catalog_assertions from augment_checks;
rollback;
select 'LoL 증강 저장 권한/상한/멱등/lease/게시 전환/롤백 시나리오 통과' as result;
