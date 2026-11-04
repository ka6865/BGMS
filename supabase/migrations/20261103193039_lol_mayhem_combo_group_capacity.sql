begin;
set local lock_timeout = '2s';

alter table public.lol_mayhem_combo_augments
  drop constraint if exists lol_mayhem_combo_augments_position_check;
alter table public.lol_mayhem_combo_augments
  add constraint lol_mayhem_combo_augments_position_check check (position between 1 and 64);

create or replace function public.ingest_lol_mayhem_dataset(
  p_patch text,
  p_batch_hash text,
  p_release_id text,
  p_manifest_path text,
  p_metadata jsonb,
  p_rates jsonb,
  p_combos jsonb
) returns bigint language plpgsql security invoker set search_path = '' as $$
declare
  v_token uuid;
  v_lease_until timestamptz;
  v_normalizer_version integer;
  v_mapping_revision integer;
  v_capture_hash text;
  v_release_pk bigint;
  v_release_status text;
  v_data_changed boolean := false;
  v_terminal boolean := false;
  v_expected_manifest_path text;
  v_metadata jsonb;
  v_rate jsonb;
  v_combo jsonb;
  v_external_id text;
  v_source_patch text;
  v_mapping_patch text;
  v_platform_id integer;
  v_combo_id bigint;
  v_champion_id integer;
  v_position integer;
  v_all_mapped boolean;
  v_unknown_external_ids text[] := array[]::text[];
  v_child_count integer;
  v_mapping jsonb;
  v_db_platform_id integer;
  v_db_status text;
  v_db_reviewed_at timestamptz;
  v_snapshot_reviewed_at timestamptz;
