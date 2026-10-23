begin;
set local lock_timeout = '2s';

create table public.lol_game_patches (
  client_patch text primary key check (client_patch ~ '^(15|16)\.[1-9][0-9]?$'),
  display_patch text not null check (display_patch ~ '^(25|26)\.[1-9][0-9]?$'),
  released_at timestamptz, ddragon_version text, cdragon_version text,
  notes_url_ko text, notes_url_en text, verified_at timestamptz,
  published_at timestamptz,
  check (display_patch = ((split_part(client_patch,'.',1)::integer + 10)::text || '.' || split_part(client_patch,'.',2)))
);

create table public.lol_augments (
  platform_id integer primary key check (platform_id > 0),
  name_id text not null check (length(name_id) between 1 and 256),
  rarity text not null check (rarity in ('silver','gold','prismatic')),
  icon_small_path text, icon_large_path text,
  first_seen_patch text not null references public.lol_game_patches(client_patch),
  last_seen_patch text not null references public.lol_game_patches(client_patch),
  is_internal boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);

create table public.lol_augment_patch_states (
  platform_id integer not null references public.lol_augments(platform_id),
  client_patch text not null references public.lol_game_patches(client_patch),
  mode_name text not null default 'KIWI' check (mode_name in ('KIWI')),
  rarity text not null check (rarity in ('silver','gold','prismatic')),
  is_internal boolean not null, icon_small_path text, icon_large_path text,
  in_pool boolean not null, enabled boolean not null, quest boolean not null, ability boolean not null,
  build_tags bigint not null, augment_tags bigint not null,
  data_values jsonb not null check (jsonb_typeof(data_values) = 'array'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'insufficient_data' check (state in (
    'official_active','official_disabled','official_removed','official_reenabled','unlock_required','client_absent_unannounced','insufficient_data'
  )),
  primary key (platform_id,client_patch,mode_name)
);

create table public.lol_augment_localizations (
  platform_id integer not null references public.lol_augments(platform_id),
  client_patch text not null references public.lol_game_patches(client_patch),
  locale text not null check (locale in ('ko_kr','en_us')),
  name text check (length(name) <= 256),
  description text not null check (length(btrim(description)) between 1 and 32768),
  tooltip_raw text check (length(tooltip_raw) <= 32768),
  tooltip_rendered jsonb not null check (jsonb_typeof(tooltip_rendered) = 'array'),
  render_status text not null check (render_status in ('ok','partial','failed')),
  display_source text not null check (display_source in ('tooltip','desc','desc_partial')),
  display_text text not null check (length(btrim(display_text)) between 1 and 32768),
  primary key (platform_id,client_patch,locale)
);

create index lol_augment_patch_states_patch_idx on public.lol_augment_patch_states(client_patch,platform_id);
create index lol_augment_localizations_patch_idx on public.lol_augment_localizations(client_patch,platform_id);

create table public.lol_augment_data_sources (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('client_data','official_note')),
  url text not null check (length(url) between 1 and 2048),
  license text, attribution text,
  enabled boolean not null default true, blocked_reason text
);

create table public.lol_augment_patch_notes (
  client_patch text not null references public.lol_game_patches(client_patch),
  locale text not null check (locale in ('ko_kr','en_us')),
  url text not null check (length(url) between 1 and 2048),
  published_at timestamptz,
  added_names text[] not null check (cardinality(added_names) <= 1000),
  removed_names text[] not null check (cardinality(removed_names) <= 1000),
  parse_status text not null check (parse_status in ('ok','partial','failed')),
  fetched_at timestamptz not null default clock_timestamp(),
  primary key (client_patch,locale)
);

create table public.lol_augment_aliases (
  platform_id integer not null references public.lol_augments(platform_id),
  alias text not null check (length(btrim(alias)) between 1 and 256),
  kind text not null check (kind in ('patch_note','search','en_upper')),
  source_id uuid references public.lol_augment_data_sources(id),
  primary key (platform_id,alias)
);

