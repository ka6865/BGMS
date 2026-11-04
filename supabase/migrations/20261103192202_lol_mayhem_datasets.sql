begin;
set local lock_timeout = '2s';

create table public.lol_mayhem_dataset_releases (
  id bigint generated always as identity primary key,
  source text not null default 'arammayhem' check (source = 'arammayhem'),
  upstream_release_id text not null check (length(btrim(upstream_release_id)) between 1 and 128),
  batch_hash text not null check (batch_hash ~ '^[0-9a-f]{64}$'),
  source_capture_hash text not null check (source_capture_hash ~ '^[0-9a-f]{64}$'),
  normalizer_version integer not null check (normalizer_version between 1 and 1000),
  mapping_revision integer not null default 1 check (mapping_revision between 1 and 100000),
  verified_client_patch text not null references public.lol_game_patches(client_patch),
  manifest_path text not null check (length(manifest_path) between 1 and 1024),
  metadata jsonb not null check (
    jsonb_typeof(metadata) = 'object'
    and octet_length(metadata::text) <= 262144
    and not (metadata ? 'leaseToken')
    and jsonb_typeof(metadata->'unknownExternalIds') = 'array'
    and jsonb_typeof(metadata->'unknown_count') = 'number'
    and (metadata->>'unknown_count')::numeric = jsonb_array_length(metadata->'unknownExternalIds')
    and jsonb_typeof(metadata->'counts') = 'object'
  ),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  review_action text check (review_action in ('approve','reject')),
  reviewed_by uuid references auth.users(id) on delete restrict,
  reviewed_at timestamptz,
  fetched_at timestamptz not null default pg_catalog.clock_timestamp(),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (source,batch_hash,source_capture_hash,normalizer_version,mapping_revision,verified_client_patch),
  unique (id,verified_client_patch),
  check (
    (status = 'pending' and review_action is null and reviewed_by is null and reviewed_at is null)
    or (status = 'approved' and review_action = 'approve' and reviewed_by is not null and reviewed_at is not null)
    or (status = 'rejected' and review_action = 'reject' and reviewed_by is not null and reviewed_at is not null)
  )
);

create table public.lol_mayhem_augment_mappings (
  source text not null default 'arammayhem' check (source = 'arammayhem'),
  external_id text not null check (length(btrim(external_id)) between 1 and 128 and external_id = btrim(external_id)),
  client_patch text not null references public.lol_game_patches(client_patch),
  platform_id integer not null check (platform_id > 0),
  mode_name text not null default 'KIWI' check (mode_name = 'KIWI'),
  status text not null check (status in ('approved','rejected')),
  evidence jsonb not null check (
    jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) between 2 and 16384
  ),
  reviewed_by uuid not null references auth.users(id) on delete restrict,
  reviewed_at timestamptz not null,
  primary key (source,external_id,client_patch),
  foreign key (platform_id,client_patch,mode_name)
    references public.lol_augment_patch_states(platform_id,client_patch,mode_name) on delete restrict
);

create table public.lol_mayhem_augment_pick_rates (
  release_id bigint not null references public.lol_mayhem_dataset_releases(id) on delete cascade,
  external_id text not null check (length(btrim(external_id)) between 1 and 128 and external_id = btrim(external_id)),
  platform_id integer not null check (platform_id > 0),
  source_client_patch text references public.lol_game_patches(client_patch),
  mapping_client_patch text not null references public.lol_game_patches(client_patch),
  mode_name text not null default 'KIWI' check (mode_name = 'KIWI'),
  pick_rate numeric(7,4) check (pick_rate is null or pick_rate between 0 and 100),
  pick_rate_rank integer check (pick_rate_rank is null or pick_rate_rank between 1 and 1000000),
  primary key (release_id,platform_id),
  unique (release_id,external_id),
  foreign key (platform_id,mapping_client_patch,mode_name)
    references public.lol_augment_patch_states(platform_id,client_patch,mode_name) on delete restrict
);