begin
  if p_patch is null or p_patch !~ '^(15|16)\.[1-9][0-9]?$'
    or p_batch_hash is null or p_batch_hash !~ '^[0-9a-f]{64}$'
    or p_release_id is null or length(btrim(p_release_id)) not between 1 and 128 or p_release_id <> btrim(p_release_id)
    or p_metadata is null or jsonb_typeof(p_metadata) is distinct from 'object'
    or octet_length(p_metadata::text) > 262144
    or jsonb_typeof(p_metadata->'leaseToken') is distinct from 'string'
    or p_metadata->>'leaseToken' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or jsonb_typeof(p_metadata->'normalizerVersion') is distinct from 'number'
    or (p_metadata->>'normalizerVersion')::numeric not between 1 and 1000
    or trunc((p_metadata->>'normalizerVersion')::numeric) <> (p_metadata->>'normalizerVersion')::numeric
    or jsonb_typeof(p_metadata->'mappingRevision') not in ('number','null')
       and p_metadata ? 'mappingRevision'
    or (p_metadata ? 'mappingRevision' and jsonb_typeof(p_metadata->'mappingRevision') = 'number'
      and ((p_metadata->>'mappingRevision')::numeric not between 1 and 100000
        or trunc((p_metadata->>'mappingRevision')::numeric) <> (p_metadata->>'mappingRevision')::numeric))
    or jsonb_typeof(p_metadata->'mappingHash') is distinct from 'string'
    or p_metadata->>'mappingHash' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_metadata->'captureHash') is distinct from 'string'
    or p_metadata->>'captureHash' !~ '^[0-9a-f]{64}$'
    or not (p_metadata ? 'sourceStatsDate')
    or jsonb_typeof(p_metadata->'sourceStatsDate') not in ('string','null')
    or jsonb_typeof(p_metadata->'license') is distinct from 'string'
    or length(btrim(p_metadata->>'license')) not between 1 and 256
    or jsonb_typeof(p_metadata->'attribution') is distinct from 'string'
    or length(btrim(p_metadata->>'attribution')) not between 1 and 512
    or jsonb_typeof(p_metadata->'counts') is distinct from 'object'
    or jsonb_typeof(p_metadata->'mappingSnapshot') is distinct from 'array'
    or p_metadata->>'rawManifestPath' is distinct from
       ('external/arammayhem/batches/' || p_batch_hash || '/captures/' || (p_metadata->>'captureHash') || '/manifest.json')
    or p_manifest_path is null or length(p_manifest_path) > 1024
    or jsonb_typeof(p_rates) is distinct from 'array'
    or jsonb_array_length(p_rates) not between 1 and 2000
    or jsonb_typeof(p_combos) is distinct from 'array'
    or jsonb_array_length(p_combos) not between 1 and 5000
    or octet_length(p_rates::text) + octet_length(p_combos::text) > 8388608 then
    raise exception 'invalid LoL Mayhem dataset input' using errcode = '22023';
  end if;

  v_normalizer_version := (p_metadata->>'normalizerVersion')::integer;
  v_capture_hash := p_metadata->>'captureHash';
  v_mapping_revision := case
    when not (p_metadata ? 'mappingRevision') or jsonb_typeof(p_metadata->'mappingRevision') = 'null' then 1
    else (p_metadata->>'mappingRevision')::integer end;
  v_expected_manifest_path := 'external/arammayhem/batches/' || p_batch_hash || '/captures/' || v_capture_hash || '/normalized/' ||
    p_patch || '/v' || v_normalizer_version::text || '-m' || v_mapping_revision::text || '.json';
  if p_manifest_path <> v_expected_manifest_path then
    raise exception 'invalid normalized manifest path' using errcode = '22023';
  end if;

  if not exists (select 1 from public.lol_game_patches where client_patch = p_patch) then
    raise exception 'unverified LoL patch' using errcode = '22023';
  end if;

  if jsonb_array_length(p_metadata->'mappingSnapshot') > 1000 or exists (
    select 1 from jsonb_array_elements(p_metadata->'mappingSnapshot') as m(value)
    where jsonb_typeof(m.value) is distinct from 'object'
      or (select count(*) from jsonb_object_keys(m.value)) <> 5
      or not (m.value ? 'external_id' and m.value ? 'client_patch' and m.value ? 'platform_id'
        and m.value ? 'status' and m.value ? 'reviewed_at')
      or jsonb_typeof(m.value->'external_id') is distinct from 'string'
      or length(btrim(m.value->>'external_id')) not between 1 and 128
      or m.value->>'external_id' <> btrim(m.value->>'external_id')
      or jsonb_typeof(m.value->'client_patch') is distinct from 'string'
      or m.value->>'client_patch' !~ '^(15|16)\.[1-9][0-9]?$'
      or jsonb_typeof(m.value->'platform_id') is distinct from 'number'
      or (m.value->>'platform_id')::numeric not between 1 and 2147483647
      or trunc((m.value->>'platform_id')::numeric) <> (m.value->>'platform_id')::numeric
      or jsonb_typeof(m.value->'status') is distinct from 'string'
      or m.value->>'status' not in ('approved','rejected')
      or jsonb_typeof(m.value->'reviewed_at') is distinct from 'string'
      or length(m.value->>'reviewed_at') not between 1 and 64
  ) or (select count(*) from jsonb_array_elements(p_metadata->'mappingSnapshot')) <>
       (select count(distinct (m.value->>'external_id',m.value->>'client_patch'))
        from jsonb_array_elements(p_metadata->'mappingSnapshot') as m(value)) then
    raise exception 'invalid LoL Mayhem mapping snapshot' using errcode = '22023';
  end if;

  for v_mapping in
    select value from jsonb_array_elements(p_metadata->'mappingSnapshot') as m(value)
    order by value->>'external_id',value->>'client_patch'
  loop
    begin
      v_snapshot_reviewed_at := (v_mapping->>'reviewed_at')::timestamptz;
    exception when data_exception then
      raise exception 'invalid LoL Mayhem mapping snapshot timestamp' using errcode = '22023';
    end;
    select platform_id,status,reviewed_at into v_db_platform_id,v_db_status,v_db_reviewed_at
    from public.lol_mayhem_augment_mappings
    where source='arammayhem' and external_id=v_mapping->>'external_id'
      and client_patch=v_mapping->>'client_patch'
    for share;
    if not found or v_db_platform_id is distinct from (v_mapping->>'platform_id')::integer
      or v_db_status is distinct from v_mapping->>'status'
      or v_db_reviewed_at is distinct from v_snapshot_reviewed_at then
      raise exception 'stale LoL Mayhem mapping snapshot' using errcode = '40001';
    end if;
  end loop;

  v_token := (p_metadata->>'leaseToken')::uuid;
  select lease_until into v_lease_until
  from public.lol_collection_leases
  where lease_key = 'ops:lol-mayhem-external:arammayhem'
    and lease_type = 'collection' and lease_token = v_token
  for update;
  if not found or v_lease_until <= pg_catalog.clock_timestamp() then
    raise exception 'stale LoL collection lease' using errcode = '40001';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_rates) as r(value)
    where jsonb_typeof(r.value) is distinct from 'object'
  ) or exists (
    select 1 from jsonb_array_elements(p_rates) as r(value)
    cross join lateral jsonb_object_keys(r.value) as k(key)
    where k.key not in ('externalId','pickRate','pickRateRank','sourceClientPatch')
  ) or exists (
    select 1 from jsonb_array_elements(p_rates) as r(value)
    where not (r.value ? 'externalId' and r.value ? 'pickRate' and r.value ? 'pickRateRank' and r.value ? 'sourceClientPatch')
      or jsonb_typeof(r.value->'externalId') is distinct from 'string'
      or length(btrim(r.value->>'externalId')) not between 1 and 128
      or r.value->>'externalId' <> btrim(r.value->>'externalId')
      or jsonb_typeof(r.value->'pickRate') not in ('number','null')
      or (jsonb_typeof(r.value->'pickRate') = 'number'
        and (r.value->>'pickRate')::numeric not between 0 and 100)
      or jsonb_typeof(r.value->'pickRateRank') not in ('number','null')
      or (jsonb_typeof(r.value->'pickRateRank') = 'number'
        and ((r.value->>'pickRateRank')::numeric not between 1 and 1000000
          or trunc((r.value->>'pickRateRank')::numeric) <> (r.value->>'pickRateRank')::numeric))
      or jsonb_typeof(r.value->'sourceClientPatch') not in ('string','null')
      or (jsonb_typeof(r.value->'sourceClientPatch') = 'string'
        and (r.value->>'sourceClientPatch') !~ '^(15|16)\.[1-9][0-9]?$')
  ) then
    raise exception 'invalid LoL Mayhem pick-rate rows' using errcode = '22023';
  end if;
  if (select count(distinct r.value->>'externalId') from jsonb_array_elements(p_rates) as r(value))
    <> jsonb_array_length(p_rates) then
    raise exception 'duplicate LoL Mayhem pick-rate external id' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rates) as r(value)
    where jsonb_typeof(r.value->'sourceClientPatch') = 'string'
      and not exists (select 1 from public.lol_game_patches p where p.client_patch = r.value->>'sourceClientPatch')
  ) then
    raise exception 'unknown pick-rate source patch' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_combos) as c(value)
    where jsonb_typeof(c.value) is distinct from 'object'
  ) or exists (
    select 1 from jsonb_array_elements(p_combos) as c(value)
    cross join lateral jsonb_object_keys(c.value) as k(key)
    where k.key not in ('comboId','championId','augmentIds','types','sourceUrl')
  ) or exists (
    select 1 from jsonb_array_elements(p_combos) as c(value)
    where not (c.value ? 'comboId' and c.value ? 'championId' and c.value ? 'augmentIds'
      and c.value ? 'types' and c.value ? 'sourceUrl')
      or jsonb_typeof(c.value->'comboId') is distinct from 'number'
      or (c.value->>'comboId')::numeric not between 1 and 9223372036854775807
      or trunc((c.value->>'comboId')::numeric) <> (c.value->>'comboId')::numeric
      or jsonb_typeof(c.value->'championId') is distinct from 'number'
      or (c.value->>'championId')::numeric not between 1 and 100000
      or trunc((c.value->>'championId')::numeric) <> (c.value->>'championId')::numeric
      or jsonb_typeof(c.value->'augmentIds') is distinct from 'array'
      or jsonb_array_length(c.value->'augmentIds') not between 1 and 64
      or jsonb_typeof(c.value->'types') is distinct from 'array'
      or jsonb_array_length(c.value->'types') > 16
      or jsonb_typeof(c.value->'sourceUrl') is distinct from 'string'
      or length(c.value->>'sourceUrl') > 2048
      or c.value->>'sourceUrl' !~ '^https://(www[.])?arammayhem[.]com/'
  ) then
    raise exception 'invalid LoL Mayhem combo rows' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_combos) as c(value)
    cross join lateral jsonb_array_elements(c.value->'augmentIds') as a(value)
    where jsonb_typeof(a.value) is distinct from 'string'
      or length(btrim(a.value#>>'{}')) not between 1 and 128
      or a.value#>>'{}' <> btrim(a.value#>>'{}')
  ) or exists (
    select 1 from jsonb_array_elements(p_combos) as c(value)
    cross join lateral jsonb_array_elements(c.value->'types') as t(value)
    where jsonb_typeof(t.value) is distinct from 'string'
      or length(btrim(t.value#>>'{}')) not between 1 and 32
      or t.value#>>'{}' <> btrim(t.value#>>'{}')
  ) or exists (
    select 1 from jsonb_array_elements(p_combos) as c(value)
    where (select count(distinct a.value) from jsonb_array_elements(c.value->'augmentIds') as a(value))
        <> jsonb_array_length(c.value->'augmentIds')
      or (select count(distinct t.value) from jsonb_array_elements(c.value->'types') as t(value))
        <> jsonb_array_length(c.value->'types')
  ) then
    raise exception 'invalid or duplicate LoL Mayhem combo values' using errcode = '22023';
  end if;
  if (select count(distinct (c.value->>'comboId')::numeric) from jsonb_array_elements(p_combos) as c(value))
    <> jsonb_array_length(p_combos) then
    raise exception 'duplicate LoL Mayhem combo id' using errcode = '22023';
  end if;
  select sum(jsonb_array_length(c.value->'augmentIds')) into v_child_count
  from jsonb_array_elements(p_combos) as c(value);
  if v_child_count > 50000 then
    raise exception 'LoL Mayhem combo augment limit' using errcode = '22023';
  end if;

  v_metadata := (p_metadata - 'leaseToken')
    || jsonb_build_object('mappingRevision',v_mapping_revision,'unknownExternalIds','[]'::jsonb,'unknown_count',0);
  v_data_changed := not exists (
    select 1 from public.lol_mayhem_dataset_releases
    where source='arammayhem' and batch_hash=p_batch_hash and source_capture_hash=v_capture_hash
  );
  insert into public.lol_mayhem_dataset_releases(
    upstream_release_id,batch_hash,source_capture_hash,normalizer_version,mapping_revision,
    verified_client_patch,manifest_path,metadata
  ) values (
    p_release_id,p_batch_hash,v_capture_hash,v_normalizer_version,v_mapping_revision,
    p_patch,v_expected_manifest_path,v_metadata
  )
  on conflict (source,batch_hash,source_capture_hash,normalizer_version,mapping_revision,verified_client_patch) do nothing
  returning id into v_release_pk;

  if not found then
    select id,status into v_release_pk,v_release_status
    from public.lol_mayhem_dataset_releases
    where source='arammayhem' and batch_hash=p_batch_hash and source_capture_hash=v_capture_hash
      and normalizer_version=v_normalizer_version and mapping_revision=v_mapping_revision
      and verified_client_patch=p_patch
    for update;
    if not found then raise exception 'LoL Mayhem release conflict' using errcode = '40001'; end if;
    if v_release_status in ('approved','rejected') then
      v_terminal := true;
    else
      delete from public.lol_mayhem_augment_pick_rates where release_id=v_release_pk;
      delete from public.lol_mayhem_combos where release_id=v_release_pk;
      update public.lol_mayhem_dataset_releases
      set upstream_release_id=p_release_id,manifest_path=v_expected_manifest_path,metadata=v_metadata,fetched_at=pg_catalog.clock_timestamp()
      where id=v_release_pk;
    end if;
  end if;

  if not v_terminal then
    for v_rate in select value from jsonb_array_elements(p_rates) loop
      v_external_id := v_rate->>'externalId';
      v_source_patch := case when jsonb_typeof(v_rate->'sourceClientPatch') = 'string'
        then v_rate->>'sourceClientPatch' else null end;
      v_mapping_patch := coalesce(v_source_patch,p_patch);
      select (m.value->>'platform_id')::integer into v_platform_id
      from jsonb_array_elements(p_metadata->'mappingSnapshot') as m(value)
      where m.value->>'external_id'=v_external_id
        and m.value->>'client_patch'=v_mapping_patch and m.value->>'status'='approved';
      if found then
        insert into public.lol_mayhem_augment_pick_rates(
          release_id,external_id,platform_id,source_client_patch,mapping_client_patch,pick_rate,pick_rate_rank
        ) values (
          v_release_pk,v_external_id,v_platform_id,v_source_patch,v_mapping_patch,
          case when jsonb_typeof(v_rate->'pickRate') = 'number' then (v_rate->>'pickRate')::numeric else null end,
          case when jsonb_typeof(v_rate->'pickRateRank') = 'number' then (v_rate->>'pickRateRank')::integer else null end
        );
      elsif not (v_external_id = any(v_unknown_external_ids)) then
        v_unknown_external_ids := pg_catalog.array_append(v_unknown_external_ids,v_external_id);
      end if;
    end loop;

    for v_combo in select value from jsonb_array_elements(p_combos) loop
      v_combo_id := (v_combo->>'comboId')::bigint;
      v_champion_id := (v_combo->>'championId')::integer;
      v_all_mapped := true;
      for v_external_id in select value#>>'{}' from jsonb_array_elements(v_combo->'augmentIds') loop
        select (m.value->>'platform_id')::integer into v_platform_id
        from jsonb_array_elements(p_metadata->'mappingSnapshot') as m(value)
        where m.value->>'external_id'=v_external_id
          and m.value->>'client_patch'=p_patch and m.value->>'status'='approved';
        if not found then
          v_all_mapped := false;
          if not (v_external_id = any(v_unknown_external_ids)) then
            v_unknown_external_ids := pg_catalog.array_append(v_unknown_external_ids,v_external_id);
          end if;
        end if;
      end loop;
      if v_all_mapped then
        insert into public.lol_mayhem_combos(release_id,external_combo_id,champion_id,client_patch,editorial_tags,source_url)
        values (v_release_pk,v_combo_id,v_champion_id,p_patch,
          array(select value#>>'{}' from jsonb_array_elements(v_combo->'types')),
          v_combo->>'sourceUrl');
        v_position := 0;
        for v_external_id in select value#>>'{}' from jsonb_array_elements(v_combo->'augmentIds') loop
          v_position := v_position + 1;
          select (m.value->>'platform_id')::integer into strict v_platform_id
          from jsonb_array_elements(p_metadata->'mappingSnapshot') as m(value)
          where m.value->>'external_id'=v_external_id
            and m.value->>'client_patch'=p_patch and m.value->>'status'='approved';
          insert into public.lol_mayhem_combo_augments(
            release_id,external_combo_id,position,external_id,platform_id,client_patch
          ) values (v_release_pk,v_combo_id,v_position,v_external_id,v_platform_id,p_patch);
        end loop;
      end if;
    end loop;

    v_metadata := jsonb_set(
      jsonb_set(v_metadata,'{unknownExternalIds}',pg_catalog.to_jsonb(v_unknown_external_ids),true),
      '{unknown_count}',pg_catalog.to_jsonb(pg_catalog.cardinality(v_unknown_external_ids)),true
    );
    update public.lol_mayhem_dataset_releases
    set metadata=v_metadata,fetched_at=pg_catalog.clock_timestamp()
    where id=v_release_pk;
  end if;

  if v_lease_until <= pg_catalog.clock_timestamp() or not exists (
    select 1 from public.lol_collection_leases
    where lease_key='ops:lol-mayhem-external:arammayhem'
      and lease_type='collection' and lease_token=v_token and lease_until > pg_catalog.clock_timestamp()
  ) then
    raise exception 'stale LoL collection lease' using errcode = '40001';
  end if;

  insert into public.lol_data_sync_status(
    job_key,last_checked_at,last_fetch_succeeded_at,last_data_changed_at,last_success_at,
    consecutive_failures,counts,updated_at
  ) values (
    'mayhem-external:arammayhem',pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
    case when v_data_changed then pg_catalog.clock_timestamp() else null end,
    pg_catalog.clock_timestamp(),0,v_metadata->'counts',pg_catalog.clock_timestamp()
  )
  on conflict (job_key) do update set
    last_checked_at=excluded.last_checked_at,
    last_fetch_succeeded_at=excluded.last_fetch_succeeded_at,
    last_data_changed_at=case when v_data_changed then excluded.last_data_changed_at
      else public.lol_data_sync_status.last_data_changed_at end,
    last_success_at=excluded.last_success_at,
    last_error_code=null,
    consecutive_failures=0,
    counts=excluded.counts,
    updated_at=excluded.updated_at;

  return v_release_pk;
end
$$;

commit;
