# 마이그레이션 반영 목록 및 감사 지적사항 수정 결과

- 점검일: 2026-07-30
- 대상: 연결된 BGMS 운영 Supabase (`supabase migration list --linked`)
- 운영 변경: **없음** (읽기 전용 조회 + dry-run 만 수행)

---

## 1. 마이그레이션 반영 필요 목록

`supabase db push --linked --dry-run` 결과 미적용 마이그레이션은 4건이다.
그 외 로컬 36건은 원격 이력과 완전히 동기화되어 있다.

| 순서 | 파일 | 목적 | 위험도 |
| --- | --- | --- | --- |
| 1 | `20260730200100_weapon_patch_proposals.sql` | 패치노트 기반 무기도감 갱신 제안·승인 파이프라인 (테이블 3개, 화이트리스트 함수, 적용/되돌리기 RPC) | 신규 객체만 생성. 기존 테이블 변경 없음 |
| 2 | `20260730203000_tighten_service_data_write_policies.sql` | 서버 전용 데이터 테이블의 느슨한 쓰기 정책 교체 | **기존 정책 교체.** 읽기 정책은 건드리지 않음 |
| 3 | `20260730204500_discord_room_rate_limit.sql` | Discord 음성 채널 생성 쿼터 테이블·RPC | 신규 객체만 생성 |
| 4 | `20260730210000_pubg_response_cache.sql` | PUBG API 응답 분산 캐시·강제 갱신 락 테이블·RPC | 신규 객체만 생성 |

### dry-run 출력

```
Would push these migrations:
 • 20260730200100_weapon_patch_proposals.sql
 • 20260730203000_tighten_service_data_write_policies.sql
 • 20260730204500_discord_room_rate_limit.sql
 • 20260730210000_pubg_response_cache.sql
```

### 2번 마이그레이션 반영 시 주의

`20260730203000` 은 유일하게 기존 정책을 교체한다. 적용 후 다음이 변한다.

- `pubg_player_cache` 쓰기: anon 포함 누구나 가능 → service_role 전용
- `processed_match_telemetry` 쓰기: 로그인 사용자 가능 → service_role 전용
- `match_stats_raw` INSERT: 로그인 사용자 가능 → service_role 전용
- 위 3개 테이블 + `match_master_telemetry`, `global_benchmarks`, `sync_history` 의
  anon/authenticated INSERT·UPDATE·DELETE 권한 회수

이 테이블에 쓰는 코드 경로를 전수 확인해 브라우저 쓰기가 없음을 확인했다.

- `app/api/pubg/match/route.ts:57-59` — `createClient(..., SUPABASE_SERVICE_ROLE_KEY)`
- `lib/pubg-analysis/persistMatchAnalysis.ts` — 위 라우트가 주입한 클라이언트를 사용
- 브라우저 코드(`app/stats/.../weapons/page.tsx:27`, `actions/rankings.ts:80`)는 읽기만 수행

`pending_markers` 는 범위에서 제외했다. `components/map/ReportForm.tsx:63,101` 이
브라우저에서 직접 INSERT/UPDATE 하므로 정책을 좁히면 제보 기능이 즉시 깨진다.
제보 쓰기를 API 라우트로 이전하는 별도 작업으로 추적해야 한다.

### 검증 결과

운영과 분리된 PostgreSQL 17 일회용 컨테이너에 4건을 순서대로 적용하고
RPC 동작 시나리오 12건을 실행해 전부 통과했다. 재현 명령은 `npm run verify:migrations`.

```
✅ 20260730200100_weapon_patch_proposals
✅ 20260730203000_tighten_service_data_write_policies
✅ 20260730204500_discord_room_rate_limit
✅ 20260730210000_pubg_response_cache
PASS: 적용 + 로그 + 상태 전이
PASS: 되돌리기
PASS: stale 스킵
PASS: invalid 항목 승인 차단
PASS: 화이트리스트 밖 컬럼 거부 (column not editable: weapons.name)
PASS: 중복 해시 차단
PASS: integer 캐스팅
PASS: Discord 방 쿼터
PASS: 캐시 read/write/TTL 상한
PASS: 강제 갱신 쿨다운
PASS: 쓰기 정책·권한 강화 확인
PASS: 신규 테이블 RLS + 권한 격리
```

