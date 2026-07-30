-- 패치노트 기반 무기도감 갱신 제안·승인 파이프라인
--
-- 설계 원칙
--   1. AI 추출 결과는 weapon_patch_proposals / weapon_patch_proposal_changes 에만 기록한다.
--      weapons 등 서비스 테이블은 apply_weapon_patch_proposal RPC 를 통해서만 변경된다.
--   2. 변경 항목마다 패치노트 원문 인용(evidence_quote)을 필수로 보관한다.
--      인용문이 원문에 실제 존재하는지는 애플리케이션 코드가 검증하고 evidence_found 에 기록한다.
--   3. 적용 직전에 현재 DB 값이 제안 시점 값(old_value)과 같은지 재확인한다(낙관적 동시성 제어).
--   4. 적용 전후 행 스냅샷을 weapon_patch_apply_log 에 남겨 되돌릴 수 있게 한다.
--
-- RLS: 세 테이블 모두 활성화하되 정책을 두지 않는다(analytics_events 와 동일 방침).
--      service_role 전용이며 조회는 관리자 API 라우트를 통해서만 제공한다.
--
-- v1 범위: 기존 항목의 컬럼 갱신(operation = 'update')만 지원한다.
--          신규 무기 추가는 R2 이미지 자산 등록이 함께 필요하므로 관리자 수동 등록 경로를 유지한다.

create table if not exists public.weapon_patch_proposals (
  id uuid primary key default gen_random_uuid(),
  source_post_id bigint references public.posts(id) on delete set null,
  source_url text not null,
  source_text_hash text not null,
  patch_label text,
  status text not null default 'pending',
  model_name text,
  raw_ai_response jsonb,
  validation_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  constraint weapon_patch_proposals_status_check check (
    status in ('pending', 'partially_applied', 'applied', 'rejected', 'superseded')
  )
);

-- 동일 패치노트 본문에 대한 중복 제안 차단.
-- 기존 패치노트 동기화의 중복 판정(sync_history.last_url, posts.title)은
-- 제목이 수정되면 우회되므로 본문 해시를 기준으로 삼는다.
create unique index if not exists weapon_patch_proposals_source_text_hash_key
  on public.weapon_patch_proposals (source_text_hash);

create index if not exists weapon_patch_proposals_status_created_at_idx
  on public.weapon_patch_proposals (status, created_at desc);

create table if not exists public.weapon_patch_proposal_changes (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.weapon_patch_proposals(id) on delete cascade,
  target_table text not null,
  target_id text not null,
  operation text not null default 'update',
  column_name text not null,
  old_value jsonb,
  new_value jsonb not null,
  evidence_quote text not null,
  evidence_found boolean not null default false,
  confidence numeric(3, 2),
  validation_state text not null default 'invalid',
  validation_reason text,
  decision text not null default 'pending',
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,
  constraint weapon_patch_proposal_changes_target_table_check check (
    target_table in ('weapons', 'attachments', 'ammo', 'consumables', 'throwables', 'vehicles')
  ),
  constraint weapon_patch_proposal_changes_operation_check check (operation = 'update'),
  constraint weapon_patch_proposal_changes_validation_state_check check (
    validation_state in ('ok', 'stale', 'invalid')
  ),
  constraint weapon_patch_proposal_changes_decision_check check (
    decision in ('pending', 'accepted', 'rejected')
  ),
  -- 검증을 통과하지 않은 항목은 승인 상태로 둘 수 없다.
  constraint weapon_patch_proposal_changes_accept_requires_ok check (
    decision <> 'accepted' or validation_state = 'ok'
  )
);

create index if not exists weapon_patch_proposal_changes_proposal_idx
  on public.weapon_patch_proposal_changes (proposal_id);

create unique index if not exists weapon_patch_proposal_changes_unique_target
  on public.weapon_patch_proposal_changes (proposal_id, target_table, target_id, column_name);

create table if not exists public.weapon_patch_apply_log (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.weapon_patch_proposals(id) on delete cascade,
  change_id uuid not null references public.weapon_patch_proposal_changes(id) on delete cascade,
  target_table text not null,
  target_id text not null,
  column_name text not null,
  before_row jsonb not null,
  after_row jsonb not null,
  applied_by uuid references auth.users(id) on delete set null,
  applied_at timestamptz not null default timezone('utc', now()),
  reverted_by uuid references auth.users(id) on delete set null,
  reverted_at timestamptz
);

