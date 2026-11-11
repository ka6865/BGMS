-- 무기 패치 적용 뒤 되돌리기가 값·패치 버전·적용 시각을 모두 적용 전으로 복원하는지 확인한다.
-- 적용 전 시각이 NULL인 행과 이전 시각이 있는 행을 함께 쓴다. 외부 상태를 쓰지 않고 끝에 롤백한다.
BEGIN;
DO $$
DECLARE
  v_proposal uuid := '10000000-0000-0000-0000-0000000000f1';
  v_result record;
BEGIN
  INSERT INTO public.weapons(id, name, type, damage, patch_version, patch_applied_at) VALUES
    ('revert-prior', 'Prior', 'AR', 41, 'old', '2026-01-01T00:00:00Z'),
    ('revert-never', 'Never', 'AR', 41, NULL, NULL);
  INSERT INTO public.weapon_patch_proposals(id, source_url, source_text_hash, patch_label)
  VALUES (v_proposal, 'local-fixture', 'weapon-revert-fixture', 'new');
  INSERT INTO public.weapon_patch_proposal_changes(
    proposal_id, target_table, target_id, column_name, old_value, new_value,
    evidence_quote, evidence_found, validation_state, decision
  )
  SELECT v_proposal, 'weapons', w.id, 'damage', '41'::jsonb, '43'::jsonb, 'local fixture evidence', true, 'ok', 'accepted'
  FROM public.weapons w WHERE w.id IN ('revert-prior', 'revert-never');

  FOR v_result IN SELECT * FROM public.apply_weapon_patch_proposal(v_proposal, NULL) LOOP
    IF v_result.result <> 'applied' THEN
      RAISE EXCEPTION 'FAIL: weapon patch change not applied (%)', v_result.result;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.weapons WHERE id LIKE 'revert-%' AND damage = 43 AND patch_version = 'new' AND patch_applied_at IS NOT NULL) <> 2 THEN
    RAISE EXCEPTION 'FAIL: weapon patch apply readback';
  END IF;

  PERFORM public.revert_weapon_patch_apply(l.id, NULL)
  FROM public.weapon_patch_apply_log l WHERE l.proposal_id = v_proposal;

  IF (SELECT row(damage, patch_version, patch_applied_at)::text FROM public.weapons WHERE id = 'revert-prior')
       IS DISTINCT FROM row(41, 'old'::text, '2026-01-01T00:00:00Z'::timestamptz)::text
    OR (SELECT row(damage, patch_version, patch_applied_at)::text FROM public.weapons WHERE id = 'revert-never')
       IS DISTINCT FROM row(41, NULL::text, NULL::timestamptz)::text
  THEN
    RAISE EXCEPTION 'FAIL: weapon patch revert did not restore value, version and applied time';
  END IF;
  RAISE NOTICE 'PASS: weapon patch revert restores prior and null applied time';
END $$;
ROLLBACK;
