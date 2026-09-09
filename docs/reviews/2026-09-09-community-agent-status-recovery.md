# 커뮤니티 운영 상태 조회 복구 — 2026-09-09

## 원인

`develop` 병합 후 로컬 관리자 화면은 열렸지만 GET `/api/admin/agent/community`가 503을 반환했다. 관리자 인증은 통과했다. 같은 서버 환경과 실제 CommunityStore의 `getPolicy`, `getSources`, `recentRuns(7)`로 재현한 결과 모두 존재하지 않는 community 테이블의 PGRST205로 실패했다. DB catalog와 migration history에도 이 기능의 객체·적용 기록이 없었다. 첫 HEAD-only probe는 204로 반환되어 테이블 존재 증거로 사용하지 않았으며 GET과 DB catalog로 확정했다.

## 적용

- 대상: 기존 서버가 연결된 BGMS Supabase 프로젝트.
- 원본: `supabase/migrations/20260908000000_community_agent_persistence.sql` (앞서 로컬 PostgreSQL 17 검증과 코드 재검토를 통과한 SQL 그대로).
- Supabase MCP 적용 이름: `community_agent_persistence`; 원격 기록 version: `20260909061622`.
- 사전 확인: profiles/posts/agent_runs 존재, 기존 board writer의 17개 인자 서명 일치, community 객체·migration 없음.
- 추가: 전용 테이블 4개, 인덱스, 제약·trigger, service-role 전용 RPC, 비활성 기본 정책 1건과 출처 설정 3건.
- 기존 회원·게시글 데이터 변경/삭제, 비서 계정 생성, 수집·모델 호출·게시·cleanup 실행 없음.

## 적용 후 검증

동일한 서버 환경과 실제 CommunityStore로 세 상태 조회를 병렬 실행해 모두 성공했다. `enabled=false`, `publishingEnabled=false`, bot 미준비, 하루 글 제한 1, 출처 설정 3건, 실행 기록 0건이다. DB에서도 evidence와 run이 모두 0건임을 확인했다.

네 테이블 모두 RLS=true, anon/authenticated SELECT=false, service_role SELECT=true다. 초기 테이블·인덱스 합계는 139,264 bytes (136 KiB)다. 적용 전 DB 전체 크기 측정은 503,852,179 bytes이며 변경 전후 전체 크기의 차이를 이 migration만의 비용으로 단정하지 않는다.

화면은 `다시 시도` 또는 새로고침으로 새 상태를 조회할 수 있다. 이 검증은 실제 DB repository 경계를 확인한 것이며 사용자 로그인 세션을 복제하거나 관리자 인증을 우회하지 않았다. 기존 코드의 인증 경로를 변경하지 않았다.

## 중지와 이력

수집·게시는 기본 비활성이라 별도 rollback 조치 없이 중지 상태다. 장애 대응 시 기존 정책 중지를 유지하며 테이블 삭제를 수행하지 않는다. 원격 MCP가 부여한 version과 원본 파일 timestamp는 위에 함께 기록했다. 향후 CLI 일괄 적용 전 migration 이력을 확인한다.

## 보안 advisor 확인

이번 community 객체의 결과는 RLS 활성화 후 공개 정책이 없다는 INFO 4건이다. 서비스 역할 전용 테이블이며 anon/authenticated 권한을 회수한 의도된 구조다. 관련 WARN/ERROR는 없었다. [Supabase RLS 안내](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)를 참조한다. 다른 기존 객체의 진단 항목은 이번 수정 범위에 포함하지 않았다.
