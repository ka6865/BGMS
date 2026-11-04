begin;
set local request.jwt.claim.role='service_role';

create function pg_temp.expect_reference_error(p_sql text,p_state text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate=p_state then return; end if;
    raise;
  end;
  raise exception 'Expected SQLSTATE % for %',p_state,p_sql;
end
$$;

create function pg_temp.reference_candidate(p_kind text,p_source text,p_champion integer,p_raw text,p_normalized text)
returns jsonb language sql immutable as $$
  select jsonb_build_object('kind',p_kind,'source',p_source,'clientPatch','16.21','championId',p_champion,
    'upstreamVersion','fixture-v1','sourceDataDate','2026-11-04','rawHash',p_raw,'normalizedHash',p_normalized,
    'rawPath','external/mayhem-reference/objects/'||p_raw||'.json',
    'normalizedPath','external/mayhem-reference/objects/'||p_normalized||'.json','rawBytes',123,'normalizedBytes',456,
    'attribution','Fixture source attribution','rightsBasis','Fixture reuse rights basis verified.')
$$;

do $$
declare
  v_admin uuid:='71000000-0000-4000-8000-000000000001'; v_token uuid; v_id bigint; v_first bigint;
  v_second bigint; v_item bigint; v_raw_revision bigint; v_candidate jsonb; v_bytes bigint;
  v_a text:=repeat('a',64); v_b text:=repeat('b',64); v_c text:=repeat('c',64); v_d text:=repeat('d',64);
  v_e text:=repeat('e',64); v_f text:=repeat('f',64);
begin
  select lease_token into v_token from public.acquire_lol_collection_lease('ops:lol-mayhem-reference',120);
  if v_token is null then raise exception 'FAIL: unable to acquire reference collection lease'; end if;
  insert into storage.objects(bucket_id,name,metadata) values
    ('lol-augment-snapshots','external/mayhem-reference/objects/'||v_a||'.json','{"size":123}'::jsonb),
    ('lol-augment-snapshots','external/mayhem-reference/objects/'||v_b||'.json','{"size":456}'::jsonb),
    ('lol-augment-snapshots','external/mayhem-reference/objects/'||v_c||'.json','{"size":123}'::jsonb),
    ('lol-augment-snapshots','external/mayhem-reference/objects/'||v_d||'.json','{"size":456}'::jsonb),
    ('lol-augment-snapshots','external/mayhem-reference/objects/'||v_e||'.json','{"size":123}'::jsonb),
    ('lol-augment-snapshots','external/mayhem-reference/objects/'||v_f||'.json','{"size":456}'::jsonb),
    ('lol-augment-snapshots','external/unrelated/ignored.json','{"size":1000}'::jsonb);

  v_candidate:=pg_temp.reference_candidate('augment_rankings','arammayhem',0,v_a,v_b);
  v_first:=public.ingest_lol_mayhem_reference(v_candidate,v_token);
  if v_first<>public.ingest_lol_mayhem_reference(v_candidate,v_token) then raise exception 'FAIL: ingest was not idempotent'; end if;
  v_raw_revision:=public.ingest_lol_mayhem_reference(pg_temp.reference_candidate('augment_rankings','arammayhem',0,v_c,v_b),v_token);
  if v_raw_revision=v_first then raise exception 'FAIL: changed raw source with unchanged normalized data was lost'; end if;
  v_candidate:=pg_temp.reference_candidate('augment_rankings','arammayhem',0,v_c,v_d);
  v_second:=public.ingest_lol_mayhem_reference(v_candidate,v_token);
  v_candidate:=pg_temp.reference_candidate('item_ratings','iesdev',266,v_e,v_f);
  v_item:=public.ingest_lol_mayhem_reference(v_candidate,v_token);

  perform public.review_lol_mayhem_reference(v_first,'approve',null,v_admin,null);
  perform pg_temp.expect_reference_error(format('select public.review_lol_mayhem_reference(%s,''reject'',null,%L,null)',v_second,v_admin),'22023');
  perform pg_temp.expect_reference_error(format('select public.review_lol_mayhem_reference(%s,''reject'',null,%L,''short'')',v_second,v_admin),'22023');
  perform public.review_lol_mayhem_reference(v_item,'approve',null,v_admin,null);

  perform public.review_lol_mayhem_reference(v_first,'publish',null,v_admin,null);
  -- 새 후보 승인 요청에도 화면에서 본 현재 공개본 ID가 포함된다.
  perform public.review_lol_mayhem_reference(v_second,'approve',v_first,v_admin,null);
  if (select previous_release_id from public.lol_mayhem_reference_publications where kind='augment_rankings') is not null then
    raise exception 'FAIL: first publication previous id should be null'; end if;
  perform public.review_lol_mayhem_reference(v_first,'publish',v_first,v_admin,null);
  if (select release_id from public.lol_mayhem_reference_publications where kind='augment_rankings')<>v_first
    or (select previous_release_id from public.lol_mayhem_reference_publications where kind='augment_rankings')=v_first then
    raise exception 'FAIL: idempotent publication formed a self-reference'; end if;
  perform pg_temp.expect_reference_error(format('select public.review_lol_mayhem_reference(%s,''publish'',999999,%L,null)',v_second,v_admin),'PT409');
  perform public.review_lol_mayhem_reference(v_second,'publish',v_first,v_admin,null);
  perform pg_temp.expect_reference_error(format('select public.review_lol_mayhem_reference(%s,''rollback'',%s,%L,null)',v_first,v_second,v_admin),'55000');
  perform public.review_lol_mayhem_reference(v_second,'rollback',v_second,v_admin,null);
  if (select release_id from public.lol_mayhem_reference_publications where kind='augment_rankings')<>v_first then
    raise exception 'FAIL: rollback did not restore the previous reference'; end if;

  perform public.review_lol_mayhem_reference(v_item,'publish',null,v_admin,null);
  if (select release_id from public.lol_mayhem_reference_publications where kind='augment_rankings')<>v_first
    or (select release_id from public.lol_mayhem_reference_publications where kind='item_ratings')<>v_item then
    raise exception 'FAIL: publication keys crossed'; end if;
  perform public.review_lol_mayhem_reference(v_item,'rollback',v_item,v_admin,null);
  if exists(select 1 from public.lol_mayhem_reference_publications where kind='item_ratings') then
    raise exception 'FAIL: first publication rollback did not clear publication'; end if;

  perform pg_temp.expect_reference_error(format('update public.lol_mayhem_reference_releases set raw_bytes=124 where id=%s',v_first),'55000');
  perform pg_temp.expect_reference_error(format('select public.renew_lol_mayhem_reference_lease(%L::uuid)',gen_random_uuid()),'PT409');
  perform public.renew_lol_mayhem_reference_lease(v_token);
  v_bytes:=public.get_lol_mayhem_reference_storage_bytes();
  if v_bytes<>3*(123+456) then raise exception 'FAIL: reference storage bytes prefix/bucket scope incorrect: %',v_bytes; end if;

  perform pg_temp.expect_reference_error(format('select public.ingest_lol_mayhem_reference(%L::jsonb,%L::uuid)',
    (v_candidate||jsonb_build_object('unexpected',true))::text,v_token),'22023');
  perform pg_temp.expect_reference_error(format('select public.ingest_lol_mayhem_reference(%L::jsonb,%L::uuid)',
    jsonb_set(v_candidate,'{source}',to_jsonb('aramgg'::text))::text,v_token),'22023');
  v_candidate:=pg_temp.reference_candidate('champion_tiers','aramgg',0,repeat('9',64),repeat('8',64));
  perform pg_temp.expect_reference_error(format('select public.ingest_lol_mayhem_reference(%L::jsonb,%L::uuid)',v_candidate::text,v_token),'22023');
  perform pg_temp.expect_reference_error(format('select public.review_lol_mayhem_reference(%s,''publish'',null,%L,null)',v_second,v_admin),'PT409');
  if (select count(*) from public.admin_audit_events where target_type='lol_mayhem_reference_release')<9 then
    raise exception 'FAIL: review audit events were not recorded'; end if;
end
$$;

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    execute format('set local role %I',r);
    execute format('set local request.jwt.claim.role=%L',r);
    begin
      perform * from public.lol_mayhem_reference_releases;
      raise exception 'FAIL: % read reference releases',r;
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.get_lol_mayhem_reference_storage_bytes();
      raise exception 'FAIL: % called storage RPC',r;
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.ingest_lol_mayhem_reference('{}'::jsonb,null);
      raise exception 'FAIL: % called ingest RPC',r;
    exception when insufficient_privilege then null;
    end;
    execute 'reset role';
  end loop;
end
$$;

rollback;
