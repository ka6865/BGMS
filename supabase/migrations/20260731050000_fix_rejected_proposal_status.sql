-- 전부 거부된 무기도감 갱신 제안이 pending 으로 남는 문제를 정정한다.
--
-- 배경
--   decide 경로는 weapon_patch_proposal_changes.decision 만 갱신하고
--   제안 행의 status 는 apply_weapon_patch_proposal RPC 만 변경했다.
--   그 결과 관리자가 모든 항목을 거부해도 제안이 검토 대기 목록에 계속 남았다.
--
-- 애플리케이션 코드(decideProposalChanges)가 이후 상태를 재계산하도록 수정했고,
-- 이 마이그레이션은 그 수정 이전에 쌓인 기존 데이터를 정리한다.
update public.weapon_patch_proposals p
set status = 'rejected',
    reviewed_at = coalesce(p.reviewed_at, timezone('utc', now()))
where p.status = 'pending'
  and exists (
    select 1
    from public.weapon_patch_proposal_changes c
    where c.proposal_id = p.id
  )
  and not exists (
    select 1
    from public.weapon_patch_proposal_changes c
    where c.proposal_id = p.id
      and c.decision <> 'rejected'
  );
