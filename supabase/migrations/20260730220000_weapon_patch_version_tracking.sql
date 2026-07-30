-- 무기도감에 "어느 패치에서 무엇이 바뀌었는지"를 표시하기 위한 버전 추적
--
-- 배경: 승인된 변경이 weapons 등 서비스 테이블에 적용되어도 어느 패치노트에서
-- 유래했는지 추적할 수 없었다. patch_notes(text) 컬럼은 자유 서술 메모여서
-- 도감 카드에서 2줄로 잘리고 이력도 남지 않는다.
--
-- patch_version(예: '업데이트 42.1')과 patch_applied_at 을 별도 컬럼으로 둬서
-- 도감 UI 가 버전 배지로 노출하고, 최근 변경 항목을 정렬할 수 있게 한다.
-- 값은 apply_weapon_patch_proposal 이 제안의 patch_label 을 그대로 기록한다.

alter table public.weapons add column if not exists patch_version text;
alter table public.weapons add column if not exists patch_applied_at timestamptz;

alter table public.attachments add column if not exists patch_version text;
alter table public.attachments add column if not exists patch_applied_at timestamptz;

alter table public.ammo add column if not exists patch_version text;
alter table public.ammo add column if not exists patch_applied_at timestamptz;

alter table public.consumables add column if not exists patch_version text;
alter table public.consumables add column if not exists patch_applied_at timestamptz;

alter table public.throwables add column if not exists patch_version text;
alter table public.throwables add column if not exists patch_applied_at timestamptz;

alter table public.vehicles add column if not exists patch_version text;
alter table public.vehicles add column if not exists patch_applied_at timestamptz;

-- 적용 로그에도 어느 패치였는지 남긴다. 되돌리기 시 이전 버전 복원에 사용한다.
alter table public.weapon_patch_apply_log add column if not exists patch_version text;
alter table public.weapon_patch_apply_log
  add column if not exists previous_patch_version text;

-- 승인 적용 시 patch_version 을 함께 기록하도록 RPC 를 교체한다.
-- 20260730200100 버전과의 차이는 다음 두 가지뿐이다.
--   1. 제안의 patch_label 을 대상 행의 patch_version / patch_applied_at 에 기록
--   2. 적용 로그에 적용 전/후 patch_version 을 남겨 되돌리기가 복원할 수 있게 함
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
  v_previous_patch_version text;
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

    v_previous_patch_version := v_before ->> 'patch_version';

    execute format(
      'update public.%I set %I = ($1::text)::%s where id = $2',
      v_change.target_table, v_change.column_name, v_column_type
    ) using (v_change.new_value #>> '{}'), v_change.target_id;

    -- 어느 패치에서 바뀌었는지 기록한다. patch_label 이 없으면 건드리지 않는다.
    if v_proposal.patch_label is not null then
      execute format(
        'update public.%I set patch_version = $1, patch_applied_at = timezone(''utc'', now()) where id = $2',
        v_change.target_table
      ) using v_proposal.patch_label, v_change.target_id;
    end if;

    execute format('select to_jsonb(t) from public.%I t where t.id = $1', v_change.target_table)
      into v_after
      using v_change.target_id;

    insert into public.weapon_patch_apply_log (
      proposal_id, change_id, target_table, target_id, column_name,
      before_row, after_row, applied_by, patch_version, previous_patch_version
    ) values (
      p_proposal_id, v_change.id, v_change.target_table, v_change.target_id, v_change.column_name,
      v_before, v_after, p_actor, v_proposal.patch_label, v_previous_patch_version
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

-- 되돌리기도 patch_version 을 이전 값으로 복원한다.
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

  -- 적용 시 patch_version 을 덮어썼다면 이전 값으로 되돌린다.
  if v_log.patch_version is not null then
    execute format(
      'update public.%I set patch_version = $1 where id = $2',
      v_log.target_table
    ) using v_log.previous_patch_version, v_log.target_id;
  end if;

  update public.weapon_patch_apply_log
    set reverted_at = timezone('utc', now()),
        reverted_by = p_actor
    where weapon_patch_apply_log.id = p_log_id;
end;
$$;

revoke all on function public.apply_weapon_patch_proposal(uuid, uuid) from public, anon, authenticated;
revoke all on function public.revert_weapon_patch_apply(uuid, uuid) from public, anon, authenticated;

grant execute on function public.apply_weapon_patch_proposal(uuid, uuid) to service_role;
grant execute on function public.revert_weapon_patch_apply(uuid, uuid) to service_role;
