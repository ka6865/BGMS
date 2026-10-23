# LoL 개발 DB 실제 REST 검증

## 범위와 판정

본 검증은 격리된 임시 PostgreSQL 17.10과 공식 PostgREST 16.5를 사용해 기존 `@supabase/supabase-js` repository/search/detail 경로를 실제 REST로 연결한다. 이는 Supabase CLI가 기동하는 전체 Supabase 로컬 스택, 원격 Supabase 또는 운영 적용 검증이 아니다. Supabase 로컬 스택은 Docker Desktop 기동 후 시도했으나 CLI가 Docker API EOF로 종료되어, 추가 전역 복구 없이 실제 설치된 PostgreSQL과 PostgREST로 범위를 좁혔다.

검증은 네 독립 Vitest 프로세스로 실행한다.

1. 검색 fixture를 받아 계정·랭크·경기·참가자와 검색/상세 DTO cache를 PostgREST로 저장한다.
2. 새 프로세스에서 search/match_details DTO cache를 삭제한 뒤 검색·상세를 재조회해, 계정/랭크/경기목록은 Riot 4회(Account/Match ID 목록 요청 포함)로 갱신하고 저장된 경기 원문(match raw payload)은 7일 TTL 안에서 재사용돼 상세 Riot 호출 0회·만료시각 비연장임을 확인한다. 이는 **완전한 DTO cache hit(외부 호출 0회)**이 아니라 "DTO miss, 원문 재사용"을 증명하는 시나리오다. 완전 DTO hit 0회 검사는 별도의 mock unit 테스트(`tests/lol-riot-search.test.ts`)와 직접 SQL 재시작 검사(`scripts/verify_lol_persistence_local.sh`)에 있으며, 이 REST `cache-hit` 모드가 그것을 재현하지는 않는다.
3. `anon`과 `authenticated`의 직접 테이블/RPC 접근은 PostgreSQL `42501`, `service_role` 조회는 성공하는지 확인한다.
4. flag-off는 DB 요청 없이 기존 fixture 경로를 이용하고, DB mode 오류는 본 검증의 REST 프로세스를 중지한 같은 URL에 요청해 API 503과 외부 호출 0회를 확인한다.

Riot 및 Data Dragon 응답은 테스트 내 fixture다. fixture fetch는 Supabase JS가 붙이는 `/rest/v1/` 접두사만 제거한 뒤, 실제 PostgREST 프로세스에 HTTP 요청을 전달한다. fake REST 서버를 쓰지 않으며 테스트는 Supabase URL과 오류 대상이 loopback host인지 검사한다. 정상 populate에서 Riot/Data Dragon fixture가 호출된 사실과 새 프로세스 cache hit의 외부 호출 0회를 별도로 확인한다.

참가자 저장 계약은 DB `cs=150`, `neutral_minions_killed=10`으로 유지한다. 기존 API DTO에서는 합산한 `cs=160`을 확인한다. Migration 의미를 UI DTO에 맞춰 변경하지 않는다.

## 재현 명령

공식 PostgREST macOS arm64 v16.5 실행 파일을 `tmp/lol-db-integration/runtime/postgrest`에 두고, 시스템 설치 없이 임시 runtime의 동적 라이브러리를 지정하는 예다. 해당 파일이 준비되지 않은 환경에서는 기존 설치 경로의 PostgREST를 `POSTGREST_BIN`으로 지정한다. PostgreSQL 17 경로는 현재 Homebrew 설치 경로를 사용한다.

```sh
POSTGREST_BIN="$PWD/tmp/lol-db-integration/runtime/postgrest" \
POSTGREST_LIBRARY_PATH="$PWD/tmp/lol-db-integration/runtime/libpq:$PWD/tmp/lol-db-integration/runtime/openssl:$PWD/tmp/lol-db-integration/runtime/krb5" \
PG17_BINDIR=/opt/homebrew/opt/postgresql@17/bin \
bash scripts/verify_lol_persistence_integration.sh
```

실행 스크립트는 호출 디렉터리와 무관하게 repository root로 이동한다. PostgreSQL data, 임시 JWT/DB 자격 증명, PostgREST 설정·로그를 `/tmp/lol-it.*` 아래 생성하고 종료 시 자신의 PostgreSQL/PostgREST 프로세스만 종료한 뒤 해당 디렉터리를 제거한다. DB와 REST는 loopback 전용 포트 두 개를 사용하며 스크립트 마지막에 포트 bind가 가능한지 확인한다. 기존 서비스/포트는 대상으로 삼지 않는다.

이 검증은 Supabase JS와 PostgREST의 Data API 호환 경로를 검증한다. Supabase Auth, Kong/API gateway, Realtime, Storage, 전체 Supabase CLI 스택 동작은 검증하지 않았다. 운영·원격 DB에 연결하지 않고 migration을 적용하지 않는다. `.env.local`/환경변수의 실제 값, 키, 쿠키, 회원 데이터를 출력하지 않는다. 로컬 env 확인 결과 `.env.local`의 LoL 관련 변수명은 `LOL_DEV_ENABLED`, `RIOT_API_KEY`였으며 로컬 개발 설정 분류로만 기록한다. `.env.example`에는 `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` 템플릿 이름이 있고 실제 개발 Supabase endpoint 설정은 발견되지 않았다.

## 실행 파일 출처

- 공식 배포: [PostgREST v16.5 macOS aarch64 release](https://github.com/PostgREST/postgrest/releases/tag/v16.5)
- 내려받은 실행 파일 SHA-256: `5658eb9d0b17f0c6733b13f644a7e36024617177b2503aeeb37b40bb129eb174`
- 임시 runtime 라이브러리는 Homebrew bottle을 임시 다운로드해 사용했으며 설치/링크 변경은 하지 않았다.
- PostgreSQL 설치 버전: 17.10. Supabase CLI 설치 버전: 2.105.0.

## 결과와 한계

**SQL 재시작 검사의 v1 키 한계(2026-10-23):** `scripts/verify_lol_persistence_local.sh`의 PostgreSQL 재시작 지속성 검사는 `match:v1:kr:asia:16.21.1:KR_7000` 키를 직접 RPC로 조회한다. 현재 제품 상세 DTO 키는 `lib/lol/riotSearch.server.ts`가 쓰는 `...16.21.1:v2:KR_7000` 형태다(`v2` 세그먼트는 [상세 확장](2026-10-22-lol-detail-enrichment.md)에서 추가됨). 이 SQL 검사는 여전히 cache 저장소의 재시작 지속성 자체는 유효하게 확인하지만, 현재 제품 v2 키와 REST 재조회 경로를 함께 검증한 것은 아니다. v2 키 검사는 `tests/lol-riot-search.test.ts`에 별도로 있다. 이 문서는 스크립트·테스트 파일을 수정하지 않고 이 한계만 기록한다.

실행 결과 및 각 검증 명령은 [통합 검증 보고서](../../tmp/lol-db-integration/report.md)에 기록한다. 이전 [PostgreSQL 기반 검증 보고서](../../tmp/lol-db-foundation/report.md)는 권한·RPC·동시성 계약의 DB 직접 검증이며 실제 REST 경로 검증으로 간주하지 않는다. 이 문서의 결과는 개발 DB 연결 계약을 보완하지만 운영 활성화, 실제 관리자 세션, R2, 공개 접근 또는 실제 Riot 요청을 승인하지 않는다.
