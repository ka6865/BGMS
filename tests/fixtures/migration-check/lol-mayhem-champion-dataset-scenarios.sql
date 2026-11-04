begin;
set local timezone='UTC';
set local request.jwt.claim.role='service_role';

do $$
declare
  v_hash text:=pg_catalog.encode(pg_catalog.sha256(convert_to('[1001,1002]','UTF8')),'hex');
  v_token uuid:=gen_random_uuid(); v_candidate jsonb; v_manifest jsonb; v_id bigint; v_first_id bigint;
  v_admin uuid:='11111111-1111-4111-8111-111111111111'; v_bytes bigint;
begin
  insert into public.lol_game_patches(client_patch,display_patch) values('16.21','26.21') on conflict do nothing;
  insert into public.lol_augments(platform_id,name_id,rarity,first_seen_patch,last_seen_patch)
  values(1001,'test.one','silver','16.21','16.21'),(1002,'test.two','gold','16.21','16.21') on conflict do nothing;
  insert into public.lol_augment_patch_states(platform_id,client_patch,mode_name,rarity,is_internal,in_pool,enabled,quest,ability,
    build_tags,augment_tags,data_values,source_hash,state)
  values(1001,'16.21','KIWI','silver',false,true,true,false,false,0,0,'[]',repeat('a',64),'official_active'),
        (1002,'16.21','KIWI','gold',true,true,false,false,false,0,0,'[]',repeat('b',64),'official_disabled')
  on conflict do nothing;
  insert into public.lol_collection_leases(lease_key,lease_type,lease_token,lease_until)
  values('ops:lol-mayhem-champion:champion_api_v1','collection',v_token,clock_timestamp()+interval '120 seconds')
  on conflict(lease_key) do update set lease_token=excluded.lease_token,lease_until=excluded.lease_until;

  v_manifest:=jsonb_build_object('schemaVersion',1,'source','champion_api_v1','cohort','source_default',
    'clientPatch','16.21','upstreamVersion','16.21.1','sourceDataDate','2026-11-03','catalogHash',v_hash,
    'expectedChampionIds',jsonb_build_array(1,2),'files',jsonb_build_array(
      jsonb_build_object('championId',1,'rawPath','external/champion-stats/champion_api_v1/objects/'||repeat('a',64)||'.json',
        'rawHash',repeat('a',64),'rawBytes',10,'normalizedPath','external/champion-stats/champion_api_v1/objects/'||repeat('b',64)||'.json',
        'normalizedHash',repeat('b',64),'normalizedBytes',20),
      jsonb_build_object('championId',2,'rawPath','external/champion-stats/champion_api_v1/objects/'||repeat('c',64)||'.json',
        'rawHash',repeat('c',64),'rawBytes',10,'normalizedPath','external/champion-stats/champion_api_v1/objects/'||repeat('d',64)||'.json',
        'normalizedHash',repeat('d',64),'normalizedBytes',20)),
    'attribution','Data provider; champion selection stats','rightsBasis','Approved reuse basis captured for this data feed.',
    'normalizerVersion',1);
  v_candidate:=jsonb_build_object('clientPatch','16.21','upstreamVersion','16.21.1','sourceDataDate','2026-11-03',
    'captureHash',repeat('e',64),'manifestPath','external/champion-stats/champion_api_v1/captures/'||repeat('e',64)||'/manifest.json',
    'catalogHash',v_hash,'metadata',v_manifest);
  v_id:=public.ingest_lol_mayhem_champion_dataset(v_candidate,v_token);
  v_first_id:=v_id;
  if v_id<>public.ingest_lol_mayhem_champion_dataset(v_candidate,v_token) then raise exception 'FAIL: duplicate ingest is not idempotent'; end if;

  update public.lol_mayhem_champion_dataset_releases set metadata=jsonb_set(metadata,'{files}','[]'::jsonb)
  where id=v_id;
  begin
    perform public.review_lol_mayhem_champion_dataset(v_id,'approve',null,v_admin,null);
    raise exception 'FAIL: incomplete manifest approved';
  exception when sqlstate '55000' then null;
  end;
  update public.lol_mayhem_champion_dataset_releases set metadata=v_manifest where id=v_id;
  perform public.review_lol_mayhem_champion_dataset(v_id,'approve',null,v_admin,null);
  perform public.review_lol_mayhem_champion_dataset(v_id,'publish',null,v_admin,null);

  v_candidate:=jsonb_set(v_candidate,'{captureHash}',to_jsonb(repeat('f',64)));
  v_candidate:=jsonb_set(v_candidate,'{manifestPath}',to_jsonb('external/champion-stats/champion_api_v1/captures/'||repeat('f',64)||'/manifest.json'));
  v_id:=public.ingest_lol_mayhem_champion_dataset(v_candidate,v_token);
  perform public.review_lol_mayhem_champion_dataset(v_id,'approve',null,v_admin,null);
  begin
    perform public.review_lol_mayhem_champion_dataset(v_id,'publish',999999,v_admin,null);
    raise exception 'FAIL: publication CAS conflict accepted';
  exception when sqlstate 'PT409' then null;
  end;
  perform public.review_lol_mayhem_champion_dataset(v_id,'publish',
    (select release_id from public.lol_mayhem_champion_dataset_publications where client_patch='16.21'),v_admin,null);
  perform public.review_lol_mayhem_champion_dataset(v_id,'rollback',v_id,v_admin,null);
  if (select release_id from public.lol_mayhem_champion_dataset_publications where client_patch='16.21') is distinct from v_first_id then
    raise exception 'FAIL: rollback did not restore previous publication'; end if;
  if (select count(*) from public.admin_audit_events where target_type='lol_mayhem_champion_dataset_release')<5 then
    raise exception 'FAIL: champion dataset review actions missing audit records'; end if;
  update public.lol_collection_leases set lease_until=clock_timestamp()-interval '1 second'
  where lease_key='ops:lol-mayhem-champion:champion_api_v1';
  begin
    perform public.renew_lol_mayhem_champion_dataset_lease(v_token);
    raise exception 'FAIL: expired champion lease was renewed';
  exception when sqlstate 'PT409' then null;
  end;

  insert into storage.objects(bucket_id,name,metadata) values
    ('lol-augment-snapshots','external/champion-stats/champion_api_v1/objects/test.json','{"size":123}'::jsonb),
    ('lol-augment-snapshots','external/other/ignored.json','{"size":999}'::jsonb),
    ('lol-augment-icons','external/champion-stats/champion_api_v1/objects/ignored.json','{"size":999}'::jsonb);
  v_bytes:=public.get_lol_mayhem_champion_storage_bytes();
  if v_bytes<>123 then raise exception 'FAIL: champion storage bytes were not prefix and bucket scoped'; end if;
  update storage.objects set metadata='{}'::jsonb where name='external/champion-stats/champion_api_v1/objects/test.json';
  begin
    perform public.get_lol_mayhem_champion_storage_bytes();
    raise exception 'FAIL: malformed storage size metadata was accepted';
  exception when sqlstate '22023' then null;
  end;
end
$$;

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    execute format('set local role %I',r);
    execute format('set local request.jwt.claim.role=%L',r);
    begin
      perform * from public.lol_mayhem_champion_dataset_releases;
      raise exception 'FAIL: % could read champion releases',r;
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.get_lol_mayhem_champion_storage_bytes();
      raise exception 'FAIL: % could call champion storage budget RPC',r;
    exception when insufficient_privilege then null;
    end;
    execute 'reset role';
  end loop;
end
$$;

rollback;