### 남은 baseline 결함

저장소의 전체 migration 재생은 여전히 불가하다. `20260526022000_auth_profiles_trigger.sql`
이 생성 이력이 없는 `public.profiles` 를 참조한다. 2026-07-22 점검에서 이미 지적된 항목이고
이번 작업에서도 해결하지 않았다. `weapons` 등 게임 데이터 테이블도 CREATE TABLE 이력이 없다
(Supabase 콘솔 수동 생성). baseline 복구는 별도 작업으로 남는다.

---

## 2. 이전 감사 결론 정정

2026-07-30 초기 감사에서 "`processed_match_telemetry` / `sync_history` /
`global_benchmarks` / `comments` 에 RLS 미설정"이라고 보고했다. **이는 오류다.**
마이그레이션 파일에 `ENABLE ROW LEVEL SECURITY` 문이 없다는 사실만으로 판단했기 때문이다.

운영 `pg_class.relrowsecurity` 를 직접 조회한 결과 **public 스키마 51개 테이블 전부에
RLS 가 활성화되어 있었다.** 콘솔에서 테이블을 만들 때 함께 켜졌다.

실제 취약점은 RLS 유무가 아니라 **정책 내용**이었다.

| 테이블 | 정책 | 실제 조건 | 문제 |
| --- | --- | --- | --- |
| `pubg_player_cache` | `"Service Role Write"` ALL `{public}` | `using true` / `check true` | 이름과 달리 조건이 `true`. anon 키만으로 전체 플레이어 캐시 INSERT/UPDATE/DELETE 가능 |
| `processed_match_telemetry` | `"Allow authenticated insert"` / `"...update"` | `auth.role() = 'authenticated'` | 로그인 사용자가 PostgREST 로 분석 캐시 위조 가능 |
| `match_stats_raw` | `"Allow authenticated insert only"` | `auth.role() = 'authenticated'` | 동일 |

RLS 가 켜져 있고 정책이 0개인 테이블(`ai_usage_logs`, `analytics_events`,
`agent_*`, `match_ai_coaching_cache` 등)은 기본 거부이므로 안전하다.

---

## 3. 감사 지적사항 수정 결과

| # | 심각도 | 항목 | 상태 | 근거 |
| --- | --- | --- | --- | --- |
| 1 | 치명 | Discord 웹훅 메시지에 `ADMIN_SECRET_TOKEN` 평문 노출 | 수정 | `app/api/cron/patch-notes/route.ts` 의 `quickSyncLink` 제거, 관리자 페이지 안내로 대체 |
| 2 | 치명 | cron 인증의 `NODE_ENV === "production"` 우회 | 수정 | 조건 제거 + 쿼리 파라미터 secret 폐기, `lib/server/secretAuth.ts` 의 Bearer 헤더 + 상수 시간 비교만 허용 |
| 3 | 높음 | `/api/discord/room/create` 무인증·레이트리밋 부재 | 수정 | `withAuthGuard` 로그인 필수 + `consume_discord_room_quota` (사용자 3/시간, 전체 20/시간) + type·표시명 화이트리스트 |
| 4 | 높음 | 서버 데이터 테이블 쓰기 정책 과다 허용 | 수정 | `20260730203000` (2절 참조) |
| 5 | 높음 | 게시글 본문 SSR sanitize 우회 | 수정 | `lib/board/sanitizeHtml.ts` 신설, 저장 시점(`api/posts/write`)과 SSR 시점(`app/board/[postId]/page.tsx`) 양쪽 적용 |
| 6 | 높음 | `/api/admin/game-data` 테이블·컬럼 화이트리스트 부재 | 수정 | `lib/patch-notes/weaponSchema.ts` 화이트리스트 공유 |
| 7 | 중간 | PUBG API 인메모리 캐시 (서버리스 히트율 저하, 쿨다운 우회) | 수정 | `lib/pubg/responseCache.ts` L1+L2 2단 캐시, DB 장애 시 성능 저하 모드 |
| 8 | 중간 | 크롤링 정규식 실패를 조용히 성공 처리 | 수정 | 추출 0건이면 Discord 알림 + HTTP 502 (`list_parse_failed`) |
| 9 | 중간 | GitHub Actions 실패 알림 부재 | 수정 | `failure-notify` 잡 추가 (`if: failure()`) |
| 10 | 중간 | `analytics_events` RLS 정책 미정의 | 정정 | 의도된 service_role 전용. 신규 테이블에도 동일 방침을 주석으로 명시 |
| 11 | 중간 | `/api/cleanup` 쿼리 파라미터 토큰 | 수정 | Bearer 헤더 전용으로 전환 |
| 12 | 낮음 | AI 생성 HTML 이 sanitize 없이 DB 저장 | 수정 | cron·admin sync·CLI 3경로 모두 저장 전 `sanitizeBoardHtml` 적용 |
| 13 | 낮음 | 캐시 테이블 RLS 미확인 | 확인 완료 | 2절 조회 결과로 확정 |
| 14 | 낮음 | 인메모리 PUBG 에러 큐 한계 | 부분 | `reserve_pubg_api_alert_delivery` RPC 로 알림 중복은 이미 DB 기반. 에러 카운팅 자체는 여전히 인스턴스 로컬 |
| 15 | 낮음 | GHA `ADMIN_SECRET_TOKEN` 노출 면적 | 수정 | `Sync Patch Notes` step 에서 미사용 secret 제거 |