create table public.lol_augment_patch_changes (
  id uuid primary key default gen_random_uuid(),
  client_patch text not null references public.lol_game_patches(client_patch),
  platform_id integer references public.lol_augments(platform_id),
  change_type text not null check (change_type in ('added','removed','reenabled','changed','unannounced_absent')),
  official boolean not null,
  summary_ko text not null check (length(btrim(summary_ko)) between 1 and 4096),
  source_id uuid references public.lol_augment_data_sources(id),
  review_status text not null check (review_status in ('pending','approved','rejected')),
  unique nulls not distinct (client_patch,platform_id,change_type,source_id)
);

create table public.lol_augment_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.lol_augment_data_sources(id),
  client_patch text not null references public.lol_game_patches(client_patch),
  started_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
  status text not null default 'running' check (status in ('running','succeeded','review','blocked','failed')),
  snapshot_path text check (snapshot_path ~ '^(15|16)\.[1-9][0-9]?/((augment-lists|cherry-augments|kiwi-bin|stringtable-ko|stringtable-en|manifest)-)?[0-9a-f]{64}\.json$'),
  snapshot_hash text, counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  error_code text check (length(error_code) <= 128),
  lease_until timestamptz not null,
  check ((status = 'running') = (finished_at is null))
);
create unique index lol_augment_ingestion_running_patch_idx on public.lol_augment_ingestion_runs(client_patch) where status = 'running';
create index lol_augment_ingestion_patch_history_idx on public.lol_augment_ingestion_runs(client_patch,started_at desc);

create table public.lol_augment_publication (
  singleton boolean primary key default true check (singleton),
  client_patch text not null references public.lol_game_patches(client_patch),
  run_id uuid not null references public.lol_augment_ingestion_runs(id),
  published_at timestamptz not null default clock_timestamp()
);

