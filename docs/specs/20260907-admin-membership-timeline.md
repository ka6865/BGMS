# 관리자 회원 증감 타임라인 설계 기록

## 현재 데이터 한계

현재 운영 스키마에는 `auth.users.created_at`과 `profiles`만 있고 탈퇴 감사 이벤트가 없습니다. 관리자 삭제는 Auth와 profile을 hard delete하며 orphan profile 정리와 자진 탈퇴를 구분할 근거도 남지 않습니다. 따라서 잔존 Auth 계정의 `created_at`만으로 과거 기간 가입·탈퇴 수나 회원 총수 곡선을 추정하지 않습니다.

## 구현 범위

`GET /api/admin/users?windowDays=7|30|90`은 관리자 세션을 확인한 뒤, 준비된 service-role 전용 `get_user_lifecycle_daily` RPC를 호출해 최대 90개의 KST 일별 `signup`/`deletion` 건수와 수집 시작 메타데이터를 한 번에 받습니다. RPC는 조회 일수를 7/30/90으로 제한하고 종료 시각을 현재 시각 이하로 제한하며 DB에서만 집계합니다. `user_lifecycle_capture_meta.started_at`을 기준으로 수집 전 날짜는 미수집으로 남기며, 기간이 일부만 수집된 경우 KPI를 관측분으로 표시합니다. 테이블·RPC·메타데이터가 없으면 `membership.status=unavailable`과 확인 불가 문구를 반환하며 현재 Auth·profile 목록은 기존 기능대로 유지합니다.

`components/admin/AdminUserCommandCenter`는 관리자 포함 현재 Auth 계정 수, 기간 내 확인된 가입·탈퇴·순증감, KST 막대그래프, 근거 타임라인, 수집 시작일과 데이터 한계를 표시합니다. 전적 검색 대상 닉네임/비회원 방문 이벤트는 회원 증감에 사용하지 않습니다. 기간 변경은 서버 재조회로 처리합니다.
탈퇴 이벤트에는 사유나 실행자를 저장하지 않으므로 orphan profile 정리, 관리자 삭제, 자진 탈퇴를 구분해 단정하지 않습니다.
`currentMembers`는 `deleted_at`이 없는 Auth 유저 수(관리자 포함)로 정의합니다. Auth 구현에 `deleted_at` soft-delete가 있으면 null→값 UPDATE를 탈퇴 이벤트로 기록하고, 그 뒤의 hard delete는 중복 기록하지 않습니다. `deleted_at`이 없는 구현에서는 hard DELETE 시점만 기록되며, 관리자 삭제·자진 탈퇴·orphan 정리 사유는 구분하지 않습니다.

## 향후 수집 (운영 적용 전 검토)

`supabase/migrations/20260907140000_user_lifecycle_events.sql`은 개인정보를 저장하지 않는 `event_type`/`occurred_at` 테이블과 수집 시작일 singleton 메타데이터, `auth.users` INSERT/UPDATE/DELETE 트리거를 준비합니다. 가입 이벤트의 `occurred_at`은 Auth `created_at` 소급값이 아닌 트리거 실행 시각이므로 실제 수집 시점의 이벤트로 해석합니다. RLS를 켜고 `service_role`만 읽도록 하며, 운영 DB에는 자동 적용하지 않습니다. 적용 후 수집 시작일 이전의 hard delete 이력은 복원할 수 없습니다.


### 부모 최종 점검 (2026-09-08)

수집 시작일 전체를 null로 처리하면 실제 당일 가입·삭제 이벤트도 사라지므로, 시작일 관측분은 보존하고 기간을 partial로 안내한다. 시작일 이전 날짜만 null이다. 관리자 포함 active Auth 계정으로 현재 수치와 lifecycle 대상 범위를 맞췄다. 자진 탈퇴·관리자 삭제의 사유는 구분할 수 없다.

최종 SQL은 격리 PostgreSQL에서 KST 첫날 오전 집계 및 soft/hard delete 중복 방지 포함 검증을 통과했다. 운영 migration은 적용하지 않았다. 최초 수집 전의 과거 탈퇴 이력을 복원하지 않으며, 브라우저 시각 QA는 이번 작업에서 별도 실행하지 않았다.
