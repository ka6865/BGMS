# LoL 영속 저장 기반 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 LoL 검색·경기 상세 DTO를 유지하면서, 기본 비활성인 서버 전용 DB 저장, 원자적 호출 제한·수집 lease와 PostgreSQL 17 격리 검증을 추가한다.

**Architecture:** 기존 Supabase Auth와 `createServiceRoleSupabase()`를 재사용하고, `lib/lol/*`의 새 repository가 계정·랭크·경기·참가자·짧은 DTO 캐시를 읽고 쓴다. `public.lol_*` 테이블과 `SECURITY INVOKER` RPC가 호출 예산·전역 동시 호출·관측 window·Retry-After·lease 토큰을 원자적으로 관리하며, API는 DB mode에서 오류 시 503으로 닫힌다.

**Tech Stack:** Next.js 16.3.8 Route Handlers, TypeScript, 기존 `@supabase/supabase-js`, PostgreSQL 17, Vitest, Supabase CLI 2.105.0.

**Spec:** `docs/specs/2026-10-21-multigame-lol-architecture-design.md` §5, §6, §7, §12.

## Global Constraints

- 제품 변경은 현재 `8a82` worktree 한정이며 `docs/research/2026-10-22-lol-api-capabilities.md`를 편집하지 않는다.
- 기존 LoL 검색·상세 DTO와 PUBG/Auth/공통 메뉴/UI/전역 CSS/CI 계약을 유지한다.
- flag 기본값은 off이며 env 파일은 수정하지 않는다. DB mode에서 cache miss는 DB 중앙 permit을 얻은 뒤 Riot 수집을 진행하며, DB 연결·조회·RPC 오류는 503으로 종료하고 메모리 경로로 우회하지 않는다.
- 네 테이블 `lol_accounts`, `lol_ranked_entries`, `lol_matches`, `lol_match_participants`와 필요한 최소 cache/rate/lease 상태만 추가한다.
- 자체 가드는 UTC 하루 40 요청, DB 전역 동시 permit 2개, 최소 1.5초 간격, 4초 DB RPC timeout, 8초 Riot timeout으로 고정한다. 이는 Riot의 할당량 주장이 아니다.
- 관측된 app/method `limit:seconds`를 80% 안전 간격에 반영하고 count가 80%에 닿으면 전역 cooldown, malformed/지원하지 않는 형식은 fail-closed 한다. Retry-After는 전역 공유한다.
- 검색 DTO cache 2분, 매치 상세 DTO/정규화 경기·참가자 7일. 7일은 Riot이 보장한 허용 보관 기간이 아니라 BGMS 비활성 MVP의 제안값이며 운영 전 정책과 승인 조건을 확인한다. 만료 데이터는 조회하지 않고 전용 cleanup RPC로 지운다.
- RLS를 활성화하고 anon/authenticated 권한 및 RPC EXECUTE를 회수하며 service_role만 허용한다. RPC는 `SECURITY INVOKER`로 만든다.
- DB 검증은 폐기 가능한 로컬 PostgreSQL 17만 사용한다. 운영 DB/R2/Riot, 설치, 커밋, staging, 배포는 금지한다.

## Review Focus

- 동시 permit 획득과 일일 예산 경계가 초과 호출을 허용하지 않는가 — PostgreSQL 동시성 검증.
- 만료 lease를 재획득한 뒤 이전 token의 완료가 거부되는가 — lease RPC 검증.
- 경기와 참가자 저장이 함께 commit/rollback되고 중복 upsert가 안정적인가 — repository transaction assertion.
- 성공한 빈 랭크는 언랭크로 저장되지만 오류는 이전 랭크를 지키는가 — unit/DB 테스트.
- Riot ID, 플랫폼·지역·Data Dragon 버전이 다른 cache key를 공유하지 않고 429 cooldown을 공유하는가 — unit/DB 테스트.

---

### Task 1: 스키마와 원자적 RPC

**Files:** Create `supabase/migrations/<CLI-generated>_lol_persistence_foundation.sql`, `tests/lol-persistence-schema.test.ts`.

**Interfaces:** RPC `reserve_lol_riot_request(text)`와 `start_lol_riot_request(uuid)`는 DB 시계 기준 전역 예약·동시성·cooldown을 확인한다. `block_lol_riot_requests(text,integer)`는 전역/host cooldown을 단조 증가시키며, `record_lol_riot_rate_headers(text,text,text,text,text)`는 Riot window 헤더를 검증·관측한다. `acquire_lol_collection_lease(text,integer)` 및 두 저장 RPC는 유효 token을 확인하고 DTO cache·정규화 행을 한 트랜잭션에 저장한다.

- [x] Supabase CLI `migration new`로 파일을 생성하고, 4개 핵심 테이블과 짧은 TTL DTO cache 및 고정 소수 행 rate/lease 상태를 추가한다.
- [x] Riot 응답에 쓰는 요약·참가자 nullable 지표·복합 키·플랫폼/지역 제약과 RLS/권한 회수를 migration에 구현한다.
- [x] RPC를 invoker 권한, 고정 search_path, 완전 수식 객체명으로 작성하고 PUBLIC/anon/authenticated 실행을 회수한다.
- [x] 로컬 PostgreSQL 17에서 grants, RLS, atomic reserve/cooldown, lease expiry/token 검증을 실행한다.

