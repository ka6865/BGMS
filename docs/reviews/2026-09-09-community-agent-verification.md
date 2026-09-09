# 커뮤니티 비서 구현 검증 기록 — 2026-09-09

## 판정

Task 1~8 구현은 로컬 코드, fixture 제공자, disposable PostgreSQL 17, 격리된 브라우저 harness로 검증했다. 운영 DB·배포·workflow 활성화·실제 공개 게시·외부 댓글 작성은 실행하지 않았다. 따라서 현재 상태는 “운영 중”이 아니라 “운영 적용 전 검증 완료”다.

## Task 8 통합 경계

- 관리자 `configure`의 자동 게시 활성화만 같은 한국 날짜의 `ready` dry-run 승격을 승인한다. RPC는 정책 row 다음 실행 row 순서로 잠그고 현재 날짜, 남아 있는 근거, 발췌 만료, validation hash, 승인된 제목+HTML의 재계산 hash를 확인한다.
- 설정 RPC는 게시 함수를 호출하지 않는다. 실제 게시 RPC도 정책→실행 row를 잠근 transaction 안에서 승인된 제목+HTML의 UTF-8 SHA-256을 다시 계산한 뒤 writer를 호출한다. 직접 dry-run 게시, 이전 날짜, pause, missing evidence, stale approved hash는 거부되며 `published_at` idempotence는 유지된다.
- YouTube는 초기 선택 해제다. 원시 evidence metadata는 JSON에 ID가 남아 있어도 30일 뒤 삭제되며 기존 게시글은 유지된다. 영구 HTML 인용은 서버 소유 출처·열람 라벨과 evidence의 `fetchedAt` 확인 시각을 사용한다.
- YouTube channel cache는 `updated_at`이 아니라 실제 `last_success_at`을 기준으로 30일 뒤 정리한다.
- stalled fetch가 내부 HTTP abort를 따르지 않아도 수집 단계는 40초 deadline 결과로 종료된다. YouTube `fetchedCount`는 playlist/comment API 후보 수, `retainedCount`는 보존된 설명·댓글 수를 나타낸다.
- 네이버 HTTP 401과 YouTube의 명시적인 `keyInvalid`만 자격 증명 `needs_setup`으로 분류한다. quota, 일반 forbidden, comments-disabled 상태는 기존 실패 또는 부분 성공 의미를 유지한다.
- fixture lifecycle은 실제 run route, service, collectors, editorial parser/renderer, runner를 연결하고 외부 HTTP/Gemini와 DB repository를 in-memory `FlowStore`로 대역했다. 세 출처 수집, 모델 최대 3회, ready dry-run, configure 후 1건 게시, 같은 날 재실행 1건 유지, verify 직후 pause 0건, 댓글 write 0건을 확인한다. DB 원자성과 실제 service_role 동작은 별도의 PostgreSQL 및 두 session SQL verifier가 담당한다.

## 기록된 설계 판정과 비용

- 계획의 code snippet은 빠진 fixture·오류 처리를 그대로 복사하는 예제가 아니라 행동 계약으로 해석했다. 통합 test와 runtime 검사를 완성하는 대신 추가 local review 비용을 감수했다.
- 정책 patch는 전달된 필드만 DB lock 아래 갱신한다. 중지 동작은 활성 자동 게시 상태에서도 `enabled=false`, `publishingEnabled=false`를 원자적으로 보내고, `수집 재개`는 게시를 다시 켜지 않는다. 두 필드를 함께 저장하는 UI·RPC 회귀 검증 비용이 들었다.
- 사이트 내부 `배그 소식` 본문은 공식 URL 일치나 관리자 작성만으로 원 제작자 관계를 증명할 수 없어 공식 근거에서 전부 제외한다. 검증된 공식 YouTube description은 계속 허용하고 semantic verifier를 통과해야 한다. 공식 소식 후보가 줄고 신뢰 가능한 원 제작자 연동 전까지 더 자주 보류될 수 있다.
- 같은 날 ready dry-run 승격은 새 공개 action이나 게시물별 승인 UI 대신 기존 관리자 게시 활성화에 묶었다. private transition, SQL/flow coverage, pause/date/hash race 검증 비용이 들며 실패 시 안전하게 dry-run으로 남는다.
- YouTube는 기본 선택 해제, raw metadata 30일 삭제, 영구 static citation label로 결정했다. 모든 인용에 서버 소유 출처·열람 라벨과 확인 시각을 추가해 HTML과 hash가 길어지는 비용이 있고, 운영자가 조건 확인 뒤 출처를 한 번 더 켜야 한다. 법률 준수 전체를 보장한다는 판정은 하지 않았다.
- 자동 게시가 꺼진 일반 pause 중에도 매일 cleanup-only 작업을 유지한다. 별도 인증 route/runner/workflow test 비용이 들지만 수집·모델·게시를 수행하지 않고 Actions나 서버가 꺼지면 실행되지 않는다.

