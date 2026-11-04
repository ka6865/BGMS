begin;
set local lock_timeout = '2s';

create table public.lol_mayhem_champion_dataset_releases (
  id bigint generated always as identity primary key,
  source text not null default 'champion_api_v1' check (source = 'champion_api_v1'),
  client_patch text not null references public.lol_game_patches(client_patch),
  cohort text not null default 'source_default' check (cohort = 'source_default'),
  upstream_version text not null check (length(btrim(upstream_version)) between 1 and 64),
  source_data_date date not null,
  capture_hash text not null check (capture_hash ~ '^[0-9a-f]{64}$'),
  manifest_path text not null check (length(manifest_path) between 1 and 256),
  normalizer_version integer not null default 1 check (normalizer_version = 1),
  catalog_hash text not null check (catalog_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  metadata jsonb not null check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 262144),
  review_action text check (review_action in ('approve','reject')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  fetched_at timestamptz not null default pg_catalog.clock_timestamp(),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (source,client_patch,cohort,capture_hash,normalizer_version),
  unique (id,source,client_patch,cohort),
  check (
    (status = 'pending' and review_action is null and reviewed_by is null and reviewed_at is null)
    or (status = 'approved' and review_action = 'approve' and reviewed_by is not null and reviewed_at is not null)
    or (status = 'rejected' and review_action = 'reject' and reviewed_by is not null and reviewed_at is not null)
  )
);

create table public.lol_mayhem_champion_dataset_publications (
  source text not null default 'champion_api_v1' check (source = 'champion_api_v1'),
  client_patch text not null references public.lol_game_patches(client_patch),
  cohort text not null default 'source_default' check (cohort = 'source_default'),
  release_id bigint not null,
  previous_release_id bigint,
  published_at timestamptz not null default pg_catalog.clock_timestamp(),
  published_by uuid not null,
  primary key (source,client_patch,cohort),
  check (previous_release_id is null or previous_release_id <> release_id),
  foreign key (release_id,source,client_patch,cohort)
    references public.lol_mayhem_champion_dataset_releases(id,source,client_patch,cohort) on delete restrict,
  foreign key (previous_release_id,source,client_patch,cohort)
    references public.lol_mayhem_champion_dataset_releases(id,source,client_patch,cohort) on delete restrict
);

create index lol_mayhem_champion_releases_patch_status_idx
  on public.lol_mayhem_champion_dataset_releases(client_patch,status,fetched_at desc);
create index lol_mayhem_champion_releases_reviewer_idx
  on public.lol_mayhem_champion_dataset_releases(reviewed_by);
create index lol_mayhem_champion_publications_release_idx
  on public.lol_mayhem_champion_dataset_publications(release_id);
create index lol_mayhem_champion_publications_previous_idx
  on public.lol_mayhem_champion_dataset_publications(previous_release_id);

alter table public.lol_mayhem_champion_dataset_releases enable row level security;
alter table public.lol_mayhem_champion_dataset_publications enable row level security;
revoke all on public.lol_mayhem_champion_dataset_releases, public.lol_mayhem_champion_dataset_publications from public,anon,authenticated;
grant select,insert,update,delete on public.lol_mayhem_champion_dataset_releases, public.lol_mayhem_champion_dataset_publications to service_role;
grant usage,select on sequence public.lol_mayhem_champion_dataset_releases_id_seq to service_role;

create function public.get_lol_mayhem_champion_storage_bytes()
returns bigint language plpgsql stable security invoker set search_path = '' as $$
declare v_size text; v_total numeric := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  for v_size in
    select o.metadata->>'size'
    from storage.objects o
    where o.bucket_id='lol-augment-snapshots'
      and o.name like 'external/champion-stats/champion_api_v1/%'
  loop
    if v_size is null or v_size !~ '^(0|[1-9][0-9]*)$' then
      raise exception 'invalid champion dataset storage size metadata' using errcode = '22023';
    end if;
    v_total := v_total + v_size::numeric;
    if v_total > 9223372036854775807 then
      raise exception 'champion dataset storage size overflow' using errcode = '22003';
    end if;
  end loop;
  return v_total::bigint;
end
$$;

create function public.renew_lol_mayhem_champion_dataset_lease(p_token uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_token is null then raise exception 'stale champion dataset lease' using errcode = 'PT409'; end if;
  update public.lol_collection_leases
  set lease_until=pg_catalog.clock_timestamp()+interval '120 seconds'
  where lease_key='ops:lol-mayhem-champion:champion_api_v1'
    and lease_type='collection' and lease_token=p_token and lease_until>pg_catalog.clock_timestamp();
  if not found then raise exception 'stale champion dataset lease' using errcode = 'PT409'; end if;
end
$$;

create function public.ingest_lol_mayhem_champion_dataset(p_candidate jsonb,p_token uuid)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare
  v_patch text; v_version text; v_date date; v_capture text; v_manifest_path text; v_catalog text;
  v_metadata jsonb; v_files jsonb; v_expected jsonb; v_file_count integer;
  v_total_bytes numeric := 0; v_entry jsonb; v_id bigint; v_now timestamptz := pg_catalog.clock_timestamp();
  v_lease_until timestamptz; v_current_ids jsonb; v_current_hash text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_candidate is null or jsonb_typeof(p_candidate) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_candidate)) <> 7
    or not (p_candidate ?& array['clientPatch','upstreamVersion','sourceDataDate','captureHash','manifestPath','catalogHash','metadata'])
    or jsonb_typeof(p_candidate->'clientPatch') is distinct from 'string'
    or jsonb_typeof(p_candidate->'upstreamVersion') is distinct from 'string'
    or jsonb_typeof(p_candidate->'sourceDataDate') is distinct from 'string'
    or jsonb_typeof(p_candidate->'captureHash') is distinct from 'string'
    or jsonb_typeof(p_candidate->'manifestPath') is distinct from 'string'
    or jsonb_typeof(p_candidate->'catalogHash') is distinct from 'string'
    or jsonb_typeof(p_candidate->'metadata') is distinct from 'object' then
    raise exception 'invalid champion dataset candidate' using errcode = '22023';
  end if;
  v_patch:=p_candidate->>'clientPatch'; v_version:=p_candidate->>'upstreamVersion'; v_date:=(p_candidate->>'sourceDataDate')::date;
  v_capture:=p_candidate->>'captureHash'; v_manifest_path:=p_candidate->>'manifestPath'; v_catalog:=p_candidate->>'catalogHash';
  v_metadata:=p_candidate->'metadata'; v_files:=v_metadata->'files'; v_expected:=v_metadata->'expectedChampionIds';
  if v_patch !~ '^(15|16)\.[1-9][0-9]?$' or v_version !~ ('^' || v_patch || '\.[0-9]+$')
    or length(v_version)>64 or v_capture !~ '^[0-9a-f]{64}$' or v_catalog !~ '^[0-9a-f]{64}$'
    or v_manifest_path <> ('external/champion-stats/champion_api_v1/captures/' || v_capture || '/manifest.json')
    or length(v_manifest_path)>256 or octet_length(v_metadata::text)>262144
    or jsonb_typeof(v_metadata->'schemaVersion') is distinct from 'number' or v_metadata->>'schemaVersion'<>'1'
    or v_metadata->>'source'<>'champion_api_v1' or v_metadata->>'cohort'<>'source_default'
    or v_metadata->>'clientPatch' is distinct from v_patch or v_metadata->>'upstreamVersion' is distinct from v_version
    or v_metadata->>'sourceDataDate' is distinct from (v_date::text) or v_metadata->>'catalogHash' is distinct from v_catalog
    or jsonb_typeof(v_metadata->'normalizerVersion') is distinct from 'number' or v_metadata->>'normalizerVersion'<>'1'
    or jsonb_typeof(v_metadata->'attribution') is distinct from 'string' or length(btrim(v_metadata->>'attribution')) not between 1 and 512
    or jsonb_typeof(v_metadata->'rightsBasis') is distinct from 'string' or length(btrim(v_metadata->>'rightsBasis')) not between 10 and 2048
    or jsonb_typeof(v_expected) is distinct from 'array' or jsonb_array_length(v_expected) not between 1 and 1000
    or jsonb_typeof(v_files) is distinct from 'array' or jsonb_array_length(v_files) <> jsonb_array_length(v_expected)
    or (select count(*) from jsonb_object_keys(v_metadata))<>12
    or not (v_metadata ?& array['schemaVersion','source','cohort','clientPatch','upstreamVersion','sourceDataDate','catalogHash','expectedChampionIds','files','attribution','rightsBasis','normalizerVersion']) then
    raise exception 'invalid champion dataset manifest' using errcode = '22023';
  end if;
  if not exists(select 1 from public.lol_game_patches where client_patch=v_patch) then
    raise exception 'unverified LoL patch' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_expected) e(value)
    where jsonb_typeof(e.value) is distinct from 'number' or (e.value#>>'{}') !~ '^[1-9][0-9]{0,8}$'
  ) or (select count(distinct value) from jsonb_array_elements(v_expected))<>jsonb_array_length(v_expected)
    or (select count(distinct (f.value->>'championId')::integer) from jsonb_array_elements(v_files) f(value))<>jsonb_array_length(v_files) then
    raise exception 'invalid or duplicate champion ids' using errcode = '22023';
  end if;
  for v_entry in select value from jsonb_array_elements(v_files) loop
    if jsonb_typeof(v_entry) is distinct from 'object' or (select count(*) from jsonb_object_keys(v_entry))<>7
      or not (v_entry ?& array['championId','rawPath','rawHash','rawBytes','normalizedPath','normalizedHash','normalizedBytes'])
      or jsonb_typeof(v_entry->'championId') is distinct from 'number'
      or not (v_entry->>'championId')::integer = any(array(select (x.value#>>'{}')::integer from jsonb_array_elements(v_expected) x(value)))
      or jsonb_typeof(v_entry->'rawHash') is distinct from 'string' or v_entry->>'rawHash' !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(v_entry->'normalizedHash') is distinct from 'string' or v_entry->>'normalizedHash' !~ '^[0-9a-f]{64}$'
      or v_entry->>'rawPath' <> ('external/champion-stats/champion_api_v1/objects/' || (v_entry->>'rawHash') || '.json')
      or v_entry->>'normalizedPath' <> ('external/champion-stats/champion_api_v1/objects/' || (v_entry->>'normalizedHash') || '.json')
      or jsonb_typeof(v_entry->'rawBytes') is distinct from 'number' or (v_entry->>'rawBytes')::numeric not between 1 and 2097152
      or trunc((v_entry->>'rawBytes')::numeric)<>(v_entry->>'rawBytes')::numeric
      or jsonb_typeof(v_entry->'normalizedBytes') is distinct from 'number' or (v_entry->>'normalizedBytes')::numeric not between 1 and 2097152
      or trunc((v_entry->>'normalizedBytes')::numeric)<>(v_entry->>'normalizedBytes')::numeric then
      raise exception 'invalid champion dataset file manifest' using errcode = '22023';
    end if;
    v_total_bytes:=v_total_bytes+(v_entry->>'rawBytes')::numeric+(v_entry->>'normalizedBytes')::numeric;
  end loop;
  if v_total_bytes>67108864
    or exists(select 1 from jsonb_array_elements(v_expected) e(value) where not exists(
      select 1 from jsonb_array_elements(v_files) f(value) where f.value->'championId'=e.value)) then
    raise exception 'incomplete or oversized champion dataset manifest' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(s.platform_id order by s.platform_id),'[]'::jsonb) into v_current_ids
  from public.lol_augment_patch_states s where s.client_patch=v_patch and s.mode_name='KIWI' and s.in_pool;
  v_current_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(replace(v_current_ids::text,', ',','),'UTF8')),'hex');
  if v_current_hash<>v_catalog then
    raise exception 'stale champion augment catalog' using errcode = 'PT409';
  end if;
  select lease_until into v_lease_until from public.lol_collection_leases
  where lease_key='ops:lol-mayhem-champion:champion_api_v1' and lease_type='collection' and lease_token=p_token for update;
  if not found or v_lease_until<=pg_catalog.clock_timestamp() then raise exception 'stale champion dataset lease' using errcode = 'PT409'; end if;

  insert into public.lol_mayhem_champion_dataset_releases(
    client_patch,upstream_version,source_data_date,capture_hash,manifest_path,catalog_hash,metadata
  ) values(v_patch,v_version,v_date,v_capture,v_manifest_path,v_catalog,v_metadata)
  on conflict(source,client_patch,cohort,capture_hash,normalizer_version) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.lol_mayhem_champion_dataset_releases
    where source='champion_api_v1' and client_patch=v_patch and cohort='source_default'
      and capture_hash=v_capture and normalizer_version=1 for update;
    if not found then raise exception 'champion dataset ingest conflict' using errcode = 'PT409'; end if;
  end if;
  v_file_count:=jsonb_array_length(v_files);
  insert into public.lol_data_sync_status(job_key,last_checked_at,last_fetch_succeeded_at,last_data_changed_at,last_success_at,
    consecutive_failures,counts,updated_at)
  values('mayhem-champion:champion_api_v1',v_now,v_now,v_now,v_now,0,
        jsonb_build_object('files',v_file_count,'bytes',v_total_bytes),v_now)
  on conflict(job_key) do update set last_checked_at=excluded.last_checked_at,last_fetch_succeeded_at=excluded.last_fetch_succeeded_at,
    last_data_changed_at=excluded.last_data_changed_at,last_success_at=excluded.last_success_at,last_error_code=null,
    consecutive_failures=0,counts=excluded.counts,updated_at=excluded.updated_at;
  return v_id;