### Task 2: LoL repository

**Files:** Create `lib/lol/persistence.server.ts`, `tests/lol-persistence.test.ts`.

**Interfaces:** repository는 DTO cache 조회/저장, 검색 결과 계정·랭크·최근 경기 저장, 경기 상세 원자 upsert, rate permit/cooldown, lease acquire/finish를 제공한다. 기존 helper는 수정하지 않고 `createServiceRoleSupabase()`만 호출한다.

- [x] 영속 cache key에 Riot ID, `platform_id`, `regional_route`, Data Dragon 버전을 포함하고 `fetched_at`/`expires_at`를 기록한다.
- [x] 계정 PUUID PK와 공개 UUID를 유지하며 이름 변경을 upsert하고, 성공한 빈 ranked 결과와 호출 실패를 구별한다.
- [x] 경기와 참가자를 한 DB transaction 경계로 저장하고, `match_id`/`participant_id` 중복 upsert 및 null 지표를 보존한다.
- [x] Supabase REST만으로 원자 transaction이 불가능한 범위는 작은 service_role 전용 `SECURITY INVOKER` 저장 RPC로 묶고 실제 권한으로 확인한다.

### Task 3: 클라이언트/API 연결

**Files:** Modify `lib/lol/riotSearch.server.ts`, `app/api/admin/lol/search/route.ts`, `app/api/admin/lol/matches/[matchId]/route.ts`; create/update `tests/lol-riot-search.test.ts`.

**Interfaces:** `LOL_PERSISTENCE_ENABLED === "true"`일 때만 DB 경로를 사용한다. DB cache hit은 기존 DTO를 반환하고 Riot fetch는 0회다. miss는 DB permit 후에만 Riot을 부르고, 주 경로의 cache/DB/RPC 실패는 API 503으로 fail-closed한다. (2026-10-23 정정: 이 503 계약은 조회·저장 등 주 경로 실패에 한정한다. 요청 종료 시 lease/permit release 같은 정리 호출의 실패는 503으로 전달하지 않고 삼키며, 복구는 lease 만료에 맡긴다 — 메모리 경로로 우회하지는 않는다. `lib/lol/riotSearch.server.ts`의 finally 블록 참고.)

- [x] 검색·상세 시작 시 flag off면 기존 경로, flag on이면 DB cache 경로로 분기한다.
- [x] 모든 외부 Riot 요청 직전 DB permit을 예약하고, 429 `Retry-After`와 app/method limit header를 DB 상태에 공유한다.
- [x] 계정 단위 lease로 동시 검색을 합치며 만료 뒤 이전 owner의 결과 commit을 거부한다. 검색 cache miss는 첫 결과 후 2분, match detail DTO cache는 7일 유지해 앱 프로세스 재시작 후 Riot 재호출 없이 반환한다.
- [x] 조회 시 `platform_id`, `regional_route`, static data version을 cache identity로 보존한다.
- [x] 실패·부분 실패·성공 빈 응답을 구분하고 기존 DTO 및 오류 상태를 유지한다.

### Task 4: 격리 검증·실행 문서

**Files:** Create `scripts/verify_lol_persistence_local.sh`, `tests/fixtures/lol-persistence-verification.sql`, and `tmp/lol-db-foundation/report.md`; update only related LoL execution docs if needed.

- [x] 일회용 PostgreSQL 17 전용 검증 script에 migration 적용, 권한 경계, transaction rollback, duplicate upsert, concurrent permit/lease, cooldown, expired cache 비노출을 고정한다.
- [x] `npm run verify:core`, 기존 LoL 단위 검사와 신규 unit/DB 검증을 실행한다.
- [x] 실제 명령·검사 수·미검증 범위·운영 미적용·flag rollback을 report에 기록한다.
- [x] PostgreSQL 17 + PostgREST 실제 REST 경로에서 검색→저장→재조회, 새 Vitest 프로세스 캐시 hit, 역할 권한, REST 중단 503, flag-off 복귀를 확인한다. 재현·환경·정리 범위는 [개발 DB 검증 계획](2026-10-22-lol-development-db-verification.md)에 기록한다.
- [x] 실제 저장행에서 migration 계약을 확인한다: `cs=totalMinionsKilled`, `neutral_minions_killed=neutralMinionsKilled`; UI DTO CS는 두 값을 합산한다.

## 검증 등록(2026-10-23, 해결됨)

LoL migration(`supabase/migrations/20261022114157_lol_persistence_foundation.sql`)을 `scripts/verify_migrations_local.sh`의 `MIGRATIONS` 배열과 `tests/fixtures/migration-check/lol-persistence-scenarios.sql`에 등록했다. 공통 시나리오는 기존 `tests/fixtures/lol-persistence-verification.sql`을 재사용하고 7개 테이블 권한/RLS와 service_role 호출 예산·동시 permit·간격 계약을 확인한다. `package.json`의 `verify:lol`은 LoL 검색·저장소·schema·개발 화면 단위 테스트를 실행한다. 브라우저(`tests/lol-dev-browser.test.ts`)와 REST 통합(`tests/lol-persistence-integration.test.ts`)은 계속 opt-in이며 이 alias와 공통 migration 검증 범위에 포함되지 않는다.