### 유지보수 부채 정리 (함께 처리)

- `identifyCategory` 3중 중복 → `lib/patch-notes/categorize.ts` 단일 정의
- `scripts/cleanup_pubg_cache.ts` 추가 + 일일 작업에 정리 step 편성

---

## 3-1. 독립 감사 재발견 항목과 수정

수정 후 별도 감사자에게 코드를 재검증시켜 결함 2건을 추가로 찾았고 모두 고쳤다.

### [높음] `app/api/pubg/player/route.ts` — anon 클라이언트로 `pubg_player_cache` upsert

이 라우트의 `supabase` 는 `@/utils/supabase/server` 의 anon 키 클라이언트다.
`20260730203000` 이 anon 쓰기 권한을 회수하면 이 upsert 가 조용히 실패한다.
`.then(() => undefined)` fire-and-forget 이라 오류도 감지되지 않아
검색 횟수·시즌 통계·클랜 데이터의 DB 영구 캐시 갱신이 중단됐을 것이다.

수정: `createServiceRoleClient()` 로 교체하고 실패 시 명시적으로 로깅한다.
회귀 방지 테스트는 `tests/security-hardening-runtime.test.ts` 의
"pubg_player_cache 쓰기는 service_role 클라이언트를 사용한다".

### [중간] `lib/board/sanitizeHtml.ts` — iframe src 에 프로토콜 상대 URL 통과

`isSafeUrl()` 은 스킴이 없으면 상대 경로로 보고 허용했다. iframe 에는 이 규칙이 너무 느슨해
`<iframe src="//evil.com/phishing">` 와 `<iframe src="/admin/game-data">` 가 통과했다.

수정: iframe src 전용 검사(`isSafeIframeSrc`)를 분리했다. https 절대 URL + 동영상 플랫폼
호스트 화이트리스트만 허용하고, src 가 제거된 iframe 은 태그 자체를 삭제한다.
테스트는 `tests/board-html-sanitize.test.ts` 의
"iframe src 는 허용 호스트의 https 절대 URL 만 통과한다".

### [지적 수용] 계약 테스트만으로는 보안 속성을 증명하지 못한다

기존 `tests/security-hardening-boundary.test.ts` 는 소스 문자열 존재만 확인해
구현을 no-op 으로 바꿔도 통과할 수 있었다. 실제 라우트를 실행하는
`tests/security-hardening-runtime.test.ts` (16개)를 추가했다.

