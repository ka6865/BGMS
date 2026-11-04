begin;
set local lock_timeout = '2s';

create table public.lol_mayhem_reference_releases (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('champion_tiers','item_ratings','augment_rankings')),
  source text not null check (
    (kind='champion_tiers' and source='aramgg') or
    (kind='item_ratings' and source='iesdev') or
    (kind='augment_rankings' and source='arammayhem')
  ),
  client_patch text not null check (client_patch ~ '^(15|16)\.[1-9][0-9]?$'),
  champion_id integer not null check (
    (kind='item_ratings' and champion_id between 1 and 99999) or
    (kind in ('champion_tiers','augment_rankings') and champion_id=0)
  ),
  upstream_version text not null check (length(btrim(upstream_version)) between 1 and 128),
  source_data_date date not null,
  raw_hash text not null check (raw_hash ~ '^[0-9a-f]{64}$'),
  normalized_hash text not null check (normalized_hash ~ '^[0-9a-f]{64}$'),
  raw_path text not null check (raw_path = 'external/mayhem-reference/objects/' || raw_hash || '.json'),
  normalized_path text not null check (normalized_path = 'external/mayhem-reference/objects/' || normalized_hash || '.json'),
  raw_bytes integer not null check (raw_bytes between 1 and 2097152),
  normalized_bytes integer not null check (normalized_bytes between 1 and 2097152),
  attribution text not null check (length(btrim(attribution)) between 1 and 512),
  rights_basis text not null check (length(btrim(rights_basis)) between 10 and 2048),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  review_action text check (review_action in ('approve','reject')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  fetched_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (kind,client_patch,champion_id,raw_hash,normalized_hash),
  unique (id,kind,client_patch,champion_id),
  check (
    (status='pending' and review_action is null and reviewed_by is null and reviewed_at is null) or
    (status='approved' and review_action='approve' and reviewed_by is not null and reviewed_at is not null) or
    (status='rejected' and review_action='reject' and reviewed_by is not null and reviewed_at is not null)
  )
);

create table public.lol_mayhem_reference_publications (
  kind text not null check (kind in ('champion_tiers','item_ratings','augment_rankings')),
  client_patch text not null check (client_patch ~ '^(15|16)\.[1-9][0-9]?$'),
  champion_id integer not null,
  release_id bigint not null,
  previous_release_id bigint,
  published_at timestamptz not null default pg_catalog.clock_timestamp(),
  published_by uuid not null,
  primary key (kind,client_patch,champion_id),
  check ((kind='item_ratings' and champion_id between 1 and 99999) or
    (kind in ('champion_tiers','augment_rankings') and champion_id=0)),
  check (previous_release_id is null or previous_release_id <> release_id),
  foreign key (release_id,kind,client_patch,champion_id)
    references public.lol_mayhem_reference_releases(id,kind,client_patch,champion_id) on delete restrict,
  foreign key (previous_release_id,kind,client_patch,champion_id)
    references public.lol_mayhem_reference_releases(id,kind,client_patch,champion_id) on delete restrict
);

create index lol_mayhem_reference_releases_lookup_idx
  on public.lol_mayhem_reference_releases(kind,client_patch,champion_id,status,fetched_at desc);
create index lol_mayhem_reference_publications_release_idx
  on public.lol_mayhem_reference_publications(release_id);
create index lol_mayhem_reference_publications_previous_idx
  on public.lol_mayhem_reference_publications(previous_release_id);

alter table public.lol_mayhem_reference_releases enable row level security;
alter table public.lol_mayhem_reference_publications enable row level security;
revoke all on public.lol_mayhem_reference_releases,public.lol_mayhem_reference_publications from public,anon,authenticated;
grant select,insert,update,delete on public.lol_mayhem_reference_releases,public.lol_mayhem_reference_publications to service_role;
grant usage,select on sequence public.lol_mayhem_reference_releases_id_seq to service_role;

create function public.prevent_lol_mayhem_reference_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if row(new.kind,new.source,new.client_patch,new.champion_id,new.upstream_version,new.source_data_date,
      new.raw_hash,new.normalized_hash,new.raw_path,new.normalized_path,new.raw_bytes,new.normalized_bytes,
      new.attribution,new.rights_basis,new.fetched_at)
    is distinct from
     row(old.kind,old.source,old.client_patch,old.champion_id,old.upstream_version,old.source_data_date,
      old.raw_hash,old.normalized_hash,old.raw_path,old.normalized_path,old.raw_bytes,old.normalized_bytes,
      old.attribution,old.rights_basis,old.fetched_at) then
    raise exception 'LoL Mayhem reference snapshot metadata is immutable' using errcode = '55000';
  end if;
  return new;
