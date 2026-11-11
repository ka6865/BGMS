-- 무기 패치 되돌리기가 이전 적용 시각을 복원하지 않는 회귀를 고친다.
--
-- 20260730230000_fix_weapon_patch_revert_applied_at 이 patch_applied_at 복원을 추가했지만
-- 20260731060000_weapon_patch_removal 이 revert_weapon_patch_apply 를 다시 정의하면서 그 처리가 빠졌다.
-- 그 결과 되돌린 뒤에도 패치 적용 시각이 새 시각으로 남는다.
-- 함수 본문은 20260731060000 의 최종 정의와 같고, patch_version 복원 부분만 적용 시각을 함께 되돌린다.

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

  -- 적용 시 patch_version 과 patch_applied_at 을 덮어썼다면 둘 다 적용 전 값으로 되돌린다.
  -- 적용 전 시각은 before_row 스냅샷에서 읽는다(20260731060000 이후 적용 로그는 전용 컬럼 previous_patch_applied_at 을 채우지 않는다).
  if v_log.patch_version is not null then
    execute format(
      'update public.%I set patch_version = $1, patch_applied_at = $2 where id = $3',
      v_log.target_table
    ) using v_log.previous_patch_version, (v_log.before_row ->> 'patch_applied_at')::timestamptz, v_log.target_id;
  end if;

  update public.weapon_patch_apply_log
    set reverted_at = timezone('utc', now()),
        reverted_by = p_actor
    where weapon_patch_apply_log.id = p_log_id;
end;
$$;

revoke all on function public.revert_weapon_patch_apply(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revert_weapon_patch_apply(uuid, uuid) to service_role;