- `/api/cleanup`: 헤더 없음 / 쿼리 파라미터 토큰 / 잘못된 토큰 / 같은 길이의 다른 토큰 / 환경변수 미설정 → 전부 401
- `/api/cron/patch-notes`: `NODE_ENV=development` 에서도 401, 쿼리 파라미터 secret 401, Bearer 접두어 없는 헤더 401
- `/api/discord/room/create`: 미인증 401·쿼터 초과 429·RPC 오류 503 각 케이스에서 Discord API 호출이 발생하지 않음을 `fetch` 스파이로 확인. 잘못된 type 400 이며 쿼터를 소비하지 않음. 표시명이 24자로 잘리고 멘션·마크다운 문자가 제거됨

### 감사에서 "인지된 한계"로 확인한 항목

- `timingSafeEqual` 은 길이가 다르면 예외를 던지므로 사전 길이 비교가 필요하고, 그 결과 토큰 길이는 누수된다. 고정 길이 시크릿에서는 실용적 위험이 낮다.
- `apply_weapon_patch_proposal` 의 `format(... %s ...)` 에 들어가는 `v_column_type` 은 `pg_attribute` 카탈로그에서 읽은 값이며 사용자 입력이 아니다. 테이블·컬럼 화이트리스트가 선행 검증한다.
- L1 미스 시 DB RPC 1회가 추가되지만, L2 히트 시 PUBG API 호출(수백 ms)을 건너뛰므로 전체적으로는 개선이다.

### 미처리로 남긴 항목

- `pending_markers` 쓰기 정책 (1절 참조. 제보 쓰기를 API 라우트로 이전해야 함)
- migration baseline 복구 (`public.profiles`, 게임 데이터 테이블 CREATE 이력 부재)
- 패치노트 요약 본문 길이 상수 일원화 (현재 15000 / 8000 / 5000자로 갈라져 있음)

---

## 4. 검증 요약

| 검증 | 결과 |
| --- | --- |
| `tsc --noEmit` | 오류 0건 |
| Vitest 전체 | 62 files / 774 passed, 1 file·6 tests skip (Gemini 실호출 통합 테스트, 기본 skip) |
| Jest | 6 suites / 12 passed |
| ESLint 총계 | 15943 problems (1736 errors, 14207 warnings) — 작업 시작 전 기준선과 **동일**. 신규 lint 문제 0건 |
| 신규/수정 파일 단독 ESLint | 경고 1건 (cron 라우트의 기존 미사용 `date` 변수) |
| `npm run verify:migrations` | 마이그레이션 4건 적용 + RPC 시나리오 12건 전부 PASS |

신규 테스트 파일

| 파일 | 케이스 수 | 역할 |
| --- | --- | --- |
| `tests/weapon-patch-validate.test.ts` | 16 | 검증 게이트(인용문 대조 포함) |
| `tests/weapon-patch-extract.test.ts` | 16 | 구조화 추출·응답 파싱 |
| `tests/weapon-patch-schema-parity.test.ts` | 11 | TS/SQL 화이트리스트 일치, 마이그레이션 계약 |
| `tests/weapon-patch-boundary.test.ts` | 10 | 제안 저장 경계, 관리자 편집 화이트리스트 |
| `tests/board-html-sanitize.test.ts` | 19 | XSS 정화 (iframe 우회 벡터 포함) |
| `tests/pubg-response-cache.test.ts` | 15 | 분산 캐시 L1/L2, 마이그레이션 계약 |
| `tests/security-hardening-boundary.test.ts` | 30 | 보안 패턴 회귀 감지(계약 테스트) |
| `tests/security-hardening-runtime.test.ts` | 16 | 라우트 실제 실행 기반 인증·쿼터 검증 |

---

## 5. 반영 절차 제안

1. `npm run verify:migrations` 로 일회용 DB 검증 재확인
2. `supabase db push --linked --dry-run` 으로 4건만 나오는지 확인
3. 2번 마이그레이션의 정책 교체 영향 최종 확인 (1절 주의사항)
4. 승인 후 `supabase db push --linked`
5. 적용 직후 `pg_policies` 재조회로 느슨한 쓰기 정책이 사라졌는지 확인
6. 전적 조회·무기도감·랭킹 읽기 경로 스모크 테스트 (읽기 정책 유지 확인)
