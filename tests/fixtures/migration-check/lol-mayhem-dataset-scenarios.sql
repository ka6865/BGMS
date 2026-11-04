begin;
create temporary table mayhem_assertions (checked integer not null default 0);
grant select,update on mayhem_assertions to anon,authenticated,service_role;

create function pg_temp.check_mayhem(p_ok boolean,p_label text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'LoL Mayhem 검증 실패: %',p_label; end if;
  update pg_temp.mayhem_assertions set checked=checked+1;
end $$;
create function pg_temp.reject_mayhem(p_sql text,p_state text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate=p_state then
      update pg_temp.mayhem_assertions set checked=checked+1;
      return;
    end if;
    raise;
  end;
  raise exception 'LoL Mayhem 검증이 거부하지 않음: %',p_sql;
end $$;
create function pg_temp.mayhem_mapping_snapshot() returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'external_id',external_id,'client_patch',client_patch,'platform_id',platform_id,
    'status',status,'reviewed_at',reviewed_at
  ) order by external_id,client_patch),'[]'::jsonb)
  from public.lol_mayhem_augment_mappings where source='arammayhem' and client_patch='16.21'
$$;
create function pg_temp.mayhem_manifest_path(p_hash text,p_capture_hash text,p_patch text) returns text language sql as $$
  select 'external/arammayhem/batches/'||p_hash||'/captures/'||p_capture_hash||'/normalized/'||p_patch||'/v1-m1.json'
$$;
create function pg_temp.mayhem_metadata(p_hash text,p_token uuid,p_capture_hash text default repeat('f',64)) returns jsonb language sql as $$
  select jsonb_build_object(
    'leaseToken',p_token::text,
    'normalizerVersion',1,
    'mappingRevision',1,
    'mappingHash',repeat('d',64),
    'captureHash',p_capture_hash,
    'mappingSnapshot',pg_temp.mayhem_mapping_snapshot(),
    'sourceStatsDate','2026-11-02',
    'license','CC BY 4.0',
    'attribution','AR carry data',
    'rawManifestPath','external/arammayhem/batches/'||p_hash||'/captures/'||p_capture_hash||'/manifest.json',
    'counts',jsonb_build_object('rates',2,'combos',2)
  )
$$;

insert into auth.users(id) values ('70000000-0000-4000-8000-000000000001');

set local role service_role;
do $$
declare
  v_admin uuid := '70000000-0000-4000-8000-000000000001';
  v_token uuid;
  v_metadata jsonb;
  v_rates jsonb := jsonb_build_array(
    jsonb_build_object('externalId','aug-known','pickRate',null,'pickRateRank',null,'sourceClientPatch','16.21'),
    jsonb_build_object('externalId','aug-rate','pickRate',2.5,'pickRateRank',3,'sourceClientPatch','16.21')
  );
  v_combos jsonb := jsonb_build_array(
    jsonb_build_object('comboId',1001,'championId',266,'augmentIds',jsonb_build_array('aug-known','aug-missing'),
      'types',jsonb_build_array('god'),'sourceUrl','https://arammayhem.com/build/1001'),
    jsonb_build_object('comboId',1002,'championId',266,'augmentIds',jsonb_build_array('aug-known'),
      'types',jsonb_build_array('trap'),'sourceUrl','https://arammayhem.com/build/1002')
  );
  v_first bigint;
  v_repeat bigint;
  v_second bigint;
  v_pending_move bigint;
  v_long_combo_release bigint;
  v_hash text := repeat('a',64);
  v_hash_2 text := repeat('a',64);
  v_hash_move text := repeat('e',64);
  v_capture_1 text := repeat('1',64);
  v_capture_2 text := repeat('2',64);
  v_capture_move text := repeat('e',64);
  v_long_hash text := repeat('9',64);
  v_long_capture text := repeat('9',64);
  v_long_augment_ids text[] := array[
    'aug-known','aug-rate','aug-long-03','aug-long-04','aug-long-05','aug-long-06','aug-long-07',
    'aug-long-08','aug-long-09','aug-long-10','aug-long-11','aug-long-12','aug-long-13','aug-long-14','aug-long-15'
  ];
  v_lease_before timestamptz;
  v_move_rates jsonb;