create index if not exists weapon_patch_apply_log_proposal_idx
  on public.weapon_patch_apply_log (proposal_id, applied_at desc);

alter table public.weapon_patch_proposals enable row level security;
alter table public.weapon_patch_proposal_changes enable row level security;
alter table public.weapon_patch_apply_log enable row level security;

revoke all on table public.weapon_patch_proposals from anon, authenticated;
revoke all on table public.weapon_patch_proposal_changes from anon, authenticated;
revoke all on table public.weapon_patch_apply_log from anon, authenticated;

grant all on table public.weapon_patch_proposals to service_role;
grant all on table public.weapon_patch_proposal_changes to service_role;
grant all on table public.weapon_patch_apply_log to service_role;

-- 대상 테이블/컬럼 화이트리스트.
-- 2026-07-30 운영 information_schema 조회로 컬럼 존재와 타입을 확인했다.
-- lib/patch-notes/weaponSchema.ts 와 동일한 목록을 유지해야 하며,
-- tests/weapon-patch-schema-parity.test.ts 가 두 정의의 일치를 검증한다.
create or replace function public.weapon_patch_editable_columns()
returns table (target_table text, column_name text)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('weapons', 'damage'),
    ('weapons', 'bullet_speed'),
    ('weapons', 'ammo'),
    ('weapons', 'type'),
    ('weapons', 'availability'),
    ('weapons', 'spawn_maps'),
    ('weapons', 'weight'),
    ('weapons', 'patch_notes'),
    ('attachments', 'vertical_recoil'),
    ('attachments', 'horizontal_recoil'),
    ('attachments', 'reload_speed'),
    ('attachments', 'ads_speed'),
    ('attachments', 'weight'),
    ('attachments', 'patch_notes'),
    ('ammo', 'weight'),
    ('ammo', 'patch_notes'),
    ('consumables', 'cast_time'),
    ('consumables', 'weight'),
    ('consumables', 'patch_notes'),
    ('throwables', 'weight'),
    ('throwables', 'patch_notes'),
    ('vehicles', 'trunk_capacity'),
    ('vehicles', 'patch_notes')
  ) as t(target_table, column_name);
$$;

