-- 패치노트 기반 항목 삭제(단종) 반영
--
-- 배경
--   PP-19 비존, 모신 나강, Win94 처럼 게임에서 제거된 무기가 도감에 계속 남아 있었다.
--   기존 파이프라인은 operation = 'update' 만 지원해 수치 변경만 반영할 수 있었다.
--
-- 설계 원칙
--   1. 행을 실제로 delete 하지 않는다. removed_at 을 기록하는 소프트 삭제로 처리한다.
--      과거 전적·분석 데이터가 무기 id 를 문자열로 참조하므로 물리 삭제는 이력을 깨뜨린다.
--      되돌리기도 removed_at 을 null 로 복원하면 되므로 안전하다.
--   2. 삭제는 수치 변경보다 파괴적이므로 승인 없이는 절대 반영되지 않는다.
--      기존 승인 흐름(decision = 'accepted' + validation_state = 'ok')을 그대로 사용한다.
--   3. 삭제 항목도 적용 로그에 적용 전/후 스냅샷을 남겨 되돌릴 수 있게 한다.

alter table public.weapons add column if not exists removed_at timestamptz;
alter table public.weapons add column if not exists removed_patch_version text;

alter table public.attachments add column if not exists removed_at timestamptz;
alter table public.attachments add column if not exists removed_patch_version text;

alter table public.ammo add column if not exists removed_at timestamptz;
alter table public.ammo add column if not exists removed_patch_version text;

alter table public.consumables add column if not exists removed_at timestamptz;
alter table public.consumables add column if not exists removed_patch_version text;

alter table public.throwables add column if not exists removed_at timestamptz;
alter table public.throwables add column if not exists removed_patch_version text;

alter table public.vehicles add column if not exists removed_at timestamptz;
alter table public.vehicles add column if not exists removed_patch_version text;

-- 삭제 제안을 저장할 수 있도록 operation 제약을 확장한다.
alter table public.weapon_patch_proposal_changes
  drop constraint if exists weapon_patch_proposal_changes_operation_check;

alter table public.weapon_patch_proposal_changes
  add constraint weapon_patch_proposal_changes_operation_check
  check (operation in ('update', 'remove'));

-- 삭제 제안은 column_name 을 'removed_at' 으로 고정한다.
-- 기존 unique index (proposal_id, target_table, target_id, column_name) 를 그대로 활용해
-- 같은 제안에서 동일 항목에 대한 중복 삭제 제안을 막는다.
alter table public.weapon_patch_proposal_changes
  drop constraint if exists weapon_patch_proposal_changes_remove_column_check;

alter table public.weapon_patch_proposal_changes
  add constraint weapon_patch_proposal_changes_remove_column_check
  check (operation <> 'remove' or column_name = 'removed_at');

-- 삭제 제안에는 "변경 후 값" 개념이 없다.
-- new_value 의 not null 을 해제하되, 수치 변경에는 여전히 값을 요구한다.
alter table public.weapon_patch_proposal_changes
  alter column new_value drop not null;

alter table public.weapon_patch_proposal_changes
  drop constraint if exists weapon_patch_proposal_changes_new_value_check;

alter table public.weapon_patch_proposal_changes
  add constraint weapon_patch_proposal_changes_new_value_check
  check (
    (operation = 'remove' and new_value is null)
    or (operation = 'update' and new_value is not null)
  );

-- 승인 적용 RPC 를 삭제 연산까지 처리하도록 교체한다.
-- 20260730220000 버전과의 차이는 operation = 'remove' 분기 추가뿐이다.
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
    -- 수치 변경만 컬럼 화이트리스트를 확인한다.
    -- 삭제는 특정 컬럼 편집이 아니라 removed_at 기록이므로 별도 경로로 처리한다.
    if v_change.operation = 'update' and not exists (
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
    -- 삭제 제안도 removed_at 현재값을 같은 방식으로 대조한다.
    if coalesce(v_before -> v_change.column_name, 'null'::jsonb)
       <> coalesce(v_change.old_value, 'null'::jsonb) then
      update public.weapon_patch_proposal_changes
        set validation_state = 'stale',
            validation_reason = case
              when v_change.operation = 'remove'
                then '적용 시점에 이미 삭제 상태가 변경됨'
              else '적용 시점 현재값이 제안 시점 값과 다름'
            end,
            decision = 'pending'
        where weapon_patch_proposal_changes.id = v_change.id;
      v_skipped := v_skipped + 1;
      return query select v_change.id, v_change.target_table, v_change.target_id,
        v_change.column_name, 'skipped_stale'::text;
      continue;
    end if;

    v_previous_patch_version := v_before ->> 'patch_version';

    if v_change.operation = 'remove' then
      -- 소프트 삭제. 행은 남기고 삭제 시각과 삭제 패치 버전만 기록한다.
      execute format(
        'update public.%I set removed_at = timezone(''utc'', now()), removed_patch_version = $1 where id = $2',
        v_change.target_table
      ) using v_proposal.patch_label, v_change.target_id;
    else
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
    end if;

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

-- 되돌리기도 삭제 상태를 복원한다.
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
  v_operation text;
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

  select c.operation into v_operation
  from public.weapon_patch_proposal_changes c
  where c.id = v_log.change_id;

  if v_operation = 'remove' then
    -- 적용 전 스냅샷의 삭제 상태를 그대로 되돌린다.
    execute format(
      'update public.%I set removed_at = $1, removed_patch_version = $2 where id = $3',
      v_log.target_table
    ) using
      (v_log.before_row ->> 'removed_at')::timestamptz,
      v_log.before_row ->> 'removed_patch_version',
      v_log.target_id;
  else
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