begin
  insert into public.lol_game_patches(client_patch,display_patch,published_at)
    values ('16.21','26.21',pg_catalog.clock_timestamp());
  insert into public.lol_augments(platform_id,name_id,rarity,first_seen_patch,last_seen_patch)
    values (3118,'ArcaneAxiom','gold','16.21','16.21'),(3119,'SecondAugment','gold','16.21','16.21');
  insert into public.lol_augments(platform_id,name_id,rarity,first_seen_patch,last_seen_patch)
    select i,'ComboAugment'||i::text,'gold','16.21','16.21' from generate_series(3120,3132) as ids(i);
  insert into public.lol_augment_patch_states(
    platform_id,client_patch,mode_name,rarity,is_internal,in_pool,enabled,quest,ability,
    build_tags,augment_tags,data_values,source_hash,state
  ) values
    (3118,'16.21','KIWI','gold',false,true,true,false,false,0,0,'[]',repeat('a',64),'official_active'),
    (3119,'16.21','KIWI','gold',false,true,true,false,false,0,0,'[]',repeat('b',64),'official_active');
  insert into public.lol_augment_patch_states(
    platform_id,client_patch,mode_name,rarity,is_internal,in_pool,enabled,quest,ability,
    build_tags,augment_tags,data_values,source_hash,state
  ) select i,'16.21','KIWI','gold',false,true,true,false,false,0,0,'[]',
      repeat('a',60)||lpad(to_hex(i),4,'0'),'official_active'
    from generate_series(3120,3132) as ids(i);
  insert into public.lol_augment_ingestion_runs(
    client_patch,finished_at,status,snapshot_path,snapshot_hash,lease_until
  ) values ('16.21',pg_catalog.clock_timestamp(),'succeeded','16.21/'||repeat('c',64)||'.json',repeat('c',64),
    pg_catalog.clock_timestamp()+interval '1 hour') returning id into v_token;
  insert into public.lol_augment_publication(singleton,client_patch,run_id)
    values (true,'16.21',v_token);

  insert into public.lol_mayhem_augment_mappings(
    external_id,client_patch,platform_id,status,evidence,reviewed_by,reviewed_at
  ) values
    ('aug-known','16.21',3118,'approved','{"note":"fixture mapping"}',v_admin,pg_catalog.clock_timestamp()),
    ('aug-rate','16.21',3119,'approved','{"note":"fixture mapping"}',v_admin,pg_catalog.clock_timestamp());
  insert into public.lol_mayhem_augment_mappings(
    external_id,client_patch,platform_id,status,evidence,reviewed_by,reviewed_at
  ) select repeat('x',124)||lpad(i::text,4,'0'),'16.21',3118,'approved',
      '{"note":"large snapshot fixture"}',v_admin,pg_catalog.clock_timestamp()
    from generate_series(1,412) as g(i);

  select lease_token into strict v_token
  from public.acquire_lol_collection_lease('ops:lol-mayhem-external:arammayhem',120);
  select lease_until into strict v_lease_before from public.lol_collection_leases
  where lease_key='ops:lol-mayhem-external:arammayhem' and lease_token=v_token;
  perform public.renew_lol_mayhem_dataset_lease(v_token);
  perform pg_temp.check_mayhem(
    (select lease_until>v_lease_before from public.lol_collection_leases
      where lease_key='ops:lol-mayhem-external:arammayhem' and lease_token=v_token),
    '업로드 직전 lease를 DB 시각 기준 120초 연장'
  );

  v_metadata := pg_temp.mayhem_metadata(v_hash,v_token,v_capture_1);
  perform pg_temp.check_mayhem(
    jsonb_array_length(v_metadata->'mappingSnapshot')=414
      and octet_length(v_metadata::text)>65536 and octet_length(v_metadata::text)<=262144,
    '414 mapping snapshot이 64KiB를 넘더라도 256KiB 상한에 수용'
  );
  perform pg_temp.reject_mayhem(
    format('select public.ingest_lol_mayhem_dataset(%L,%L,%L,%L,jsonb_set(%L::jsonb,''{mappingSnapshot}'',''[null]''::jsonb),%L::jsonb,%L::jsonb)',
      '16.21',v_hash,'bad-mapping-snapshot',pg_temp.mayhem_manifest_path(v_hash,v_capture_1,'16.21'),
      v_metadata,v_rates,v_combos),
    '22023'
  );
  v_first := public.ingest_lol_mayhem_dataset(
    '16.21',v_hash,'aram-release-1',
    pg_temp.mayhem_manifest_path(v_hash,v_capture_1,'16.21'),v_metadata,v_rates,v_combos
  );
  perform pg_temp.check_mayhem(
    (select metadata->'mappingSnapshot'=v_metadata->'mappingSnapshot' and source_capture_hash=v_capture_1
      from public.lol_mayhem_dataset_releases where id=v_first),
    '고정 mapping snapshot과 raw capture hash 보존'
  );
  perform pg_temp.check_mayhem(
    (select metadata->'unknownExternalIds'='["aug-missing"]'::jsonb
      and (metadata->>'unknown_count')::integer=1
      from public.lol_mayhem_dataset_releases where id=v_first),
    '미매핑 ID가 관리자용 metadata에 남음'
  );
  perform pg_temp.check_mayhem(
    (select count(*)=2 and bool_or(pick_rate is null) and bool_or(pick_rate=2.5)
      from public.lol_mayhem_augment_pick_rates where release_id=v_first),
    '선택률 null 보존과 승인 매핑만 저장'
  );
  perform pg_temp.check_mayhem(
    (select count(*)=1 from public.lol_mayhem_combos where release_id=v_first)
      and (select count(*)=1 from public.lol_mayhem_combo_augments where release_id=v_first),
    '미매핑 증강이 든 조합 전체를 제외'
  );
  perform pg_temp.reject_mayhem(
    format('select public.review_lol_mayhem_dataset(%s,''approve'',%L,null)',v_first,v_admin),'55000'
  );
  perform pg_temp.reject_mayhem(
    format('select public.review_lol_mayhem_dataset(%s,''publish'',%L,null)',v_first,v_admin),'55000'
  );
  perform pg_temp.check_mayhem(
    not exists(select 1 from public.lol_mayhem_dataset_publications where client_patch='16.21'),
    '미매핑 release 비공개'
  );

  v_repeat := public.ingest_lol_mayhem_dataset(
    '16.21',v_hash,'aram-release-1',
    pg_temp.mayhem_manifest_path(v_hash,v_capture_1,'16.21'),v_metadata,v_rates,v_combos
  );
  perform pg_temp.check_mayhem(v_repeat=v_first,'동일 pending release ID 멱등');

  perform public.review_lol_mayhem_mapping(
    'aug-missing','16.21',3119,'{"note":"fixture mapping"}'::jsonb,v_admin
  );
  v_repeat := public.ingest_lol_mayhem_dataset(
    '16.21',v_hash,'aram-release-1',
    pg_temp.mayhem_manifest_path(v_hash,v_capture_1,'16.21'),v_metadata,v_rates,v_combos
  );
  perform pg_temp.check_mayhem(v_repeat=v_first
    and (select metadata->'unknownExternalIds'='["aug-missing"]'::jsonb
      from public.lol_mayhem_dataset_releases where id=v_first)
    and (select count(*)=1 from public.lol_mayhem_combos where release_id=v_first),
    'snapshot 이후 추가된 phantom 매핑은 기존 payload에서 사용하지 않음');

  v_metadata := pg_temp.mayhem_metadata(repeat('c',64),v_token);
  update public.lol_mayhem_augment_mappings set status='rejected'
    where source='arammayhem' and external_id='aug-rate' and client_patch='16.21';
  perform pg_temp.reject_mayhem(
    format('select public.ingest_lol_mayhem_dataset(''16.21'',%L,''stale-mapping-snapshot'',%L,%L,%L,%L)',
      repeat('c',64),pg_temp.mayhem_manifest_path(repeat('c',64),v_metadata->>'captureHash','16.21'),
      v_metadata,v_rates,v_combos),
    'PT409'
  );
  perform public.review_lol_mayhem_mapping(
    'aug-rate','16.21',3119,'{"note":"restored after stale snapshot test"}'::jsonb,v_admin
  );
  insert into public.lol_mayhem_augment_mappings(
    external_id,client_patch,platform_id,status,evidence,reviewed_by,reviewed_at
  ) select 'aug-long-'||lpad((i+2)::text,2,'0'),'16.21',3119+i,'approved',
      '{"note":"15-member combo fixture"}',v_admin,pg_catalog.clock_timestamp()
    from generate_series(1,13) as ids(i);

  v_metadata := pg_temp.mayhem_metadata(v_hash,v_token,v_capture_1);
  v_repeat := public.ingest_lol_mayhem_dataset(
    '16.21',v_hash,'aram-release-1',
    pg_temp.mayhem_manifest_path(v_hash,v_capture_1,'16.21'),v_metadata,v_rates,v_combos
  );
  perform pg_temp.check_mayhem(v_repeat=v_first,'새 snapshot으로 pending 동일 release 재정규화');
  perform pg_temp.check_mayhem(
    (select metadata->'unknownExternalIds'='[]'::jsonb and (metadata->>'unknown_count')::integer=0
      from public.lol_mayhem_dataset_releases where id=v_first)
      and (select count(*)=2 from public.lol_mayhem_combos where release_id=v_first)
      and (select count(*)=3 from public.lol_mayhem_combo_augments where release_id=v_first),
    '매핑 후 pending 자식 전체 재구성'
  );
  v_metadata := pg_temp.mayhem_metadata(v_long_hash,v_token,v_long_capture);
  v_long_combo_release := public.ingest_lol_mayhem_dataset(
    '16.21',v_long_hash,'aram-long-combo-fixture',
    pg_temp.mayhem_manifest_path(v_long_hash,v_long_capture,'16.21'),v_metadata,v_rates,
    jsonb_build_array(jsonb_build_object('comboId',935,'championId',266,
      'augmentIds',to_jsonb(v_long_augment_ids),'types',jsonb_build_array('fixture'),
      'sourceUrl','https://arammayhem.com/build/935'))
  );
  perform pg_temp.check_mayhem(
    (select count(*)=15 and min(position)=1 and max(position)=15
      and array_agg(external_id order by position)=v_long_augment_ids
      from public.lol_mayhem_combo_augments
      where release_id=v_long_combo_release and external_combo_id=935),
    '원본 comboId 935의 augmentIds 15개를 순서와 position 1..15로 보존'
  );
  perform public.review_lol_mayhem_dataset(v_first,'approve',v_admin,null);
  perform pg_temp.reject_mayhem(
    format('update public.lol_mayhem_combo_augments set position=2 where release_id=%s and external_combo_id=1002',v_first),
    '55000'
  );

  v_metadata := pg_temp.mayhem_metadata(v_hash_move,v_token,v_capture_move);
  v_move_rates := v_rates || jsonb_build_array(
    jsonb_build_object('externalId','unmapped-rate','pickRate',null,'pickRateRank',null,'sourceClientPatch','16.21')
  );
  v_pending_move := public.ingest_lol_mayhem_dataset(
    '16.21',v_hash_move,'aram-pending-move',
    pg_temp.mayhem_manifest_path(v_hash_move,v_capture_move,'16.21'),v_metadata,v_move_rates,
    jsonb_build_array(jsonb_build_object('comboId',1002,'championId',266,'augmentIds',jsonb_build_array('aug-known'),
      'types',jsonb_build_array('trap'),'sourceUrl','https://arammayhem.com/build/1002'))
  );
  perform pg_temp.reject_mayhem(
    format('update public.lol_mayhem_combo_augments set release_id=%s where release_id=%s and external_combo_id=1002 and position=1',
      v_pending_move,v_first),'55000'
  );
  perform pg_temp.reject_mayhem(
    format('insert into public.lol_mayhem_combo_augments(release_id,external_combo_id,position,external_id,platform_id,client_patch) values (%s,1002,2,''aug-known'',3118,''16.22'')',
      v_pending_move),'23514'
  );
  perform pg_temp.reject_mayhem(
    format('select public.review_lol_mayhem_dataset(%s,''reject'',%L,null)',v_pending_move,v_admin),
    '22023'
  );
  perform pg_temp.reject_mayhem(
    format('select public.review_lol_mayhem_dataset(%s,''reject'',%L,null,''too short'')',v_pending_move,v_admin),
    '22023'
  );
  perform public.review_lol_mayhem_dataset(
    v_pending_move,'reject',v_admin,null,'Fixture release rejected in the migration scenario'
  );
  perform pg_temp.check_mayhem(
    (select metadata->>'reviewReason'='Fixture release rejected in the migration scenario'
      from public.lol_mayhem_dataset_releases where id=v_pending_move)
      and exists(select 1 from public.admin_audit_events where actor_id=v_admin
        and action='lol.mayhem_dataset.reject' and target_id=v_pending_move::text),
    'reject 사유와 감사 이력을 release에 보존'
  );

  v_metadata := pg_temp.mayhem_metadata(v_hash,v_token,v_capture_1);
  v_repeat := public.ingest_lol_mayhem_dataset(
    '16.21',v_hash,'aram-release-1',
    pg_temp.mayhem_manifest_path(v_hash,v_capture_1,'16.21'),v_metadata,v_rates,v_combos
  );
  perform pg_temp.check_mayhem(
    v_repeat=v_first and (select count(*)=2 from public.lol_mayhem_combos where release_id=v_first),
    'approved release 불변 및 재수집 멱등'
  );

  update public.lol_augment_patch_states
    set enabled=false,in_pool=false,state='official_disabled'
    where platform_id=3118 and client_patch='16.21' and mode_name='KIWI';
  perform pg_temp.reject_mayhem(
    format('select public.review_lol_mayhem_dataset(%s,''publish'',%L,null)',v_first,v_admin),'55000'
  );
  update public.lol_augment_patch_states
    set enabled=true,in_pool=true,state='official_active'
    where platform_id=3118 and client_patch='16.21' and mode_name='KIWI';
  perform public.review_lol_mayhem_dataset(v_first,'publish',v_admin,null);
  perform pg_temp.check_mayhem(
    exists(select 1 from public.admin_audit_events where actor_id=v_admin
      and action='lol.mayhem_dataset.approve' and target_id=v_first::text)
    and exists(select 1 from public.admin_audit_events where actor_id=v_admin
      and action='lol.mayhem_dataset.publish' and target_id=v_first::text)
    and exists(select 1 from public.admin_audit_events where actor_id=v_admin
      and action='lol.mayhem_mapping.upsert' and target_id='arammayhem:16.21:aug-missing'),
    'mapping·approve·publish 감사 기록'
  );
  perform pg_temp.reject_mayhem(
    format('select public.review_lol_mayhem_dataset(%s,''publish'',%L,null)',v_first,v_admin),'PT409'
  );

  v_metadata := pg_temp.mayhem_metadata(v_hash_2,v_token,v_capture_2);
  v_second := public.ingest_lol_mayhem_dataset(
    '16.21',v_hash_2,'aram-release-2',
    pg_temp.mayhem_manifest_path(v_hash_2,v_capture_2,'16.21'),v_metadata,v_rates,
    jsonb_build_array(jsonb_build_object('comboId',2001,'championId',266,'augmentIds',jsonb_build_array('aug-known'),
      'types',jsonb_build_array('blackTech'),'sourceUrl','https://arammayhem.com/build/2001'))
  );
  perform public.review_lol_mayhem_dataset(v_second,'approve',v_admin,null);
  perform pg_temp.check_mayhem(v_second<>v_first and
    (select source_capture_hash=v_capture_2 and batch_hash=v_hash from public.lol_mayhem_dataset_releases where id=v_second),
    '같은 batch의 변경된 raw capture는 별도 release 버전');
  perform public.review_lol_mayhem_dataset(v_second,'publish',v_admin,v_first);
  perform pg_temp.check_mayhem(
    (select release_id=v_second and previous_release_id=v_first
      from public.lol_mayhem_dataset_publications where source='arammayhem' and client_patch='16.21'),
    'publication CAS로 이전 포인터 보관'
  );
  perform public.review_lol_mayhem_dataset(v_first,'rollback',v_admin,v_second);
  perform pg_temp.check_mayhem(
    (select release_id=v_first and previous_release_id=v_second
      from public.lol_mayhem_dataset_publications where source='arammayhem' and client_patch='16.21'),
    'rollback이 직전 공개본으로 복구'
  );
  perform pg_temp.check_mayhem(
    exists(select 1 from public.admin_audit_events where actor_id=v_admin
      and action='lol.mayhem_dataset.rollback' and target_id=v_first::text),
    'rollback 감사 기록'
  );

  v_metadata := pg_temp.mayhem_metadata(repeat('c',64),v_token);
  perform pg_temp.reject_mayhem(
    format('select public.ingest_lol_mayhem_dataset(''16.21'',%L,''bad-rate'',%L,%L,%L,%L)',
      repeat('c',64),pg_temp.mayhem_manifest_path(repeat('c',64),v_metadata->>'captureHash','16.21'),
      v_metadata,jsonb_set(v_rates,'{0,pickRate}',to_jsonb(101)),v_combos),
    '22023'
  );
  perform pg_temp.check_mayhem(
    not exists(select 1 from public.lol_mayhem_dataset_releases where batch_hash=repeat('c',64)),
    '잘못된 입력 원자적 rollback'
  );

  update public.lol_collection_leases
    set lease_until=pg_catalog.clock_timestamp()-interval '1 second'
    where lease_key='ops:lol-mayhem-external:arammayhem' and lease_token=v_token;
  perform pg_temp.reject_mayhem(
    format('select public.renew_lol_mayhem_dataset_lease(%L)',v_token),
    'PT409'
  );
  perform pg_temp.reject_mayhem(
    format('select public.ingest_lol_mayhem_dataset(''16.21'',%L,''expired-lease'',%L,%L,%L,%L)',
      repeat('c',64),pg_temp.mayhem_manifest_path(repeat('c',64),v_metadata->>'captureHash','16.21'),
      v_metadata,v_rates,v_combos),
    'PT409'
  );
