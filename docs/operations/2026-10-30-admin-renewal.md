# 관리자 기능 정비(admin-renewal)

작성일: 2026-10-30. 브랜치 `ka6865/admin-renewal`의 코드·문서 변경 기록이며 운영 실행 기록이 아니다. 운영 배포, DB 마이그레이션 적용, 워크플로 실행은 이 문서 작성 시점에 하지 않았다.

## 분석 캐시·벤치마크 일괄 삭제 기능 제거

| 항목 | 이전 | 이후 |
| --- | --- | --- |
| `POST /api/admin/system` | `flush_old_cache`(분석 결과 `processed_match_telemetry` 전체 삭제), `flush_player_cache`(닉네임별 분석 결과 삭제), `flush_match_cache`(매치별 분석 결과와 Storage `telemetry/{matchId}.json` 삭제), `reset_benchmarks`(`global_benchmarks` 전체 삭제) | route 파일 삭제. 관리자 데이터 관리 화면(`GameDataEditor`)의 해당 버튼도 제거 |
| Admin Agent 도구 | `request_cache_cleanup`이 위 네 작업의 승인 요청을 만들고 승인 후 실행 | 도구 선언·executor·영향 계산·승인 실행 경로 제거 |
| 과거 승인 기록 | `flush_old_cache`, `flush_player_cache`, `flush_match_cache`, `reset_benchmarks` 유형은 고위험 승인 대상 | 지원하지 않는 작업으로 실행을 차단하고, 목록에는 `(제거된 기능)` 라벨과 함께 이름만 표시 |

### 제거 이유

PUBG API는 경기 원본 텔레메트리를 약 14일만 제공한다. 그보다 오래된 경기의 `processed_match_telemetry`와 성과 기준값 `global_benchmarks`는 지운 뒤 다시 만들 수 없다. 일괄 삭제는 "캐시는 재생성할 수 있다"는 전제였으나 이 전제가 성립하지 않는다. `scripts/backup_core_tables.ts`도 같은 이유로 분석 캐시를 재생성 가능하다고 가정하지 않고 `global_benchmarks`를 복구 기준 데이터로 백업한다.

남은 정리 경로는 보존 기준이 있는 작업이다(예: 플레이어 캐시 압축 `compact_pubg_player_cache`, 일일 작업의 보존 정리). 개별 데이터 보정이 필요하면 해당 도메인의 스크립트를 dry-run으로 먼저 확인한다.

### 이전 문서와의 관계

- [2026-10-10-remaining-review-fixes.md](2026-10-10-remaining-review-fixes.md)의 `관리자의 매치 캐시 삭제` 행은 제거된 `flush_match_cache` 동작을 설명한다. 해당 문서의 migration 적용 절차는 유지되지만 이 행은 더 이상 현재 동작이 아니다.
- `docs/reviews/`의 날짜형 리뷰에 남은 `/api/admin/system`, `flush_*`, `reset_benchmarks` 언급은 당시 기록이므로 고치지 않았다.

## 커뮤니티 비서 workflow 실패 알림

- `.github/workflows/community-agent.yml`, `.github/workflows/community-reviews.yml`에 `daily-tasks.yml`과 같은 방식의 `failure-notify` 잡을 추가했다. 본 작업 잡이 실패하거나 시간 초과되면 `DISCORD_WEBHOOK_URL`로 알린다.
- `community-agent.yml`은 `vars.APP_URL` 또는 `secrets.COMMUNITY_AGENT_WORKER_SECRET`이 비어 있으면 성공(`configured=false`) 대신 `::error::`와 함께 실패한다. 예약이 켜진 `community-reviews.yml`도 같은 설정 확인 단계를 둔다.
- 운영 영향: 운영 저장소에 두 설정이 없다면 배포 후 매일 실패와 알림이 시작된다. 자세한 동작은 [커뮤니티 비서 운영](../community-agent-operations.md)의 `정지 중 cleanup`, `실패 알림`을 본다.

## 백엔드 안전장치

