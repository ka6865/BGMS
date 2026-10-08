-- 기존 보존 검증과 권한은 유지하고 외부에 노출할 고정 실패 사유만 추가한다.
do $migration$
declare
  old_raise constant text := $old$raise exception 'legacy-team-retention-recovery-failed' using errcode = 'P0001';$old$;
  new_raise constant text := $new$raise exception 'legacy-team-retention-recovery-failed' using errcode = 'P0001',
    detail = case
      when sqlstate = '55P03' then 'lock-unavailable'
      when sqlerrm = 'recovery-lock-budget-exceeded' then 'lock-budget-exceeded'
      when sqlerrm in ('source snapshot changed', 'target snapshot changed') then 'snapshot-changed'
      when sqlerrm = 'active lease' then 'active-lease'
      when sqlerrm = 'target or account already exists' then 'target-exists'
      else 'validation-rejected'
    end;$new$;
  definition text;
begin
  select pg_catalog.pg_get_functiondef('public.recover_retention_legacy_team(jsonb)'::regprocedure)
    into definition;
  if pg_catalog.array_length(pg_catalog.string_to_array(definition, old_raise), 1) <> 2 then
    raise exception 'unexpected legacy team retention function definition';
  end if;
  execute pg_catalog.replace(definition, old_raise, new_raise);
end;
$migration$;