end $$;
reset role;

do $$
declare v_role text; v_table text; v_function text;
begin
  foreach v_table in array array[
    'lol_mayhem_dataset_releases','lol_mayhem_augment_mappings','lol_mayhem_augment_pick_rates',
    'lol_mayhem_combos','lol_mayhem_combo_augments','lol_mayhem_dataset_publications','lol_data_sync_status'
  ] loop
    if not (select relrowsecurity from pg_catalog.pg_class where oid=('public.'||v_table)::regclass) then
      raise exception 'LoL Mayhem RLS missing: %',v_table;
    end if;
    foreach v_role in array array['anon','authenticated'] loop
      if has_table_privilege(v_role,'public.'||v_table,'select,insert,update,delete') then
        raise exception 'LoL Mayhem public table privilege: % %',v_role,v_table;
      end if;
    end loop;
    if not has_table_privilege('service_role','public.'||v_table,'select,insert,update,delete') then
      raise exception 'LoL Mayhem service_role table privilege: %',v_table;
    end if;
  end loop;

  foreach v_function in array array[
    'public.ingest_lol_mayhem_dataset(text,text,text,text,jsonb,jsonb,jsonb)',
    'public.review_lol_mayhem_dataset(bigint,text,uuid,bigint,text)',
    'public.review_lol_mayhem_mapping(text,text,integer,jsonb,uuid)',
    'public.renew_lol_mayhem_dataset_lease(uuid)'
  ] loop
    if (select prosecdef or not ('search_path=""'=any(proconfig))
        from pg_catalog.pg_proc where oid=v_function::regprocedure) then
      raise exception 'LoL Mayhem RPC security changed: %',v_function;
    end if;
    if has_function_privilege('anon',v_function,'execute')
      or has_function_privilege('authenticated',v_function,'execute')
      or not has_function_privilege('service_role',v_function,'execute') then
      raise exception 'LoL Mayhem RPC grants are incorrect: %',v_function;
    end if;
  end loop;
end $$;

set local role anon;
select pg_temp.reject_mayhem('select * from public.lol_mayhem_dataset_releases','42501');
select pg_temp.reject_mayhem(
  'select public.ingest_lol_mayhem_dataset(null,null,null,null,null,null,null)','42501'
);
select pg_temp.reject_mayhem(
  'select public.review_lol_mayhem_mapping(null,null,null,null,null)','42501'
);
select pg_temp.reject_mayhem(
  'select public.renew_lol_mayhem_dataset_lease(null)','42501'
);
reset role;
rollback;
\echo '✅ LoL Mayhem 저장·lease·매핑·멱등·원자성·검수·CAS·rollback·RLS 시나리오 통과'
