# LoL 운영 영속 저장 적용 준비

> **2026-10-22 19:52 UTC 변경:** 사용자 결정으로 하루 40회 자체 예산을 제거했다(`supabase/migrations/20261022200000_lol_remove_daily_budget.sql`, 운영 적용 완료). `reserve_lol_riot_request`는 더 이상 `daily_budget`을 반환하지 않으며 `used_count`는 관측용으로만 센다. Riot 응답 헤더 기반 감속, 429 쿨다운, 요청 lease 2개, 최소 1.5초 간격은 유지한다. 아래 40회 관련 서술은 적용 당시 기록이다.

## 대상과 현재 상태

- 원본 `main` worktree의 `.env.local`에서 값은 출력하지 않고 Supabase URL host만 확인했다. host의 project ref `kolwueoejdasoqyopkao`는 CLI의 `BGMS` 프로젝트와 일치한다. Git remote도 BGMS 저장소다.
- 대상은 Supabase `BGMS`, `ap-northeast-2`, PostgreSQL `17.6`이다. worktree CLI link는 이 ref로 설정했다. 승인된 LoL 전용 migration은 적용했고, 운영 persistence flag도 활성화했다.
- Supabase MCP `list_projects`는 `UNAUTHORIZED: This app connection requires reauthentication`로 실패했지만, 이후 project/organization 상세 조회는 가능했다. Supabase CLI `2.105.0` 프로젝트 목록과 `db query --linked`도 작동한다. `supabase migration up --help`에는 단일 version 선택이 없어 이를 운영 적용에 사용하지 않는다. 운영 DDL은 connector `apply_migration`으로 이 migration 하나만 적용한다. `db push`, `db reset`은 사용하지 않는다.
- 원본 `.env.local`에서 Supabase URL, public anon key, service-role key를 worktree `.env.local`로 전달하고 `LOL_PERSISTENCE_ENABLED=true`로 설정했다. public anon key는 기존 middleware/client 생성에 필요했고, service-role key는 서버 전용으로 유지했다. 값은 출력하지 않았다. 기존 Next `16.3.8` 서버를 동일 명령과 `127.0.0.1:59405` 포트로 재시작해 Ready를 확인했다.

## 읽기 전용 운영 기준선

2026-10-22, Supabase CLI의 짧은 catalog/statistics query로 확인:

