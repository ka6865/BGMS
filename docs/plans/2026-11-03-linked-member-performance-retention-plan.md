# 연동 회원 성과 보존 구현 계획

> 실행: `superpowers:executing-plans` 지침으로 현재 세션에서 구현하고 검증한다.

**목표:** 연동 회원의 만료 경기 요약을 실제 dry-run으로 검증한 뒤 일일 Actions에 연결한다.
**구조:** 프로필 명단을 중복 제거하고 플랫폼·닉네임별 서비스 전용 RPC로 최대 100건씩 읽는다. 기존 저장·읽기 검증을 재사용하고 실행 전체 상한 1,000건을 유지한다.
**기술:** TypeScript, Supabase PostgREST, PostgreSQL, Vitest, GitHub Actions.
**설계:** `docs/plans/2026-11-03-linked-member-performance-retention-design.md`

## 공통 조건

- 14일 경과, 최근 활동 무관, 정리 커서 불변, 기존 점수·동시 갱신 보호 유지.
- 기존 수동 `--nickname` 경로를 유지하고, 새 `--linked-only`를 실제 검증 후 Actions에 명시한다.
- R2 삭제·회원 UI·새 큐는 변경하지 않는다. 기존 로컬 변경을 보존한다.

## 검토할 실패 조건

- 같은 닉네임의 다른 플랫폼과 중복 프로필을 섞지 않는다.
- 연동 해제·계정 불일치·이미 저장된 요약·최근 경기는 제외한다.
- 잘못된 버전 값이 SQL 캐스팅 예외나 다른 계정 저장으로 이어지지 않는다.
- dry-run은 저장을 호출하지 않고 조회 실패는 전체 실패로 남긴다.
- 사용자별 제한 때문에 후보가 잘리는 경우 실행 요약에 드러낸다.

## 작업 1 원본 조회와 저장 경로

파일: `scripts/preserve_match_performance.ts`, `tests/preserve-match-performance.test.ts`, `supabase/migrations/20261103135922_linked_member_performance_retention.sql`, 신규 격리 DB fixture, `scripts/verify_migrations_local.sh`.

- [x] 연동 중복·플랫폼·미활동·잘못된 응답·상한·dry-run·저장 실패 테스트를 먼저 추가해 실패를 확인한다.
- [x] `preserveLinkedMatchPerformance(db, {apply,limit})`와 서비스 전용 `list_linked_unretained_match_performance(p_platform,p_player_id,p_limit)`를 구현한다.
- [x] 기존 수동 보존·공통 저장 함수의 테스트를 포함해 집중 테스트를 통과시킨다.
- [x] `npm run verify:migrations`로 새 RPC의 권한·14일 경계·identity·상한·커서 불변을 확인한다.

## 작업 2 실제 스크립트 확인

- [x] 연결 프로젝트와 신규 migration만 적용되는지 dry-run으로 확인한다.
- [x] 운영 데이터의 `--linked-only --dry-run --limit 1000`을 실행해 실제 원본 변환·조회 시간·제외 사유를 확인한다.
- [x] dry-run의 저장 0건, 기존 요약 보호와 후보 잘림 여부를 확인한 뒤 다음 작업으로 진행한다.

## 작업 3 Actions 연결과 최종 검증

파일: `.github/workflows/daily-tasks.yml`, `tests/daily-tasks-workflow.test.ts`, `docs/operations/2026-10-06-match-detail-retention.md`, 로컬 `docs-private/.project_context.md`.

- [x] 일일 보존 명령에 `--linked-only`를 추가하고 기존 백업 gate가 유지되는지 검증한다.
- [x] `npm run verify:core`, `npm run verify:analysis`, `npm run test:unit`을 실행한다.
- [x] 변경 전체를 별도로 리뷰하고 실제 실행 결과와 남은 운영 적용 범위를 보고한다.

## 진행 기록

- 2026-11-03: 구현 요청과 실제 dry-run 후 Actions 변경 순서를 확인했다. 기존 미커밋 변경을 보존하기 위해 현재 체크아웃에서 기능 브랜치 `codex/linked-member-retention`을 만들었다.
- 결정: 명시적인 `--linked-only`를 추가한다. 기존 수동 CLI 동작을 유지하면서 검증된 경로만 Actions에서 선택하기 위함이다.

- 운영 적용: 원격에만 있는 기존 migration 3건은 유지했다. 원격 이력을 읽어 만든 임시 작업 폴더에서 신규 `20261103135922` 하나만 dry-run 확인 후 적용했다. 공개·authenticated 실행 권한 없음과 service_role 실행 권한을 재확인했다.
- 실제 dry-run: 85대상, 조회305건·변환304건·제외1건·저장0건, 24.02초, 최대조회3130ms, 상한도달0.
- 검증: 단위 테스트 6,329개 통과, analysis 1,145개 통과, 격리 migration 전체 통과. `verify:core`는 기존 로컬 `docs-private/coaching-role-evidence-2026-10-29/pending-extra-replay.ts`의 깨진 import 2건 때문에 실패해 별도 타입 검증과 원격 CI를 구분한다.
- 최종 리뷰: 별도 에이전트 도구가 없어 작성자가 전체 diff·저장 호출부·SQL·workflow를 독립 단계로 재검토했다.

- 실제 적용 확인: 조회307·변환306·저장후검증306·제외1, 31.56초. 제외 자료는 순위0인 tutorialatoz 경기다. 변경 파일 lint와 로컬 전용 폴더를 제외한 타입 검사도 통과했다.