end
$$;

create trigger lol_mayhem_reference_metadata_immutable
before update on public.lol_mayhem_reference_releases
for each row execute function public.prevent_lol_mayhem_reference_mutation();

create function public.renew_lol_mayhem_reference_lease(p_token uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_token is null then raise exception 'stale LoL Mayhem reference lease' using errcode = 'PT409'; end if;
  update public.lol_collection_leases set lease_until=pg_catalog.clock_timestamp()+interval '120 seconds'
  where lease_key='ops:lol-mayhem-reference' and lease_type='collection' and lease_token=p_token
    and lease_until>pg_catalog.clock_timestamp();
  if not found then raise exception 'stale LoL Mayhem reference lease' using errcode = 'PT409'; end if;
end
$$;

create function public.ingest_lol_mayhem_reference(p_candidate jsonb,p_token uuid)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare
  v_kind text; v_source text; v_patch text; v_champion integer; v_version text; v_date date;
  v_raw_hash text; v_normalized_hash text; v_raw_path text; v_normalized_path text;
  v_raw_bytes integer; v_normalized_bytes integer; v_attribution text; v_rights text;
  v_id bigint; v_size text; v_lease_until timestamptz;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_candidate is null or jsonb_typeof(p_candidate) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_candidate))<>14
    or not (p_candidate ?& array['kind','source','clientPatch','championId','upstreamVersion','sourceDataDate',
      'rawHash','normalizedHash','rawPath','normalizedPath','rawBytes','normalizedBytes','attribution','rightsBasis'])
    or jsonb_typeof(p_candidate->'kind') is distinct from 'string'
    or jsonb_typeof(p_candidate->'source') is distinct from 'string'
    or jsonb_typeof(p_candidate->'clientPatch') is distinct from 'string'
    or jsonb_typeof(p_candidate->'championId') is distinct from 'number'
    or jsonb_typeof(p_candidate->'upstreamVersion') is distinct from 'string'
    or jsonb_typeof(p_candidate->'sourceDataDate') is distinct from 'string'
    or jsonb_typeof(p_candidate->'rawHash') is distinct from 'string'
    or jsonb_typeof(p_candidate->'normalizedHash') is distinct from 'string'
    or jsonb_typeof(p_candidate->'rawPath') is distinct from 'string'
    or jsonb_typeof(p_candidate->'normalizedPath') is distinct from 'string'
    or jsonb_typeof(p_candidate->'rawBytes') is distinct from 'number'
    or jsonb_typeof(p_candidate->'normalizedBytes') is distinct from 'number'
    or jsonb_typeof(p_candidate->'attribution') is distinct from 'string'
    or jsonb_typeof(p_candidate->'rightsBasis') is distinct from 'string' then
    raise exception 'invalid LoL Mayhem reference candidate' using errcode = '22023';
  end if;
  v_kind:=p_candidate->>'kind'; v_source:=p_candidate->>'source'; v_patch:=p_candidate->>'clientPatch';
  if (p_candidate->>'championId') !~ '^(0|[1-9][0-9]{0,4})$'
    or (p_candidate->>'rawBytes') !~ '^[1-9][0-9]{0,6}$'
    or (p_candidate->>'normalizedBytes') !~ '^[1-9][0-9]{0,6}$'
    or (p_candidate->>'sourceDataDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'invalid LoL Mayhem reference candidate values' using errcode = '22023';
  end if;
  v_champion:=(p_candidate->>'championId')::integer;
  v_version:=p_candidate->>'upstreamVersion';
  begin v_date:=(p_candidate->>'sourceDataDate')::date;
  exception when others then raise exception 'invalid LoL Mayhem source data date' using errcode = '22023'; end;
  v_raw_hash:=p_candidate->>'rawHash'; v_normalized_hash:=p_candidate->>'normalizedHash';
  v_raw_path:=p_candidate->>'rawPath'; v_normalized_path:=p_candidate->>'normalizedPath';
  v_raw_bytes:=(p_candidate->>'rawBytes')::integer; v_normalized_bytes:=(p_candidate->>'normalizedBytes')::integer;
  v_attribution:=p_candidate->>'attribution'; v_rights:=p_candidate->>'rightsBasis';
  if v_kind not in ('champion_tiers','item_ratings','augment_rankings')
    or v_source is distinct from (case v_kind when 'champion_tiers' then 'aramgg'
      when 'item_ratings' then 'iesdev' when 'augment_rankings' then 'arammayhem' end)
    or v_patch !~ '^(15|16)\.[1-9][0-9]?$'
    or (v_kind='item_ratings' and v_champion not between 1 and 99999)
    or (v_kind in ('champion_tiers','augment_rankings') and v_champion<>0)
    or length(btrim(v_version)) not between 1 and 128
    or v_raw_hash !~ '^[0-9a-f]{64}$' or v_normalized_hash !~ '^[0-9a-f]{64}$'
    or v_raw_path <> 'external/mayhem-reference/objects/'||v_raw_hash||'.json'
    or v_normalized_path <> 'external/mayhem-reference/objects/'||v_normalized_hash||'.json'
    or v_raw_bytes not between 1 and 2097152 or v_normalized_bytes not between 1 and 2097152
    or length(btrim(v_attribution)) not between 1 and 512 or length(btrim(v_rights)) not between 10 and 2048 then
    raise exception 'invalid LoL Mayhem reference candidate values' using errcode = '22023';
  end if;
  for v_size in
    select o.metadata->>'size' from storage.objects o
    where o.bucket_id='lol-augment-snapshots' and o.name in (v_raw_path,v_normalized_path)
  loop
    if v_size is null or v_size !~ '^(0|[1-9][0-9]*)$' then
      raise exception 'invalid LoL Mayhem reference storage size metadata' using errcode = '22023';
    end if;
  end loop;
  if (select count(*) from storage.objects o where o.bucket_id='lol-augment-snapshots'
      and o.name in (v_raw_path,v_normalized_path)) < (case when v_raw_path=v_normalized_path then 1 else 2 end)
    or exists (select 1 from storage.objects o where o.bucket_id='lol-augment-snapshots'
      and o.name=v_raw_path and (o.metadata->>'size')::numeric<>v_raw_bytes)
    or exists (select 1 from storage.objects o where o.bucket_id='lol-augment-snapshots'
      and o.name=v_normalized_path and (o.metadata->>'size')::numeric<>v_normalized_bytes) then
    raise exception 'LoL Mayhem reference object missing or size mismatch' using errcode = '22023';
  end if;
  select lease_until into v_lease_until from public.lol_collection_leases
  where lease_key='ops:lol-mayhem-reference' and lease_type='collection' and lease_token=p_token for update;
  if not found or v_lease_until<=pg_catalog.clock_timestamp() then
    raise exception 'stale LoL Mayhem reference lease' using errcode = 'PT409';
  end if;
  insert into public.lol_mayhem_reference_releases(kind,source,client_patch,champion_id,upstream_version,
    source_data_date,raw_hash,normalized_hash,raw_path,normalized_path,raw_bytes,normalized_bytes,attribution,rights_basis)
  values(v_kind,v_source,v_patch,v_champion,v_version,v_date,v_raw_hash,v_normalized_hash,v_raw_path,
    v_normalized_path,v_raw_bytes,v_normalized_bytes,v_attribution,v_rights)
  on conflict(kind,client_patch,champion_id,raw_hash,normalized_hash) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.lol_mayhem_reference_releases
    where kind=v_kind and client_patch=v_patch and champion_id=v_champion and raw_hash=v_raw_hash and normalized_hash=v_normalized_hash;
    if not found then raise exception 'LoL Mayhem reference ingest conflict' using errcode = 'PT409'; end if;
  end if;
  return v_id;
end
$$;

create function public.review_lol_mayhem_reference(
  p_id bigint,p_action text,p_expected_publication bigint,p_reviewed_by uuid,p_reason text default null
) returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_release public.lol_mayhem_reference_releases; v_current bigint; v_previous bigint;
  v_now timestamptz:=pg_catalog.clock_timestamp(); v_reason text:=nullif(btrim(p_reason),'');
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_id is null or p_id<=0 or p_action is null or p_action not in ('approve','reject','publish','rollback')
    or p_reviewed_by is null or (p_expected_publication is not null and p_expected_publication<=0)
    or (p_action='reject' and (v_reason is null or length(v_reason) not between 10 and 2048))
    or (p_action<>'reject' and p_reason is not null and length(v_reason) not between 1 and 2048) then
    raise exception 'invalid LoL Mayhem reference review request' using errcode = '22023';
  end if;
  select * into v_release from public.lol_mayhem_reference_releases where id=p_id for update;
  if not found then raise exception 'LoL Mayhem reference release not found' using errcode = '22023'; end if;
  if p_action in ('approve','reject') then
    if v_release.status<>'pending' then raise exception 'LoL Mayhem reference already reviewed' using errcode = '55000'; end if;
    update public.lol_mayhem_reference_releases set status=case when p_action='approve' then 'approved' else 'rejected' end,
      review_action=p_action,reviewed_by=p_reviewed_by,reviewed_at=v_now where id=p_id;
    insert into public.admin_audit_events(actor_id,action,target_type,target_id,detail)
    values(p_reviewed_by,'lol.mayhem_reference.'||p_action,'lol_mayhem_reference_release',p_id::text,
      jsonb_build_object('kind',v_release.kind,'clientPatch',v_release.client_patch,'championId',v_release.champion_id,'reason',v_reason));
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'lol-mayhem-reference:'||v_release.kind||':'||v_release.client_patch||':'||v_release.champion_id,0));
  select release_id,previous_release_id into v_current,v_previous from public.lol_mayhem_reference_publications
  where kind=v_release.kind and client_patch=v_release.client_patch and champion_id=v_release.champion_id for update;
  if v_current is distinct from p_expected_publication then
    raise exception 'LoL Mayhem reference publication conflict' using errcode = 'PT409';
  end if;
  if p_action='publish' then
    if v_release.status<>'approved' then raise exception 'LoL Mayhem reference is not approved' using errcode = '55000'; end if;
    if v_current=p_id then
      insert into public.admin_audit_events(actor_id,action,target_type,target_id,detail)
      values(p_reviewed_by,'lol.mayhem_reference.publish','lol_mayhem_reference_release',p_id::text,
        jsonb_build_object('kind',v_release.kind,'clientPatch',v_release.client_patch,'championId',v_release.champion_id,
          'expectedPublication',p_expected_publication,'reason',v_reason));
      return;
    end if;
    insert into public.lol_mayhem_reference_publications(kind,client_patch,champion_id,release_id,previous_release_id,published_by,published_at)
    values(v_release.kind,v_release.client_patch,v_release.champion_id,p_id,v_current,p_reviewed_by,v_now)
    on conflict(kind,client_patch,champion_id) do update set release_id=excluded.release_id,
      previous_release_id=excluded.previous_release_id,published_by=excluded.published_by,published_at=excluded.published_at;
  else
    if v_current is distinct from p_id then
      raise exception 'requested release is not the current LoL Mayhem reference publication' using errcode = '55000';
    end if;
    if v_previous is null then
      delete from public.lol_mayhem_reference_publications
      where kind=v_release.kind and client_patch=v_release.client_patch and champion_id=v_release.champion_id;
    else
      update public.lol_mayhem_reference_publications set release_id=v_previous,previous_release_id=null,
        published_by=p_reviewed_by,published_at=v_now
      where kind=v_release.kind and client_patch=v_release.client_patch and champion_id=v_release.champion_id;
    end if;
  end if;
  insert into public.admin_audit_events(actor_id,action,target_type,target_id,detail)
  values(p_reviewed_by,'lol.mayhem_reference.'||p_action,'lol_mayhem_reference_release',p_id::text,
    jsonb_build_object('kind',v_release.kind,'clientPatch',v_release.client_patch,'championId',v_release.champion_id,
      'expectedPublication',p_expected_publication,'previousRelease',v_previous,'reason',v_reason));