-- 승인된 항목만 원자적으로 적용한다.
-- 반환: 항목별 처리 결과. applied / skipped_stale / skipped_missing
create or replace function public.apply_weapon_patch_proposal(
  p_proposal_id uuid,
  p_actor uuid
)
returns table (
  change_id uuid,
  target_table text,
  target_id text,
  column_name text,
  result text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.weapon_patch_proposals%rowtype;
  v_change public.weapon_patch_proposal_changes%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_column_type text;
  v_applied integer := 0;
  v_skipped integer := 0;
begin
  select * into v_proposal
  from public.weapon_patch_proposals
  where weapon_patch_proposals.id = p_proposal_id
  for update;

  if not found then
    raise exception 'weapon patch proposal not found: %', p_proposal_id;
  end if;

  if v_proposal.status not in ('pending', 'partially_applied') then
    raise exception 'weapon patch proposal is not applicable (status=%)', v_proposal.status;
  end if;

  for v_change in
    select *
    from public.weapon_patch_proposal_changes c
    where c.proposal_id = p_proposal_id
      and c.decision = 'accepted'
      and c.validation_state = 'ok'
    order by c.target_table, c.target_id, c.column_name
  loop
    -- 화이트리스트 재확인. 애플리케이션 검증을 우회한 데이터가 들어와도 여기서 막힌다.
    if not exists (
      select 1 from public.weapon_patch_editable_columns() w
      where w.target_table = v_change.target_table
        and w.column_name = v_change.column_name
    ) then
      raise exception 'column not editable: %.%', v_change.target_table, v_change.column_name;
    end if;

    execute format('select to_jsonb(t) from public.%I t where t.id = $1 for update', v_change.target_table)
      into v_before
      using v_change.target_id;

    if v_before is null then
      update public.weapon_patch_proposal_changes
        set validation_state = 'invalid',
            validation_reason = '적용 시점에 대상 행이 존재하지 않음'
        where weapon_patch_proposal_changes.id = v_change.id;
      v_skipped := v_skipped + 1;
      return query select v_change.id, v_change.target_table, v_change.target_id,
        v_change.column_name, 'skipped_missing'::text;
      continue;
    end if;

    -- 제안 생성 이후 값이 바뀐 경우 적용하지 않는다.
    if coalesce(v_before -> v_change.column_name, 'null'::jsonb)
       <> coalesce(v_change.old_value, 'null'::jsonb) then
      update public.weapon_patch_proposal_changes
        set validation_state = 'stale',
            validation_reason = '적용 시점 현재값이 제안 시점 값과 다름',
            decision = 'pending'
        where weapon_patch_proposal_changes.id = v_change.id;
      v_skipped := v_skipped + 1;
      return query select v_change.id, v_change.target_table, v_change.target_id,
        v_change.column_name, 'skipped_stale'::text;
      continue;
    end if;

    select a.atttypid::regtype::text into v_column_type
    from pg_catalog.pg_attribute a
    where a.attrelid = format('public.%I', v_change.target_table)::regclass
      and a.attname = v_change.column_name
      and a.attnum > 0
      and not a.attisdropped;

    if v_column_type is null then
      raise exception 'column not found: %.%', v_change.target_table, v_change.column_name;
    end if;

    execute format(
      'update public.%I set %I = ($1::text)::%s where id = $2',
      v_change.target_table, v_change.column_name, v_column_type
    ) using (v_change.new_value #>> '{}'), v_change.target_id;

    execute format('select to_jsonb(t) from public.%I t where t.id = $1', v_change.target_table)
      into v_after
      using v_change.target_id;

    insert into public.weapon_patch_apply_log (
      proposal_id, change_id, target_table, target_id, column_name,
      before_row, after_row, applied_by
    ) values (
      p_proposal_id, v_change.id, v_change.target_table, v_change.target_id, v_change.column_name,
      v_before, v_after, p_actor
    );

    v_applied := v_applied + 1;
    return query select v_change.id, v_change.target_table, v_change.target_id,
      v_change.column_name, 'applied'::text;
  end loop;

  update public.weapon_patch_proposals
    set status = case
          when v_applied = 0 then 'pending'
          when v_skipped > 0 then 'partially_applied'
          when exists (
            select 1 from public.weapon_patch_proposal_changes c
            where c.proposal_id = p_proposal_id and c.decision = 'pending'
          ) then 'partially_applied'
          else 'applied'
        end,
        reviewed_at = timezone('utc', now()),
        reviewed_by = p_actor
    where weapon_patch_proposals.id = p_proposal_id;
end;
$$;

-- 적용 로그 1건을 되돌린다.
create or replace function public.revert_weapon_patch_apply(
  p_log_id uuid,
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_log public.weapon_patch_apply_log%rowtype;
  v_column_type text;
  v_before_value jsonb;
begin
  select * into v_log
  from public.weapon_patch_apply_log
  where weapon_patch_apply_log.id = p_log_id
  for update;

  if not found then
    raise exception 'weapon patch apply log not found: %', p_log_id;
  end if;

  if v_log.reverted_at is not null then
    raise exception 'weapon patch apply log already reverted: %', p_log_id;
  end if;

  v_before_value := v_log.before_row -> v_log.column_name;

  select a.atttypid::regtype::text into v_column_type
  from pg_catalog.pg_attribute a
  where a.attrelid = format('public.%I', v_log.target_table)::regclass
    and a.attname = v_log.column_name
    and a.attnum > 0
    and not a.attisdropped;

  if v_column_type is null then
    raise exception 'column not found: %.%', v_log.target_table, v_log.column_name;
  end if;

  if v_before_value is null or v_before_value = 'null'::jsonb then
    execute format('update public.%I set %I = null where id = $1', v_log.target_table, v_log.column_name)
      using v_log.target_id;
  else
    execute format(
      'update public.%I set %I = ($1::text)::%s where id = $2',
      v_log.target_table, v_log.column_name, v_column_type
    ) using (v_before_value #>> '{}'), v_log.target_id;
  end if;

  update public.weapon_patch_apply_log
    set reverted_at = timezone('utc', now()),
        reverted_by = p_actor
    where weapon_patch_apply_log.id = p_log_id;
end;
$$;

revoke all on function public.weapon_patch_editable_columns() from public, anon, authenticated;
revoke all on function public.apply_weapon_patch_proposal(uuid, uuid) from public, anon, authenticated;
revoke all on function public.revert_weapon_patch_apply(uuid, uuid) from public, anon, authenticated;

grant execute on function public.weapon_patch_editable_columns() to service_role;
grant execute on function public.apply_weapon_patch_proposal(uuid, uuid) to service_role;
grant execute on function public.revert_weapon_patch_apply(uuid, uuid) to service_role;