-- 모든 진입점은 서버 서비스 역할만 사용한다.
do $$
declare t text;
begin
  foreach t in array array['lol_game_patches','lol_augments','lol_augment_patch_states','lol_augment_localizations',
    'lol_augment_patch_notes','lol_augment_aliases','lol_augment_patch_changes','lol_augment_data_sources','lol_augment_ingestion_runs','lol_augment_publication'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from public, anon, authenticated',t);
    execute format('grant all on table public.%I to service_role',t);
  end loop;
end $$;

create function public.acquire_lol_augment_ingestion_lease(
  p_client_patch text, p_source_id uuid default null, p_ttl_seconds integer default 600
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_id uuid;
begin
  if p_client_patch is null or p_client_patch !~ '^(15|16)\.[1-9][0-9]?$'
    or p_ttl_seconds is null or p_ttl_seconds not between 30 and 3600 then
    raise exception 'invalid ingestion lease' using errcode='22023';
  end if;
  insert into public.lol_game_patches(client_patch,display_patch)
  values (p_client_patch,(split_part(p_client_patch,'.',1)::integer+10)::text || '.' || split_part(p_client_patch,'.',2))
  on conflict do nothing;
  perform 1 from public.lol_game_patches where client_patch=p_client_patch for update;
  if exists (select 1 from public.lol_game_patches where client_patch=p_client_patch and published_at is not null) then
    raise exception 'published patch is immutable' using errcode='55000';
  end if;
  if p_source_id is not null and not exists (
    select 1 from public.lol_augment_data_sources where id=p_source_id and enabled and blocked_reason is null
  ) then raise exception 'source disabled' using errcode='22023'; end if;
  update public.lol_augment_ingestion_runs set status='failed',error_code='lease_expired',finished_at=clock_timestamp()
  where client_patch=p_client_patch and status='running' and lease_until <= clock_timestamp();
  if exists (select 1 from public.lol_augment_ingestion_runs where client_patch=p_client_patch and status='running') then return null; end if;
  insert into public.lol_augment_ingestion_runs(client_patch,source_id,lease_until)
  values (p_client_patch,p_source_id,clock_timestamp()+make_interval(secs=>p_ttl_seconds)) returning id into v_id;
  return v_id;
end $$;

create function public.upsert_lol_augment_snapshot(p_run_id uuid,p_client_patch text,p_payload jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare v_run public.lol_augment_ingestion_runs; v_hash text; a jsonb; l jsonb; v_count integer;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 8388608
    or jsonb_typeof(p_payload->'augments') is distinct from 'array'
    or jsonb_typeof(p_payload->'patch') is distinct from 'object' then
    raise exception 'invalid snapshot payload' using errcode='22023';
  end if;
  v_count := jsonb_array_length(p_payload->'augments');
  if v_count not between 1 and 1000 then raise exception 'snapshot row limit' using errcode='22023'; end if;
  perform 1 from public.lol_game_patches where client_patch=p_client_patch for update;
  select * into v_run from public.lol_augment_ingestion_runs where id=p_run_id and client_patch=p_client_patch for update;
  if not found or v_run.status <> 'running' or v_run.lease_until <= clock_timestamp() then
    raise exception 'ingestion lease lost' using errcode='55000';
  end if;
  if exists (select 1 from public.lol_game_patches where client_patch=p_client_patch and published_at is not null) then
    raise exception 'published patch is immutable' using errcode='55000';
  end if;
  if v_run.source_id is not null and not exists (
    select 1 from public.lol_augment_data_sources where id=v_run.source_id and enabled and blocked_reason is null
  ) then raise exception 'source disabled' using errcode='55000'; end if;
  v_hash := encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
  if v_run.snapshot_hash is not null then
    if v_run.snapshot_hash <> v_hash then raise exception 'run snapshot conflict' using errcode='22023'; end if;
    return v_count;
  end if;
  update public.lol_game_patches set display_patch=p_payload->'patch'->>'display_patch',
    released_at=(p_payload->'patch'->>'released_at')::timestamptz, ddragon_version=p_payload->'patch'->>'ddragon_version',
    cdragon_version=p_payload->'patch'->>'cdragon_version', notes_url_ko=p_payload->'patch'->>'notes_url_ko',
    notes_url_en=p_payload->'patch'->>'notes_url_en', verified_at=(p_payload->'patch'->>'verified_at')::timestamptz
  where client_patch=p_client_patch;
  if coalesce(p_payload->>'snapshot_path','') !~ ('^' || replace(p_client_patch,'.','\.') || '/((augment-lists|cherry-augments|kiwi-bin|stringtable-ko|stringtable-en|manifest)-)?[0-9a-f]{64}\.json$') then
    raise exception 'invalid snapshot path' using errcode='22023';
  end if;
  delete from public.lol_augment_localizations where client_patch=p_client_patch;
  delete from public.lol_augment_patch_states where client_patch=p_client_patch;
  -- 이전 실행의 검토 결과를 새 스냅샷에 재사용하지 않는다.
  delete from public.lol_augment_patch_changes where client_patch=p_client_patch;
  if (select count(distinct (x->>'platform_id')::integer) from jsonb_array_elements(p_payload->'augments') x) <> v_count then
    raise exception 'duplicate platform id' using errcode='22023';
  end if;
  for a in select value from jsonb_array_elements(p_payload->'augments') loop
    if jsonb_typeof(a->'localizations') is distinct from 'array' or jsonb_array_length(a->'localizations') <> 2
      or (select count(distinct x->>'locale') from jsonb_array_elements(a->'localizations') x) <> 2
      or jsonb_typeof(coalesce(a->'aliases','[]')) <> 'array' or jsonb_array_length(coalesce(a->'aliases','[]')) > 20 then
      raise exception 'invalid localization or alias rows' using errcode='22023';
    end if;
    insert into public.lol_augments(platform_id,name_id,rarity,icon_small_path,icon_large_path,first_seen_patch,last_seen_patch,is_internal)
    values ((a->>'platform_id')::integer,a->>'name_id',a->>'rarity',a->>'icon_small_path',a->>'icon_large_path',p_client_patch,p_client_patch,(a->>'is_internal')::boolean)
    on conflict (platform_id) do update set name_id=excluded.name_id,rarity=excluded.rarity,
      icon_small_path=excluded.icon_small_path,icon_large_path=excluded.icon_large_path,
      last_seen_patch=excluded.last_seen_patch,is_internal=excluded.is_internal,updated_at=clock_timestamp();
    insert into public.lol_augment_patch_states(platform_id,client_patch,mode_name,rarity,is_internal,icon_small_path,icon_large_path,
      in_pool,enabled,quest,ability,build_tags,augment_tags,data_values,source_hash,state)
    values ((a->>'platform_id')::integer,p_client_patch,a->>'mode_name',a->>'rarity',(a->>'is_internal')::boolean,a->>'icon_small_path',a->>'icon_large_path',
      (a->>'in_pool')::boolean,(a->>'enabled')::boolean,(a->>'quest')::boolean,(a->>'ability')::boolean,
      (a->>'build_tags')::bigint,(a->>'augment_tags')::bigint,a->'data_values',a->>'source_hash',coalesce(a->>'state','insufficient_data'));
    for l in select value from jsonb_array_elements(a->'localizations') loop
      insert into public.lol_augment_localizations(platform_id,client_patch,locale,name,description,tooltip_raw,tooltip_rendered,render_status,display_source,display_text)
      values ((a->>'platform_id')::integer,p_client_patch,l->>'locale',l->>'name',l->>'description',l->>'tooltip_raw',l->'tooltip_rendered',
        l->>'render_status',l->>'display_source',l->>'display_text');
    end loop;
    for l in select value from jsonb_array_elements(coalesce(a->'aliases','[]')) loop
      insert into public.lol_augment_aliases(platform_id,alias,kind,source_id)
      values ((a->>'platform_id')::integer,l->>'alias',l->>'kind',(l->>'source_id')::uuid)
      on conflict (platform_id,alias) do update set kind=excluded.kind,source_id=excluded.source_id;
    end loop;
  end loop;
  update public.lol_augment_ingestion_runs set snapshot_hash=v_hash,snapshot_path=p_payload->>'snapshot_path',
    counts=jsonb_build_object('augments',v_count,'localizations',v_count*2) where id=p_run_id;
  return v_count;
end $$;

create function public.record_lol_augment_patch_changes(p_run_id uuid,p_client_patch text,p_changes jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare v_run public.lol_augment_ingestion_runs; c jsonb;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or octet_length(p_changes::text) > 1048576 then
    raise exception 'invalid change payload' using errcode='22023';
  end if;
  if jsonb_array_length(p_changes)>2000 then raise exception 'change row limit' using errcode='22023'; end if;
  perform 1 from public.lol_game_patches where client_patch=p_client_patch for update;
  select * into v_run from public.lol_augment_ingestion_runs where id=p_run_id and client_patch=p_client_patch for update;
  if not found or v_run.status <> 'running' or v_run.lease_until <= clock_timestamp() or v_run.snapshot_hash is null then
    raise exception 'ingestion lease lost or snapshot missing' using errcode='55000';
  end if;
  if exists (select 1 from public.lol_game_patches where client_patch=p_client_patch and published_at is not null) then
    raise exception 'published patch is immutable' using errcode='55000';
  end if;
  for c in select value from jsonb_array_elements(p_changes) loop
    insert into public.lol_augment_patch_changes(client_patch,platform_id,change_type,official,summary_ko,source_id,review_status)
    values (p_client_patch,(c->>'platform_id')::integer,c->>'change_type',(c->>'official')::boolean,c->>'summary_ko',
      (c->>'source_id')::uuid,c->>'review_status')
    on conflict (client_patch,platform_id,change_type,source_id) do update set
      official=excluded.official,summary_ko=excluded.summary_ko,review_status=excluded.review_status;
  end loop;
  return jsonb_array_length(p_changes);
end $$;

create function public.record_lol_augment_patch_notes(p_run_id uuid,p_client_patch text,p_locale text,p_notes jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_run public.lol_augment_ingestion_runs;
begin
  if p_notes is null or jsonb_typeof(p_notes) <> 'object' or octet_length(p_notes::text)>1048576
    or p_locale is null or p_locale not in ('ko_kr','en_us')
    or jsonb_typeof(p_notes->'added_names') is distinct from 'array'
    or jsonb_typeof(p_notes->'removed_names') is distinct from 'array' then
    raise exception 'invalid patch notes' using errcode='22023';
  end if;
  if jsonb_array_length(p_notes->'added_names')>1000 or jsonb_array_length(p_notes->'removed_names')>1000 then
    raise exception 'patch note name limit' using errcode='22023';
  end if;
  if exists (select 1 from jsonb_array_elements((p_notes->'added_names') || (p_notes->'removed_names')) x
    where jsonb_typeof(x)<>'string' or length(btrim(x#>>'{}')) not between 1 and 256) then
    raise exception 'invalid patch note name' using errcode='22023';
  end if;
  perform 1 from public.lol_game_patches where client_patch=p_client_patch for update;
  select * into v_run from public.lol_augment_ingestion_runs where id=p_run_id and client_patch=p_client_patch for update;
  if not found or v_run.status<>'running' or v_run.lease_until<=clock_timestamp()
    or exists(select 1 from public.lol_game_patches where client_patch=p_client_patch and published_at is not null) then
    raise exception 'ingestion lease lost' using errcode='55000';
  end if;
  insert into public.lol_augment_patch_notes(client_patch,locale,url,published_at,added_names,removed_names,parse_status)
  values(p_client_patch,p_locale,p_notes->>'url',(p_notes->>'published_at')::timestamptz,
    array(select jsonb_array_elements_text(p_notes->'added_names')),
    array(select jsonb_array_elements_text(p_notes->'removed_names')),p_notes->>'parse_status')
  on conflict(client_patch,locale) do update set url=excluded.url,published_at=excluded.published_at,
    added_names=excluded.added_names,removed_names=excluded.removed_names,parse_status=excluded.parse_status,fetched_at=clock_timestamp();
end $$;

create function public.finish_lol_augment_ingestion_run(p_run_id uuid,p_status text,p_error_code text default null)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_run public.lol_augment_ingestion_runs;
begin
  if p_status is null or p_status not in ('succeeded','review','blocked','failed') or length(p_error_code)>128 then
    raise exception 'invalid finish status' using errcode='22023';
  end if;
  select * into v_run from public.lol_augment_ingestion_runs where id=p_run_id for update;
  if not found then raise exception 'ingestion run missing' using errcode='55000'; end if;
  if v_run.status=p_status and v_run.error_code is not distinct from p_error_code then return; end if;
  if v_run.status <> 'running' or v_run.lease_until <= clock_timestamp() then
    raise exception 'ingestion lease lost' using errcode='55000';
  end if;
  if p_status in ('succeeded','review') and (v_run.snapshot_hash is null or p_error_code is not null) then
    raise exception 'successful run requires snapshot without error' using errcode='22023';
  end if;
  update public.lol_augment_ingestion_runs set status=p_status,error_code=p_error_code,finished_at=clock_timestamp(),lease_until=clock_timestamp()
  where id=p_run_id;
end $$;

create function public.publish_lol_augment_patch(p_client_patch text,p_run_id uuid default null)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_run public.lol_augment_ingestion_runs;
begin
  perform 1 from public.lol_game_patches where client_patch=p_client_patch and verified_at is not null
    and released_at is not null and ddragon_version like p_client_patch || '.%' and cdragon_version=p_client_patch for update;
  if not found then raise exception 'patch mapping not verified' using errcode='55000'; end if;
  select * into v_run from public.lol_augment_ingestion_runs where client_patch=p_client_patch order by started_at desc,id desc limit 1 for update;
  if p_run_id is not null and v_run.id is distinct from p_run_id then
    raise exception 'reviewed run changed' using errcode='55000';
  end if;
  if not found or v_run.status not in ('succeeded','review') or v_run.snapshot_hash is null then
    raise exception 'patch run not publishable' using errcode='55000';
  end if;
  if v_run.source_id is not null and not exists (
    select 1 from public.lol_augment_data_sources where id=v_run.source_id and enabled and blocked_reason is null
  ) then raise exception 'source disabled' using errcode='55000'; end if;
  if exists (select 1 from public.lol_augment_ingestion_runs where client_patch=p_client_patch and status='running')
    or exists (select 1 from public.lol_augment_patch_changes where client_patch=p_client_patch and review_status='pending')
    or not exists (select 1 from public.lol_augment_patch_states where client_patch=p_client_patch) then
    raise exception 'patch review incomplete' using errcode='55000';
  end if;
  update public.lol_game_patches set published_at=coalesce(published_at,clock_timestamp()) where client_patch=p_client_patch;
  insert into public.lol_augment_publication(singleton,client_patch,run_id) values (true,p_client_patch,v_run.id)
  on conflict (singleton) do update set client_patch=excluded.client_patch,run_id=excluded.run_id,published_at=clock_timestamp();
end $$;

create function public.get_lol_augment_catalog(p_client_patch text default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('clientPatch',p.client_patch,'displayPatch',p.display_patch,'releasedAt',p.released_at,
    'notesUrlKo',p.notes_url_ko,'notesUrlEn',p.notes_url_en,
    'augments',coalesce((select jsonb_agg(jsonb_build_object(
      'platformId',s.platform_id,'rarity',s.rarity,'isInternal',s.is_internal,'enabled',s.enabled,'inPool',s.in_pool,
      'quest',s.quest,'ability',s.ability,'state',s.state,'iconSmallPath',s.icon_small_path,'iconLargePath',s.icon_large_path,
      'localizations',(select jsonb_object_agg(l.locale,jsonb_build_object('name',l.name,'text',l.display_text,
        'tokens',l.tooltip_rendered,'displaySource',l.display_source,
        'notice',case when l.display_source='desc_partial' then '일부 수치는 게임 안에서 확인하세요' else null end))
        from public.lol_augment_localizations l where l.client_patch=s.client_patch and l.platform_id=s.platform_id)
    ) order by s.platform_id) from public.lol_augment_patch_states s where s.client_patch=p.client_patch and s.mode_name='KIWI'),'[]'::jsonb),
    'changes',coalesce((select jsonb_agg(jsonb_build_object('platformId',c.platform_id,'changeType',c.change_type,
      'official',c.official,'summaryKo',c.summary_ko) order by c.platform_id nulls last,c.change_type,c.id)
      from public.lol_augment_patch_changes c where c.client_patch=p.client_patch and c.review_status='approved'),'[]'::jsonb))
  from public.lol_game_patches p where p.client_patch=coalesce(p_client_patch,(select client_patch from public.lol_augment_publication where singleton))
    and p.published_at is not null;
$$;

revoke all on function public.acquire_lol_augment_ingestion_lease(text,uuid,integer),
  public.upsert_lol_augment_snapshot(uuid,text,jsonb), public.record_lol_augment_patch_changes(uuid,text,jsonb),
  public.record_lol_augment_patch_notes(uuid,text,text,jsonb),
  public.finish_lol_augment_ingestion_run(uuid,text,text),public.publish_lol_augment_patch(text,uuid),public.get_lol_augment_catalog(text)
  from public,anon,authenticated;
grant execute on function public.acquire_lol_augment_ingestion_lease(text,uuid,integer),
  public.upsert_lol_augment_snapshot(uuid,text,jsonb),public.record_lol_augment_patch_changes(uuid,text,jsonb),
  public.record_lol_augment_patch_notes(uuid,text,text,jsonb),
  public.finish_lol_augment_ingestion_run(uuid,text,text),public.publish_lol_augment_patch(text,uuid),public.get_lol_augment_catalog(text)
  to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
  ('lol-augment-snapshots','lol-augment-snapshots',false,67108864,array['application/json']::text[]),
  ('lol-augment-evidence','lol-augment-evidence',false,5242880,array['image/png','image/jpeg','image/webp']::text[])
on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

-- 기존의 넓은 허용 정책이 있어도 이 두 버킷은 공개하지 않는다.
create policy lol_augment_objects_service_only on storage.objects as restrictive for all to anon,authenticated
  using (bucket_id not in ('lol-augment-snapshots','lol-augment-evidence'))
  with check (bucket_id not in ('lol-augment-snapshots','lol-augment-evidence'));
create policy lol_augment_buckets_service_only on storage.buckets as restrictive for all to anon,authenticated
  using (id not in ('lol-augment-snapshots','lol-augment-evidence'))
  with check (id not in ('lol-augment-snapshots','lol-augment-evidence'));
create policy lol_augment_objects_service_all on storage.objects for all to service_role
  using (bucket_id in ('lol-augment-snapshots','lol-augment-evidence'))
  with check (bucket_id in ('lol-augment-snapshots','lol-augment-evidence'));
create policy lol_augment_buckets_service_all on storage.buckets for all to service_role
  using (id in ('lol-augment-snapshots','lol-augment-evidence'))
  with check (id in ('lol-augment-snapshots','lol-augment-evidence'));

commit;