end
$$;

create function public.get_lol_mayhem_reference_storage_bytes()
returns bigint language plpgsql stable security invoker set search_path = '' as $$
declare v_size text; v_total numeric:=0;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  for v_size in select o.metadata->>'size' from storage.objects o
    where o.bucket_id='lol-augment-snapshots' and o.name like 'external/mayhem-reference/objects/%'
  loop
    if v_size is null or v_size !~ '^(0|[1-9][0-9]*)$' then
      raise exception 'invalid LoL Mayhem reference storage size metadata' using errcode = '22023';
    end if;
    v_total:=v_total+v_size::numeric;
    if v_total>9223372036854775807 then raise exception 'LoL Mayhem reference storage size overflow' using errcode = '22003'; end if;
  end loop;
  return v_total::bigint;
end
$$;

revoke all on function public.prevent_lol_mayhem_reference_mutation(),
  public.renew_lol_mayhem_reference_lease(uuid),public.ingest_lol_mayhem_reference(jsonb,uuid),
  public.review_lol_mayhem_reference(bigint,text,bigint,uuid,text),public.get_lol_mayhem_reference_storage_bytes()
  from public,anon,authenticated;
grant execute on function public.renew_lol_mayhem_reference_lease(uuid),
  public.ingest_lol_mayhem_reference(jsonb,uuid),public.review_lol_mayhem_reference(bigint,text,bigint,uuid,text),
  public.get_lol_mayhem_reference_storage_bytes() to service_role;
commit;