| 영역 | 변경 | 주요 파일 |
| --- | --- | --- |
| 관리자 권한 확인 | 개별 `verifyAdmin` 복사본과 인라인 role 확인을 `requireAdmin()`으로 통일했다. Bearer와 쿠키를 모두 받고, role은 service role로 조회한다. 미인증은 401이다. | `lib/server/adminGuard.ts`, `app/api/admin/{users,dashboard,game-data,crates/*,private-players,settings,posts/delete,patch-notes/sync,reports,approve,reject}/route.ts` |
| 감사 기록 | `admin_audit_events`에 회원 삭제·권한 변경, 게시글 강제 삭제, 신고 처리, 제보 승인·거절, 무기 패치 반영·되돌리기, 비공개 플레이어 변경, 고객지원 개인정보 처리를 남긴다. 기록 실패는 조작을 막지 않고 `[ADMIN-AUDIT]` 서버 로그로 남긴다. | `lib/server/adminAudit.ts` |
| 회원 관리 | admin 계정 삭제를 거부한다(먼저 강등). 본인 강등과 마지막 admin 강등을 거부한다. | `app/api/admin/users/route.ts` |
| 게시글 강제 삭제 | `comments`·`post_likes` 등이 `posts(id) ON DELETE CASCADE`이므로 게시글 한 건만 지워 한 트랜잭션으로 처리한다. postId는 양의 정수만 받는다. 이메일 로그와 응답의 role 노출을 없앴다. | `app/api/admin/posts/delete/route.ts` |
| 승인 gate | 고위험 작업은 영향 계산 오류나 유효 대상 0건 같은 checklist warning이 있으면 차단한다. 승인 요청 저장에 실패하면 "등록되었습니다" 대신 실패를 반환한다. | `lib/admin-agent/impact.ts`, `lib/admin-agent/logging.ts`, `lib/admin-agent/tools.ts` |
| AI 비서 | 도구 호출은 최대 6회, 전체 40초로 제한한다(화면은 45초에 연결을 끊는다). 초과하면 `[자동 중단]`을 안내하고 run을 `completed`, error `run_cutoff: …`로 닫아 실패 실행 집계에 넣지 않는다. 등록되지 않은 도구는 `dangerous`로 기록한다. 지도 캡처는 버킷을 만들지 않고 `map-captures`가 없으면 실패한다. 외부 API 호출에 8초 timeout이 있다. | `app/api/admin/bot/run/route.ts`, `lib/admin-agent/tools.ts` |
| 관제 | command-center와 monitor는 조회 항목별로 실패를 분리한다(`degradedSources`). command-center는 읽지 못한 항목이 있으면 상태를 최소 `warn`으로 올리고, 대시보드는 해당 수치를 "확인 불가"로 표시한다. Vercel 조회 timeout은 8초다. cron secret은 상수 시간으로 비교한다. monitor는 POST만 받는다(`daily-tasks.yml`도 `-X POST`로 변경). | `lib/admin-agent/settle.ts`, `lib/admin-agent/cron-auth.ts`, `app/api/admin/agent/{command-center,monitor,rollout}/route.ts` |
| 방문 지표 | `is_internal=true` 이벤트는 쿼리 단계(`eq("is_internal", false)`)에서 빼서 조회 상한을 차지하지 않게 하고, 건수는 별도 count 쿼리로 `internalEventsExcluded`에 보고한다. 조회 상한 10,000건에 닿으면 traffic summary가 `truncated=true`다. | `lib/admin-agent/traffic-summary.ts`, `lib/admin-agent/user-metrics.ts` |
| 입력 검증 | 패치노트 원문 요청은 https이면서 `pubg.com`, `daum.net`, `kakao.com`과 그 하위 도메인만 받는다. redirect는 자동으로 따라가지 않고 매 단계 주소를 다시 검증하며(최대 3회), 상세 페이지 요청에도 15초 timeout이 있다. `maxDuration=60`이다. 신고 조회는 status를 검증하고 200건으로 제한한다. 브리핑 시간 범위는 1~168시간이다. 응답에서 DB 오류 원문을 뺐다. | `lib/server/patchNoteSource.ts`, `app/api/admin/{patch-notes/sync,reports}/route.ts`, `app/api/admin/agent/briefing/route.ts` |

## 관리자 화면