## 로컬 SQL 시나리오

`scripts/verify_community_agent_migration.sh`는 운영 연결 문자열을 읽지 않고 임시 `postgres:17` container를 사용한다. 확인 항목은 다음과 같다.

- RLS와 anon/authenticated 차단, service_role helper 및 configure 실행 권한
- partial policy patch가 지정하지 않은 필드를 덮지 않는 경계와 service-role의 활성 자동 게시 원자 중지
- 같은 날 단일 run, 단계 lease, 3회 model budget, stale lease, 안전한 terminal metadata
- same-day dry-run 승격과 configure 무게시, direct dry-run/pause/date/hash/evidence rejection
- publish transaction의 승인 제목+HTML hash 재계산, stale 제목 무게시·무상태변경, 실제 board writer rollback
- `pgcrypto`가 `extensions` schema에 미리 설치된 상태에서도 `pg_catalog.sha256(bytea)`로 JS의 UTF-8 `title + '\n' + html` hash와 같은 계산
- 동시 publish 1건, 게시글 삭제 후 retry 무재발행
- publish와 stop의 policy lock 직렬화
- 참조된 YouTube 원시 metadata 30일 삭제, 다른 evidence lifecycle 유지, 게시글 보존
- `last_success_at` 기반 stale channel cache 삭제와 최근 성공 cache 보존

## 브라우저 QA

실제 `/admin/bot` page, `CommunityAgentPanel`, global CSS를 격리된 Vite harness와 mock auth/community API로 렌더링했다. Chromium 149에서 1280×800, 375×667, 390×844, 430×932 viewport의 overflow/clipping 부재를 확인했고 1280·375·390·430 screenshot을 모두 시각 검토했다. 탭 왕복, 계정 준비, 6단계 dry-run, 한국어 `발행 준비됨`, pause/resume, 구성 503 rollback, 상태 503/retry, 정확한 세 출처 링크, draft question을 확인했다. 최종 회귀에서는 실제 panel을 `enabled=true`, `publishingEnabled=true`로 시작하고 DB 제약을 흉내 낸 fixture를 사용했다. 수정 전 `{enabled:false}` 요청은 503 뒤 활성 상태로 남았고, 수정 후 `{enabled:false,publishingEnabled:false}` 요청은 둘 다 false로 저장됐다. 이어진 `수집 재개`는 enabled만 true로 바꾸고 publishing은 false로 유지했다. dry-run publish action은 0회였다. 이 결과는 운영 Next API, 실제 인증/DB/제공자, 실제 모바일 Safari를 검증하지 않는다.

## 제한된 실제 연결 증거와 비용

- 디시 adapter local probe: HTTP 200, 실제 갤러리 목록 60건에서 본문 확인 근거 9~10건, 발췌 500자 이하. 운영 배포망 접근 증거는 아니다.
- 실제 Gemini 개발 smoke 3회: 첫 선택 응답과 다음 writer 응답의 schema 문제를 안전하게 보류했고, 수정 후 실제 자료 선택은 `no_topic`으로 보류했다. 실제 자료 기반 완성 글이나 게시 성공을 주장하지 않는다.
- 합성 evidence writer schema smoke 1회: native response schema가 title, 2 paragraphs, root question 및 nested fields로 parsing됐다. 실제 자료 작성 검증은 아니다.
- 기록된 개발 editorial/writer 호출은 5회, prompt 12,713 + completion 1,634 = 14,347 tokens다. 앞선 최소 연결 확인 1회의 token metadata는 없다. 무료 tier를 전제로 검증했지만 유료 전환이나 결제 작업은 수행하지 않았으며 실제 청구 내역은 조회하지 않았다. 기록 token과 청구량이 같다고 주장하지 않는다.
- 로컬 Naver/YouTube key는 없었고 credential 상태도 고정 fixture로만 검증했다. provider API나 production environment는 호출·열람하지 않았다.

## 최종 명령

최종 fix wave의 fresh 실행 결과는 다음과 같다.

```text
npm run verify:community
bash scripts/verify_community_agent_migration.sh
npm run verify:admin
npm run verify:core
git diff --check
```

- `verify:community`: 9 files, 88 tests passed.
- local SQL verifier: PostgreSQL 17 migration, `extensions` schema pgcrypto compatibility, sequential scenarios, 두 session publish/stop lock 시나리오 passed.
- `verify:admin`: 19 files, 382 tests passed.
- `verify:core`: exit 0. TypeScript error 0, ESLint error 0이며 기존 baseline과 같은 warning 52개다.
- `git diff --check`: passed.

운영 DB·배포·실제 게시·provider live call·유료 서비스 변경은 이 fix wave에서 수행하지 않았다.