- PostgreSQL `17.6`; 현재 데이터베이스 크기 `2,246,904,979` bytes(약 2.09 GiB).
- `max_connections=60`, 현재 backend 20, 그중 다른 active backend 1, 대기 lock 0.
- 적용 전 public 및 다른 사용자 schema에서 `lol_*` 테이블과 함수가 없었고, 대상 migration은 미적용이었다. connector가 migration history 버전을 적용 시각 `20261022114157`로 기록해 로컬 migration 파일도 이 버전으로 맞췄다. SQL SHA-256은 승인본과 동일하다.
- 기존 non-LoL public table grants hash: `cc8b291e64ffc7222c8e8e930cf5aea6`; 기존 non-LoL public function grants hash: `81c0745b720f293817db99fb7c3853cd`. hash 계산 SQL은 보존되지 않아 동일 식 사후 비교는 완료하지 못했다.
- 최근 migration history는 `20261021010000`까지이며 target migration은 없다.
- Supabase organization 조회로 실제 구독 `Pro`를 확인했다. 공식 요금표의 Pro 포함 DB disk는 project당 8 GB이며 초과분은 월 GB당 과금된다. 측정값은 `pg_database_size` 기준 2.09 GiB로 8 GB보다 작지만, 이는 disk/WAL 포함 사용량이나 당월 인보이스의 직접 측정값은 아니다. [공식 요금표](https://supabase.com/pricing), [database size와 disk size 설명](https://supabase.com/docs/guides/platform/database-size).
- 코드 용량 관제 기본값은 `lib/admin-agent/storage-limits.ts`의 8 GiB이며 worktree `.env.local` override는 없다. 이는 앱 관제값이다. 운영 프로세스 환경의 `SUPABASE_DATABASE_LIMIT_BYTES` override와 정확한 현재 disk usage/당월 과금은 확인하지 않았다.

## 적용 대상 변경

- 파일: `supabase/migrations/20261022114157_lol_persistence_foundation.sql`
- SHA-256: `d43e4137287025a76ae9cb47629c8aef7e26837897220b0c208a7001f2c4d36c`
- 7개 신규 `public.lol_*` 테이블, 12개 LoL 전용 RPC, 인덱스와 LoL 전용 rate-limit 초기행을 한 transaction으로 만든다. `lock_timeout`은 2초다.
- 최근 경기 원문 `request_json`은 경기 row마다 1 MiB 이하, 최대 7일 보관한다. 검색 DTO는 기존처럼 2분, immutable 경기/참가자/원문 및 상세 DTO는 최대 7일이다. 검색 DTO가 만료되면 계정·랭크·경기목록은 갱신하면서 같은 match ID의 저장 원문을 재사용해 반복 상세 호출을 줄인다.
- 7일은 조회 가능한 논리 TTL이다. 만료 행은 조회에서 제외되며 `cleanup_lol_expired_data()`는 LoL 전용 삭제 RPC지만 자동 호출 일정은 만들지 않는다. 따라서 물리 삭제가 7일 내 완료된다고 보장하지 않는다.
- DB에서 원문을 재사용할 때 경기 `fetched_at`/`expires_at`는 그대로 유지한다. 만료 후 Riot에서 다시 받은 원문만 갱신하며, 상세 DTO 만료는 저장 경기 원문의 만료시각을 넘지 않는다.
- 기존 DB 데이터/테이블/RPC/Auth/PUBG를 수정·삭제하지 않는다. 신규 원문은 Riot 경기 응답의 참가자 정보를 포함하며, RLS와 service-role 전용 table/RPC 권한으로 서버 밖 접근을 막는다.
- migration의 테이블 생성은 같은 이름이 이미 있으면 실패하며 transaction 전체가 rollback된다. 적용 직전 LoL object와 migration history를 다시 읽는다.

## 요청량과 영향

- 사용자 검색 한 번은 계정, 현재 프로필, ranked, 최근 경기목록을 최대 4번 조회하고, 목록에서 저장되지 않은 신규 경기 상세를 최대 5번 더 조회한다. 첫 검색의 최악은 Riot 최대 9회다.
- 2분 뒤 재검색은 계정/랭크/목록 4회를 갱신하며 저장된 동일 경기 원문은 0회 상세 재호출한다. 새로운 경기 ID가 5개면 해당 신규 경기만 추가 호출한다. 같은 검색 결과 DTO는 2분 동안 0회다.
- 중앙 guard는 전체 LoL 사용자 합산 UTC 40회/일, 동시 Riot request 2개, 최소 1.5초 간격이며 관측된 Riot limit header와 Retry-After가 더 엄격하면 이를 따른다. 사용자별 연속검색 횟수 제한은 없다. 최악의 신규 경기 검색 4회가 36회를 쓰고, 다섯 번째는 남은 4회만 허용한 뒤 예산 제한에 걸릴 수 있다. 동일 검색 2분 캐시와 경기 원문 재사용은 추가 호출을 낮춘다.
- 2.09 GiB DB에서 기존 데이터가 아닌 신규 LoL 검색만 저장한다. 폭주 부하 실험은 운영에서 하지 않는다.

## 격리 검증 결과

- `npx vitest run tests/lol-persistence.test.ts tests/lol-persistence-schema.test.ts tests/lol-riot-search.test.ts tests/lol-persistence-integration.test.ts`: 52 passed, 4 skipped.
- `npx vitest run tests/lol-*.test.ts`: 94 passed, 10 skipped.
- `bash scripts/verify_lol_persistence_local.sh`: PostgreSQL 17.10 권한·RLS/RPC·원자 저장/rollback·1.5초 간격·lease·동시 permit 검증 통과.
- `POSTGREST_BIN=... POSTGREST_LIBRARY_PATH=... PG17_BINDIR=... bash scripts/verify_lol_persistence_integration.sh`: PostgreSQL 17.10 + PostgREST 16.5에서 populate, cache-hit, flag-off, DB-error 4개 REST 시나리오 통과. DTO cache 만료 후 재검색에서 최신 계정·랭크·경기 ID는 갱신하고 저장된 경기 payload는 Riot 상세 재호출 없이 사용했다.
- `npm run verify:admin`: 20 files / 423 tests passed. `npm run verify:core`: 통과, ESLint 47 warnings / 0 errors.
- `BGMS_USE_LOCAL_POSTGRES=true BGMS_PG_BIN=/opt/homebrew/opt/postgresql@17/bin npm run verify:migrations`: 일회용 PostgreSQL 17 migration/RPC 전체 시나리오 통과. 저장소의 LoL migration은 별도 PG17/PostgREST 통합 스크립트에서 검증했다.
- 이 절의 결과는 격리 fixture 검증이다. 운영 DDL, 실제 Riot 요청, HTTP smoke는 아래 운영 적용 및 검증 결과에 별도로 기록했으며, 관리자 로그인 브라우저 세션은 사용하지 않았다.

## 운영 적용 및 검증 결과

격리 PostgreSQL 17 및 PostgREST 16.5에서 schema/RPC/권한 및 네 가지 실제 REST 시나리오를 검증했다. 추가 시나리오는 검색 DTO 만료 후 최신 계정·랭크·경기 ID를 다시 가져오고 저장 경기 원문은 재사용해 경기 상세 Riot 호출을 0회로 유지하는지 확인한다. 운영 적용 후 LoL 권한/저장/재조회는 아래 비식별 집계로 확인했다. 사용자 응답과 회원 행은 출력하지 않았다.

- Coordinator는 대상과 SHA-256을 확인하고 단일 connector `apply_migration` 적용을 승인했다. 직전 운영 카탈로그 재확인 후 이 migration 하나만 적용했다. 기존 테이블/RPC/Auth/PUBG 데이터 변경이나 R2/배포 변경은 없었다.
- 적용 후 7개 테이블 모두 RLS enabled, `service_role`은 테이블별 SELECT/INSERT/UPDATE/DELETE 28권한과 12개 RPC EXECUTE를 보유한다. `anon`/`authenticated`에는 테이블 권한이 없고 RPC는 `PUBLIC` 포함 실행 권한이 없다. 적용 직후 LoL 사용자 데이터는 rate-limit 초기 3행뿐이었다.
- 사용자 지정 Riot 검색은 2026-10-22 11:47 UTC에 server-side backend 경로로 실행했다. 첫 검색 `ready`, 경기 5개, Riot API 9회 모두 HTTP 200(계정/소환사/랭크/목록 각 1회, 경기 상세 5회); 같은 검색 재조회는 DB search cache hit로 추가 Riot 호출 0회였다. 합계 9회, 16.25초, 403 없음. 결과 본문과 계정 식별자는 출력하거나 문서화하지 않았다.
- 비식별 DB 집계의 단일 SQL 호출 round-trip은 1.60초였다. `lol_accounts` 1, `lol_ranked_entries` 2, `lol_matches` 5, `lol_match_participants` 50, search cache 1, match-details cache 0, rate-limit state 3행이다. `request_json` 합계 428,133 bytes, API cache payload 1,850 bytes다. 7 relation의 `pg_total_relation_size` 합계는 761,856 bytes다. DB query/RPC별 호출 수는 애플리케이션 계측이 없어 별도 집계하지 못했다. 새 relation의 planner `reltuples`는 모두 `-1`로 초기 통계가 없었다.
- 기존 grant baseline hash는 기준선 기록에 정규화/query 식이 함께 보존되지 않아 동일 알고리즘의 사후 hash 비교를 재현하지 못했다. 적용된 SQL은 새 `lol_*` 테이블과 LoL 전용 RPC만 대상으로 하며, 사후 LoL 권한 카탈로그는 위와 같이 확인했다. 적용 전·후의 기존 개별 object privilege 목록 비교는 미확인으로 남긴다.
- 운영 기능 rollback은 이 worktree `.env.local`의 `LOL_PERSISTENCE_ENABLED=false` 후 같은 Next 프로세스 정상 재시작이다. 이 조치는 신규 DB 쓰기를 멈추며 운영에 저장된 LoL 데이터나 schema를 삭제하지 않는다. 자동 cleanup schedule은 추가하지 않았다.
- 비인증 UI smoke에서 `/admin/lol`은 로그인으로 redirect(HTTP 307), `/api/admin/lol/status`는 HTTP 401을 반환했다. 인증정보나 사용자 cookie를 사용하지 않았다.
- 같은 worktree 서버의 일반 PUBG map route `GET /maps/erangel`은 HTTP 200이었다. 이는 가벼운 HTTP 응답 확인이며 PUBG 전체 기능 검증을 뜻하지 않는다.

## 남은 확인

- 현재 Pro 구독 및 포함 8 GB DB disk는 확인했지만 WAL을 포함한 실제 disk usage와 당월 invoice 금액은 미확인이다.
- 보존된 pre-apply grant hash와 사후 hash는 동일 query 식으로 비교하지 못했다. 기존 object ACL의 개별 사전/사후 snapshot도 미확인이다.
- 실제 관리자 브라우저 세션, 사용자 쿠키, Riot response 본문, PUBG 테이블 데이터 영향은 조회하지 않았다. 검색은 서버 전용 backend를 직접 호출했다.