create table public.lol_mayhem_combos (
  release_id bigint not null,
  external_combo_id bigint not null check (external_combo_id > 0),
  champion_id integer not null check (champion_id between 1 and 100000),
  client_patch text not null references public.lol_game_patches(client_patch),
  mode_name text not null default 'KIWI' check (mode_name = 'KIWI'),
  editorial_tags text[] not null default '{}',
  source_url text not null check (
    length(source_url) between 1 and 2048 and source_url ~ '^https://(www[.])?arammayhem[.]com/'
  ),
  primary key (release_id,external_combo_id),
  unique (release_id,external_combo_id,client_patch),
  foreign key (release_id,client_patch)
    references public.lol_mayhem_dataset_releases(id,verified_client_patch) on delete cascade
);

create table public.lol_mayhem_combo_augments (
  release_id bigint not null,
  external_combo_id bigint not null,
  position smallint not null check (position between 1 and 12),
  external_id text not null check (length(btrim(external_id)) between 1 and 128),
  platform_id integer not null check (platform_id > 0),
  client_patch text not null,
  mode_name text not null default 'KIWI' check (mode_name = 'KIWI'),
  primary key (release_id,external_combo_id,position),
  unique (release_id,external_combo_id,platform_id),
  foreign key (release_id,external_combo_id,client_patch)
    references public.lol_mayhem_combos(release_id,external_combo_id,client_patch) on delete cascade,
  foreign key (platform_id,client_patch,mode_name)
    references public.lol_augment_patch_states(platform_id,client_patch,mode_name) on delete restrict
);

create table public.lol_mayhem_dataset_publications (
  source text not null default 'arammayhem' check (source = 'arammayhem'),
  client_patch text not null references public.lol_game_patches(client_patch),
  release_id bigint not null,
  previous_release_id bigint,
  published_at timestamptz not null default pg_catalog.clock_timestamp(),
  published_by uuid not null references auth.users(id) on delete restrict,
  primary key (source,client_patch),
  check (previous_release_id is null or previous_release_id <> release_id),
  foreign key (release_id,client_patch)
    references public.lol_mayhem_dataset_releases(id,verified_client_patch) on delete restrict,
  foreign key (previous_release_id,client_patch)
    references public.lol_mayhem_dataset_releases(id,verified_client_patch) on delete restrict
);

create table public.lol_data_sync_status (
  job_key text primary key check (length(btrim(job_key)) between 1 and 128),
  last_checked_at timestamptz,
  last_fetch_succeeded_at timestamptz,
  last_data_changed_at timestamptz,
  last_published_at timestamptz,
  last_success_at timestamptz,
  last_error_code text check (last_error_code is null or length(last_error_code) <= 128),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  counts jsonb not null default '{}'::jsonb check (
    jsonb_typeof(counts) = 'object' and octet_length(counts::text) <= 65536
  ),
  updated_at timestamptz not null default pg_catalog.clock_timestamp()
);

