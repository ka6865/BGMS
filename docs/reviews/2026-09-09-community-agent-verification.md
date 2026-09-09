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

판정 7개를 결정 순서대로 보존했다. 원문은 [rulings.md](community-agent-evidence/rulings.md)에 있다.

1. 계획 예제의 누락된 fixture·오류 처리는 행동 계약에 맞춰 완성했다. 해석이 다르면 추가 코드 검토와 수정 비용이 든다.
2. 정책 patch는 전달된 필드만 갱신해 동시 설정 변경이 중지를 되돌리지 않도록 했다. store/RPC와 회귀 검증 비용이 추가됐다. 중지 요청은 두 활성화 필드를 함께 false로 보낸다.
3. 공식 본문과 검증된 공식 YouTube 설명을 사실 근거 후보로 허용하되 검색 요약·제목만 있는 자료는 제외했다. 설명으로 뒷받침되는 사실인지 semantic 검증에 의존하는 한계가 있다.
4. 같은 날 ready dry-run 승격은 기존 관리자의 자동 게시 활성화에 묶었다. private transition과 날짜·근거·hash·중지 경합 검증 비용이 추가됐으며 잘못 구현되면 당일 초안이 보류 상태에 남을 수 있다.
5. YouTube는 기본 선택 해제, 원시 metadata 30일 삭제, 영구 정적 인용 라벨을 적용했다. 출처 이력 상세가 짧아지고 사용 조건 확인 후 별도 활성화가 필요하다. 법률 준수 전체를 보장하지 않는다.
6. 일반적인 게시 중지 중에도 cleanup-only 작업을 유지했다. 별도 인증 route/runner/workflow 검증 비용이 추가된다. Actions나 서버까지 꺼지면 수동 정리가 필요하다.
7. 원 제작자와의 관계를 증명하지 못하는 사이트 내부 소식 본문은 공식 근거에서 제외했다. 공식 URL 복사나 관리자 작성만으로는 충분하지 않다. 신뢰 가능한 연동 전에는 공식 소식 후보가 줄고 더 자주 보류될 수 있다. 검증된 공식 YouTube 설명은 계속 지원한다.

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

## 최종 검토와 보존 자료

최종 수정 커밋은 `05fdb9d517e11feb2cd78cf589c5cde76d0be94c`다. 전체 브랜치 검토 후 한 차례 통합 수정과 해당 diff 재검토를 수행했다. 지적 6개 및 pgcrypto schema 호환성 검증은 모두 해결됐고 새 결함이나 미해결 지적은 없었다. [최종 재검토](community-agent-evidence/final-scoped-review.md), [수정·검증 보고](community-agent-evidence/final-fix-report.md), [중지 버튼 브라우저 회귀](community-agent-evidence/final-pause-browser-qa.md)를 보존했다.

화면 증거: [390px 모바일](community-agent-evidence/ui-final-390.png), [1280px 데스크톱](community-agent-evidence/ui-final-1280.png). 같은 폴더의 live smoke JSON 네 개는 원문이나 자격 증명 없이 연결 상태·응답 구조·token metadata만 보존한다.

구현은 `codex/community-agent` 브랜치의 별도 worktree에 남겨 통합 결정을 기다린다. 전용 브라우저 세션과 검증용 Vite 서버는 종료했다. 부모 checkout의 별도 관리자 관측 기능 변경은 보존했다. 코드·검증·운영 가이드는 커밋으로 남기고 이 계획의 임시 SDD 작업 폴더만 정리한다.