- `app/admin/layout.tsx`와 `components/admin/AdminNav.tsx`로 모든 관리자 화면에 같은 메뉴를 둔다. 순서는 운영 대시보드, AI 비서, 데이터 관리, 지도 제보 심사, 맵 설정, 고객센터, AI 코칭 품질이다. LoL 개발 메뉴는 `LOL_DEV_ENABLED=true`일 때만 보인다. 모바일은 가로 스크롤이고 항목 높이는 44px 이상이다.
- 운영 대시보드:
  - 신고 처리(내용 숨김, IP 차단, 기각)는 확인 창을 거친다. IP 차단은 신고자가 아니라 신고된 글·댓글 작성자의 IP를 차단한다.
  - 신고 조회가 실패하면 빈 목록 대신 오류와 다시 시도 버튼을 보여준다. 늦게 온 응답은 버린다.
  - command-center, 승인 목록, 내부 기록 조회가 실패하면 화면을 막지 않는 배너가 뜬다.
  - 대시보드 탭 "데이터 관리"는 메뉴 항목과 이름이 겹쳐 "저장 공간"으로 바꿨다.
- 지도 제보 심사: 승인("지도에 반영")과 거절("제보 거절(삭제)")은 확인 창을 거치고, 요청 중에는 두 버튼이 잠긴다.
- 무기 패치 검토: 반영과 되돌리기 전에 확인 창을 거친다.
- 데이터 관리: 권한 확인 중 로딩을 표시한다. 회원 삭제 중에는 중복 실행을 막는다. 캐시·벤치마크 삭제 버튼은 없고, 탭 이름은 "시스템 설정"이다.
- 맵 설정: 모바일 여백, 탭 가로 스크롤, 라벨 연결을 정리했다.
- AI 비서: 관리자 대화 탭에서는 화면 탭(관리자 대화·커뮤니티 운영)을 채팅 헤더 안에 넣고 중복된 뒤로가기·제목 줄을 없앴다. 휴대폰(375x667)에서 대화 영역 시작 위치가 약 230px에서 158px로 올라온다. 관리자 메뉴의 세로 여백도 모바일에서 줄였다(항목 높이 44px 유지).
- 과거 승인 기록 중 제거된 네 작업은 대시보드 승인 목록에 `(제거된 기능)` 라벨로 표시되고, 실행 gate가 지원하지 않는 작업으로 차단한다.
- 모바일 확인: 격리 브라우저 하네스(`RUN_ADMIN_BROWSER_SMOKE=true npx vitest run tests/admin-dashboard-browser-smoke.test.ts`)로 375x667, 390x844, 430x932, 1440x900을 확인했다. 대시보드(정리·승인·거절·신고·메뉴·병아리 겹침·일부 조회 실패 표시), 지도 제보 심사, 맵 설정, 데이터 관리, AI 코칭 품질, AI 비서(대화·커뮤니티 운영)를 다룬다. 실기기, iOS Safari, 앱 WebView는 확인하지 않았다.

## DB 마이그레이션 적용 절차

- 파일: `supabase/migrations/20261031010000_admin_audit_events.sql` 하나다. 테이블 `public.admin_audit_events`와 인덱스 2개를 만든다. RLS를 켜고 정책을 두지 않으며 anon·authenticated 권한을 회수한다.
- 앱 배포와 순서를 맞출 필요는 없다. 적용 전에 배포해도 조작은 동작하고, 감사 기록만 실패해 서버 로그에 남는다.
- 격리 검증: `npm run verify:migrations` 통과. Docker가 꺼져 있어 스크립트가 지원하는 로컬 PostgreSQL 17 일회용 클러스터를 사용했다. 시나리오는 `tests/fixtures/migration-check/admin-audit-events-scenarios.sql`이다.
- 운영 적용은 아직 하지 않았다. 적용 후 확인 쿼리: `select relrowsecurity from pg_class where relname = 'admin_audit_events';`가 `true`이고, `select has_table_privilege('authenticated', 'public.admin_audit_events', 'select');`가 `false`여야 한다.
- 보존 기간과 정리 작업은 정하지 않았다.

## 검증

- `npm run verify:core`: 통과(오류 0, 기존 경고 44건).
- `npx vitest run`: 419 files, 5737 tests 통과(15 files, 256 tests skip).
- `RUN_ADMIN_BROWSER_SMOKE=true npx vitest run tests/admin-dashboard-browser-smoke.test.ts`: 21 tests 통과.
- `npm run verify:migrations`: 통과.
- 실행하지 않은 것: `tests/lol-dev-browser.test.ts`(`RUN_LOL_DEV_BROWSER` 필요), 실제 운영 DB·Discord·Gemini 연결, workflow 실제 실행(로컬 YAML 파싱과 `bash -n`만 확인).