create function public.renew_lol_mayhem_dataset_lease(p_token uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_token is null then
    raise exception 'stale LoL collection lease' using errcode = '40001';
  end if;
  update public.lol_collection_leases
  set lease_until = pg_catalog.clock_timestamp() + interval '120 seconds'
  where lease_key='ops:lol-mayhem-external:arammayhem'
    and lease_type='collection' and lease_token=p_token
    and lease_until > pg_catalog.clock_timestamp();
  if not found then
    raise exception 'stale LoL collection lease' using errcode = '40001';
  end if;
end
$$;

create index lol_mayhem_releases_patch_status_idx
  on public.lol_mayhem_dataset_releases(verified_client_patch,status,fetched_at desc);
create index lol_mayhem_pick_rates_mapping_fk_idx
  on public.lol_mayhem_augment_pick_rates(platform_id,mapping_client_patch,mode_name);
create index lol_mayhem_pick_rates_source_patch_idx
  on public.lol_mayhem_augment_pick_rates(source_client_patch);
create index lol_mayhem_mappings_patch_idx
  on public.lol_mayhem_augment_mappings(client_patch);
create index lol_mayhem_mappings_reviewer_idx
  on public.lol_mayhem_augment_mappings(reviewed_by);
create index lol_mayhem_combos_champion_idx
  on public.lol_mayhem_combos(release_id,champion_id,external_combo_id);
create index lol_mayhem_combos_patch_fk_idx
  on public.lol_mayhem_combos(client_patch);
create index lol_mayhem_combo_augments_mapping_fk_idx
  on public.lol_mayhem_combo_augments(platform_id,client_patch,mode_name);
create index lol_mayhem_publications_release_idx
  on public.lol_mayhem_dataset_publications(release_id);
create index lol_mayhem_publications_previous_release_idx
  on public.lol_mayhem_dataset_publications(previous_release_id);
create index lol_mayhem_publications_patch_idx
  on public.lol_mayhem_dataset_publications(client_patch);
create index lol_mayhem_releases_reviewer_idx
  on public.lol_mayhem_dataset_releases(reviewed_by);

create function public.guard_lol_mayhem_dataset_mutation()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_row jsonb;
  v_release_id bigint;
  v_status text;
  v_old_status text;
  v_parent_patch text;
begin
  if tg_table_name = 'lol_mayhem_dataset_releases' then
    if tg_op = 'DELETE' then
      v_row := to_jsonb(old);
    else
      v_row := to_jsonb(new);
    end if;
    v_release_id := (v_row->>'id')::bigint;

    if tg_op <> 'INSERT' and old.status in ('approved','rejected') then
      raise exception 'reviewed LoL Mayhem release is immutable' using errcode = '55000';
    end if;
    if tg_op = 'UPDATE' and new.status <> old.status then
      if new.status = 'approved'
        and (new.review_action <> 'approve' or new.reviewed_by is null or new.reviewed_at is null
          or (new.metadata->>'unknown_count')::integer <> 0
          or new.metadata->'unknownExternalIds' <> '[]'::jsonb) then
        raise exception 'release approval requires a complete explicit review' using errcode = '55000';
      elsif new.status = 'rejected'
        and (new.review_action <> 'reject' or new.reviewed_by is null or new.reviewed_at is null) then
        raise exception 'release rejection requires a reviewer' using errcode = '55000';
      elsif new.status not in ('approved','rejected') then
        raise exception 'invalid release transition' using errcode = '55000';
      end if;
    end if;
  else
    if tg_op = 'DELETE' then
      v_row := to_jsonb(old);
    else
      v_row := to_jsonb(new);
    end if;
    v_release_id := (v_row->>'release_id')::bigint;
    if tg_op = 'UPDATE' and (to_jsonb(old)->>'release_id')::bigint is distinct from v_release_id then
      perform id from public.lol_mayhem_dataset_releases
      where id in ((to_jsonb(old)->>'release_id')::bigint,v_release_id)
      order by id for share;
    end if;
    select status into v_status
      from public.lol_mayhem_dataset_releases where id = v_release_id for share;
    if v_status is distinct from 'pending' then
      raise exception 'normalized LoL Mayhem release is immutable' using errcode = '55000';
    end if;
    if tg_op = 'UPDATE' then
      select status into v_old_status
      from public.lol_mayhem_dataset_releases where id=(to_jsonb(old)->>'release_id')::bigint for share;
      if v_old_status is distinct from 'pending' then
        raise exception 'source LoL Mayhem release is immutable' using errcode = '55000';
      end if;
    end if;
    if tg_op <> 'DELETE' and tg_table_name = 'lol_mayhem_combos' then
      select verified_client_patch into v_parent_patch
      from public.lol_mayhem_dataset_releases where id=v_release_id for share;
      if v_parent_patch is distinct from v_row->>'client_patch' then
        raise exception 'LoL Mayhem combo patch differs from release' using errcode = '23514';
      end if;
    elsif tg_op <> 'DELETE' and tg_table_name = 'lol_mayhem_combo_augments' then
      select client_patch into v_parent_patch
      from public.lol_mayhem_combos
      where release_id=v_release_id and external_combo_id=(v_row->>'external_combo_id')::bigint for share;
      if v_parent_patch is distinct from v_row->>'client_patch' then
        raise exception 'LoL Mayhem member patch differs from combo' using errcode = '23514';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger lol_mayhem_release_immutable
before update or delete on public.lol_mayhem_dataset_releases
for each row execute function public.guard_lol_mayhem_dataset_mutation();
create trigger lol_mayhem_pick_rates_immutable
before insert or update or delete on public.lol_mayhem_augment_pick_rates
for each row execute function public.guard_lol_mayhem_dataset_mutation();
create trigger lol_mayhem_combos_immutable
before insert or update or delete on public.lol_mayhem_combos
for each row execute function public.guard_lol_mayhem_dataset_mutation();
create trigger lol_mayhem_combo_augments_immutable
before insert or update or delete on public.lol_mayhem_combo_augments
for each row execute function public.guard_lol_mayhem_dataset_mutation();

do $$
declare v_table text;
begin
  foreach v_table in array array[
    'lol_mayhem_dataset_releases','lol_mayhem_augment_mappings','lol_mayhem_augment_pick_rates',
    'lol_mayhem_combos','lol_mayhem_combo_augments','lol_mayhem_dataset_publications','lol_data_sync_status'
  ] loop
    execute pg_catalog.format('alter table public.%I enable row level security',v_table);
    execute pg_catalog.format('revoke all on table public.%I from public,anon,authenticated',v_table);
    execute pg_catalog.format('grant all on table public.%I to service_role',v_table);
  end loop;
end
$$;
grant usage,select on sequence public.lol_mayhem_dataset_releases_id_seq to service_role;

create function public.ingest_lol_mayhem_dataset(
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
      or jsonb_array_length(c.value->'augmentIds') not between 1 and 12
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

create function public.review_lol_mayhem_dataset(
  p_id bigint,
  p_action text,
  p_reviewed_by uuid,
  p_expected_publication bigint default null,
  p_reason text default null
) returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_release public.lol_mayhem_dataset_releases;
  v_current_release bigint;
  v_previous_release bigint;
  v_official_patch text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_reason text := nullif(btrim(p_reason),'');
begin
  if p_id is null or p_id <= 0 or p_action is null or p_action not in ('approve','reject','publish','rollback')
    or p_reviewed_by is null
    or (p_expected_publication is not null and p_expected_publication <= 0)
    or (p_action='reject' and (v_reason is null or length(v_reason) not between 10 and 2048))
    or (p_action<>'reject' and p_reason is not null and length(v_reason) not between 1 and 2048) then
    raise exception 'invalid LoL Mayhem review request' using errcode = '22023';
  end if;

  select * into v_release from public.lol_mayhem_dataset_releases where id=p_id for update;
  if not found then raise exception 'LoL Mayhem release not found' using errcode = '22023'; end if;

  if p_action = 'approve' then
    if v_release.status <> 'pending'
      or (v_release.metadata->>'unknown_count')::integer <> 0
      or v_release.metadata->'unknownExternalIds' <> '[]'::jsonb then
      raise exception 'LoL Mayhem release is incomplete or already reviewed' using errcode = '55000';
    end if;
    update public.lol_mayhem_dataset_releases
      set status='approved',review_action='approve',reviewed_by=p_reviewed_by,reviewed_at=v_now
      where id=p_id;
    insert into public.admin_audit_events(actor_id,action,target_type,target_id,detail)
    values (p_reviewed_by,'lol.mayhem_dataset.approve','lol_mayhem_dataset_release',p_id::text,
      jsonb_build_object('patch',v_release.verified_client_patch,'releaseId',v_release.upstream_release_id,'reason',v_reason));
    return;
  elsif p_action = 'reject' then
    if v_release.status <> 'pending' then
      raise exception 'LoL Mayhem release is already reviewed' using errcode = '55000';
    end if;
    update public.lol_mayhem_dataset_releases
      set status='rejected',review_action='reject',reviewed_by=p_reviewed_by,reviewed_at=v_now,
        metadata=metadata || jsonb_build_object('reviewReason',v_reason)
      where id=p_id;
    insert into public.admin_audit_events(actor_id,action,target_type,target_id,detail)
    values (p_reviewed_by,'lol.mayhem_dataset.reject','lol_mayhem_dataset_release',p_id::text,
      jsonb_build_object('patch',v_release.verified_client_patch,'releaseId',v_release.upstream_release_id,'reason',v_reason));
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('lol-mayhem-publication'),
    pg_catalog.hashtext(v_release.verified_client_patch)
  );
  select release_id,previous_release_id into v_current_release,v_previous_release
  from public.lol_mayhem_dataset_publications
  where source='arammayhem' and client_patch=v_release.verified_client_patch
  for update;

  if v_current_release is distinct from p_expected_publication then
    raise exception 'LoL Mayhem publication compare-and-swap failed' using errcode = '40001';
  end if;
  if v_release.status <> 'approved'
    or (v_release.metadata->>'unknown_count')::integer <> 0
    or v_release.metadata->'unknownExternalIds' <> '[]'::jsonb then
    raise exception 'LoL Mayhem release is not publishable' using errcode = '55000';
  end if;
  select client_patch into v_official_patch
  from public.lol_augment_publication where singleton=true for share;
  if not found or v_official_patch is distinct from v_release.verified_client_patch
    or not exists (select 1 from public.lol_game_patches
      where client_patch=v_release.verified_client_patch and published_at is not null) then
    raise exception 'LoL Mayhem patch is not the current official publication' using errcode = '55000';
  end if;

  perform p.client_patch from public.lol_game_patches p
  where p.client_patch=v_release.verified_client_patch
    or exists (select 1 from public.lol_mayhem_augment_pick_rates r
      where r.release_id=p_id and r.mapping_client_patch=p.client_patch)
  for share of p;
  perform s.platform_id from public.lol_augment_patch_states s
  where exists (select 1 from public.lol_mayhem_augment_pick_rates r
      where r.release_id=p_id and r.platform_id=s.platform_id and r.mapping_client_patch=s.client_patch and r.mode_name=s.mode_name)
    or exists (select 1 from public.lol_mayhem_combo_augments m
      where m.release_id=p_id and m.platform_id=s.platform_id and m.client_patch=s.client_patch and m.mode_name=s.mode_name)
  for share of s;
  if exists (
    select 1 from public.lol_mayhem_augment_pick_rates r
    join public.lol_augment_patch_states s
      on s.platform_id=r.platform_id and s.client_patch=r.mapping_client_patch and s.mode_name=r.mode_name
    join public.lol_game_patches p on p.client_patch=s.client_patch
    where r.release_id=p_id and (not s.enabled or not s.in_pool or s.is_internal
      or s.state not in ('official_active','official_reenabled') or p.published_at is null)
  ) or exists (
    select 1 from public.lol_mayhem_combo_augments m
    join public.lol_augment_patch_states s
      on s.platform_id=m.platform_id and s.client_patch=m.client_patch and s.mode_name=m.mode_name
    where m.release_id=p_id and (not s.enabled or not s.in_pool or s.is_internal
      or s.state not in ('official_active','official_reenabled'))
  ) then
    raise exception 'LoL Mayhem release references a non-current official augment state' using errcode = '55000';
  end if;

  if p_action = 'rollback' then
    if v_current_release is null or v_previous_release is distinct from p_id then
      raise exception 'requested release is not the previous publication' using errcode = '55000';
    end if;
  elsif v_current_release = p_id then
    insert into public.admin_audit_events(actor_id,action,target_type,target_id,detail)
    values (p_reviewed_by,'lol.mayhem_dataset.publish','lol_mayhem_dataset_release',p_id::text,
      jsonb_build_object('patch',v_release.verified_client_patch,'releaseId',v_release.upstream_release_id,
        'expectedPublication',p_expected_publication,'reason',v_reason));
    return;
  end if;

  insert into public.lol_mayhem_dataset_publications(
    source,client_patch,release_id,previous_release_id,published_at,published_by
  ) values (
    'arammayhem',v_release.verified_client_patch,p_id,v_current_release,v_now,p_reviewed_by
  )
  on conflict (source,client_patch) do update set
    release_id=excluded.release_id,
    previous_release_id=excluded.previous_release_id,
    published_at=excluded.published_at,
    published_by=excluded.published_by;

  insert into public.lol_data_sync_status(
    job_key,last_published_at,last_success_at,consecutive_failures,updated_at
  ) values (
    'mayhem-external:arammayhem',v_now,v_now,0,v_now
  )
  on conflict (job_key) do update set
    last_published_at=excluded.last_published_at,
    last_success_at=excluded.last_success_at,
    last_error_code=null,
    consecutive_failures=0,
    updated_at=excluded.updated_at;

  insert into public.admin_audit_events(actor_id,action,target_type,target_id,detail)
  values (p_reviewed_by,'lol.mayhem_dataset.'||p_action,'lol_mayhem_dataset_release',p_id::text,
    jsonb_build_object('patch',v_release.verified_client_patch,'releaseId',v_release.upstream_release_id,
      'expectedPublication',p_expected_publication,'previousRelease',v_current_release,'reason',v_reason));
end
$$;

create function public.review_lol_mayhem_mapping(
  p_external_id text,
  p_patch text,
  p_platform_id integer,
  p_evidence jsonb,
  p_reviewed_by uuid
) returns void language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_external_id is null or length(btrim(p_external_id)) not between 1 and 128
    or p_external_id <> btrim(p_external_id)
    or p_patch is null or p_patch !~ '^(15|16)\.[1-9][0-9]?$'
    or p_platform_id is null or p_platform_id <= 0
    or p_reviewed_by is null
    or p_evidence is null or jsonb_typeof(p_evidence) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_evidence)) <> 1
    or jsonb_typeof(p_evidence->'note') is distinct from 'string'
    or length(btrim(p_evidence->>'note')) not between 1 and 2000
    or octet_length(p_evidence::text) > 4096 then
    raise exception 'invalid LoL Mayhem mapping review request' using errcode = '22023';
  end if;

  insert into public.lol_mayhem_augment_mappings(
    source,external_id,client_patch,platform_id,status,evidence,reviewed_by,reviewed_at
  ) values (
    'arammayhem',p_external_id,p_patch,p_platform_id,'approved',p_evidence,p_reviewed_by,v_now
  ) on conflict (source,external_id,client_patch) do update set
    platform_id=excluded.platform_id,
    status=excluded.status,
    evidence=excluded.evidence,
    reviewed_by=excluded.reviewed_by,
    reviewed_at=excluded.reviewed_at;

  insert into public.admin_audit_events(actor_id,action,target_type,target_id,detail)
  values (p_reviewed_by,'lol.mayhem_mapping.upsert','lol_mayhem_mapping',
    'arammayhem:'||p_patch||':'||p_external_id,
    jsonb_build_object('externalId',p_external_id,'patch',p_patch,'platformId',p_platform_id,'evidence',p_evidence));
end
$$;

revoke all on function public.guard_lol_mayhem_dataset_mutation(),
  public.ingest_lol_mayhem_dataset(text,text,text,text,jsonb,jsonb,jsonb),
  public.review_lol_mayhem_dataset(bigint,text,uuid,bigint,text),
  public.review_lol_mayhem_mapping(text,text,integer,jsonb,uuid),
  public.renew_lol_mayhem_dataset_lease(uuid)
  from public,anon,authenticated;
grant execute on function public.guard_lol_mayhem_dataset_mutation(),
  public.ingest_lol_mayhem_dataset(text,text,text,text,jsonb,jsonb,jsonb),
  public.review_lol_mayhem_dataset(bigint,text,uuid,bigint,text),
  public.review_lol_mayhem_mapping(text,text,integer,jsonb,uuid),
  public.renew_lol_mayhem_dataset_lease(uuid)
  to service_role;

commit;