end
$$;

create function public.review_lol_mayhem_champion_dataset(
  p_id bigint,p_action text,p_expected_publication bigint,p_reviewed_by uuid,p_reason text default null
) returns void language plpgsql security invoker set search_path = '' as $$
declare v_release public.lol_mayhem_champion_dataset_releases; v_current bigint; v_previous bigint; v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_id is null or p_id<=0 or p_action not in ('approve','reject','publish','rollback') or p_reviewed_by is null
    or (p_expected_publication is not null and p_expected_publication<=0)
    or (p_action='reject' and length(btrim(p_reason)) not between 10 and 2048)
    or (p_action<>'reject' and p_reason is not null and length(btrim(p_reason)) not between 1 and 2048) then
    raise exception 'invalid champion dataset review request' using errcode = '22023';
  end if;
  select * into v_release from public.lol_mayhem_champion_dataset_releases where id=p_id for update;
  if not found then raise exception 'champion dataset release not found' using errcode = '22023'; end if;
  if p_action='approve' or p_action='reject' then
    if v_release.status<>'pending' then raise exception 'champion dataset already reviewed' using errcode = '55000'; end if;
    if p_action='approve' then
      if v_release.metadata->>'attribution' is null or length(btrim(v_release.metadata->>'rightsBasis'))<10
        or jsonb_array_length(v_release.metadata->'files')<>jsonb_array_length(v_release.metadata->'expectedChampionIds')
        or exists(select 1 from jsonb_array_elements(v_release.metadata->'expectedChampionIds') e(value)
          where not exists(select 1 from jsonb_array_elements(v_release.metadata->'files') f(value)
            where f.value->'championId'=e.value))
        or v_release.catalog_hash<>(select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(replace(
          coalesce((select jsonb_agg(s.platform_id order by s.platform_id) from public.lol_augment_patch_states s
            where s.client_patch=v_release.client_patch and s.mode_name='KIWI' and s.in_pool),'[]'::jsonb)::text,', ',','),'UTF8')),'hex'))
        then
        raise exception 'champion dataset approval validation failed' using errcode = '55000';
      end if;
    end if;
    update public.lol_mayhem_champion_dataset_releases set status=case when p_action='approve' then 'approved' else 'rejected' end,
      review_action=p_action,reviewed_by=p_reviewed_by,reviewed_at=v_now where id=p_id;
    insert into public.admin_audit_events(actor_id,action,target_type,target_id,detail)
    values(p_reviewed_by,'lol.mayhem_champion_dataset.'||p_action,'lol_mayhem_champion_dataset_release',p_id::text,
      jsonb_build_object('clientPatch',v_release.client_patch,'captureHash',v_release.capture_hash,'reason',p_reason));
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lol-mayhem-champion:'||v_release.client_patch,0));
  select release_id into v_current from public.lol_mayhem_champion_dataset_publications
  where source='champion_api_v1' and client_patch=v_release.client_patch and cohort='source_default' for update;
  if p_action='publish' then
    if v_release.status<>'approved' then raise exception 'champion dataset is not approved' using errcode = '55000'; end if;
    if v_current is distinct from p_expected_publication then raise exception 'champion dataset publication conflict' using errcode = 'PT409'; end if;
    v_previous:=v_current;
    insert into public.lol_mayhem_champion_dataset_publications(source,client_patch,cohort,release_id,previous_release_id,published_by,published_at)
    values('champion_api_v1',v_release.client_patch,'source_default',p_id,v_previous,p_reviewed_by,v_now)
    on conflict(source,client_patch,cohort) do update set release_id=excluded.release_id,previous_release_id=excluded.previous_release_id,
      published_by=excluded.published_by,published_at=excluded.published_at;
  else
    if v_current is distinct from p_expected_publication then raise exception 'champion dataset rollback conflict' using errcode = 'PT409'; end if;
    select previous_release_id into v_previous from public.lol_mayhem_champion_dataset_publications
    where source='champion_api_v1' and client_patch=v_release.client_patch and cohort='source_default';
    if v_previous is null then
      delete from public.lol_mayhem_champion_dataset_publications where source='champion_api_v1' and client_patch=v_release.client_patch and cohort='source_default';
    elsif not exists(select 1 from public.lol_mayhem_champion_dataset_releases where id=v_previous and status='approved') then
      raise exception 'previous champion dataset is not approved' using errcode = '55000';
    else
      update public.lol_mayhem_champion_dataset_publications set release_id=v_previous,previous_release_id=null,
        published_by=p_reviewed_by,published_at=v_now where source='champion_api_v1' and client_patch=v_release.client_patch and cohort='source_default';
    end if;
  end if;
  insert into public.admin_audit_events(actor_id,action,target_type,target_id,detail)
  values(p_reviewed_by,'lol.mayhem_champion_dataset.'||p_action,'lol_mayhem_champion_dataset_release',p_id::text,
    jsonb_build_object('clientPatch',v_release.client_patch,'expectedPublication',p_expected_publication,'releaseId',p_id,'reason',p_reason));
end
$$;

revoke all on function public.get_lol_mayhem_champion_storage_bytes(),
  public.renew_lol_mayhem_champion_dataset_lease(uuid),public.ingest_lol_mayhem_champion_dataset(jsonb,uuid),
  public.review_lol_mayhem_champion_dataset(bigint,text,bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.get_lol_mayhem_champion_storage_bytes(),
  public.renew_lol_mayhem_champion_dataset_lease(uuid),public.ingest_lol_mayhem_champion_dataset(jsonb,uuid),
  public.review_lol_mayhem_champion_dataset(bigint,text,bigint,uuid,text) to service_role;
commit;
