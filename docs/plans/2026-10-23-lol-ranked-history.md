# LoL 랭크 이력과 시즌 게임 수

> 아래 조회·캐시·그래프 설명과 검증 기록은 초기 구현 시점 기준이다.
> 현재 KST 일별 30일 이력·`search:v8`·그래프 계약은
> [챕터 4 운영 문서](2026-10-23-lol-chapter4-ops.md)의 후속 변경을 따른다.

## 저장 계약

- DB 모드에서 검색 캐시가 만료되어 Riot 랭크를 실제 조회한 때부터 BGMS 이력을 쌓는다. 이력 때문에 추가 Riot 요청을 보내지 않는다.
- `public.lol_ranked_history`는 계정의 PUUID와 랭크 큐를 기준으로 tier·rank·LP·wins·losses 중 하나라도 직전 기록과 다를 때만 새 행을 저장한다. 랭크 엔트리가 없는 언랭크 큐는 저장하지 않는다.
- 계정 upsert의 행 잠금으로 같은 계정의 동시 저장을 직렬화한다. 이력·현재 랭크·검색 캐시는 기존 `persist_lol_search_snapshot` RPC의 동일 트랜잭션에서 저장한다. RPC 시그니처와 boolean 반환은 유지한다.
- 기존 검색 데이터나 Riot 응답만으로 과거 시즌 티어를 소급 복원할 수 없다. migration은 과거 현재 랭크를 이력으로 채우지 않는다.
- FK `lol_accounts(puuid) ON DELETE CASCADE`를 사용한다. 90일 미접근 계정을 정리하는 기존 `cleanup_lol_expired_data`가 계정을 지우면 해당 계정의 이력도 모두 삭제한다. 이력만의 별도 TTL은 없다.
- RLS를 활성화하며 테이블 DML·시퀀스·RPC는 service_role만 사용한다. 조회 RPC는 security invoker와 빈 search_path를 유지한다. 클라이언트 DTO에 PUUID나 내부 행 ID를 넣지 않는다.

## 조회와 캐시

- `get_lol_ranked_history(p_puuid text, p_limit integer)`는 솔로/자유 랭크 키를 가진 JSON을 반환한다. 각 큐는 `points`, `highest`, `trackingSince`를 가진다.
- `points`는 큐별 최근 최대 30개를 시각 오름차순으로 반환한다. 각 점은 `{ recordedAt, tier, rank, lp }`이다. 동일 시각은 행 ID로 순서를 결정한다.
- `highest`는 최근 30개와 별개로 계정의 전체 보관 이력에서 계산한다. IRON → BRONZE → SILVER → GOLD → PLATINUM → EMERALD → DIAMOND → MASTER → GRANDMASTER → CHALLENGER 순이며 같은 티어는 IV → III → II → I, 다음은 LP 순이다.
- 최고 상태가 같으면 처음 도달한 시각을 사용한다. `trackingSince`는 큐별 첫 기록 시각이다. 기록이 없으면 빈 points와 null 최고/시작 시각을 반환한다.
- DB 저장 시 캐시에 갱신한 이력을 포함하고 서버 응답도 저장 후 조회한 이력을 사용한다. 메모리 모드는 양쪽 큐에 빈 이력을 반환한다.
- 검색 캐시는 `search:v6`로 올려 이력이 없는 이전 DTO와 구분한다. 경기 상세 캐시 버전은 유지한다.

## 표시 문구

- `이번 시즌 N게임 · 솔로 랭크 한정` 또는 `이번 시즌 N게임 · 자유 랭크 한정`: 해당 Riot 랭크 엔트리의 wins + losses이며 최근 경기 표본 수와 구분한다.
- `최고 티어(BGMS 기록)`: BGMS 수집 이후 보관된 관측 기록의 최고 상태이다. 없으면 `기록 없음`을 표시한다.
- `기록 시작 YYYY-MM-DD`: 해당 큐의 최초 기록 날짜를 UTC 기준으로 표시한다.
- LP 추이는 기록이 2개 이상일 때만 SVG로 표시한다. 점은 검색 시점의 관측값이며 게임마다 기록하는 것이 아니다. 승급 시 LP가 초기화될 수 있다는 설명을 SVG title에 제공한다.
- `LolTierEmblem`은 `/lol/ranked-emblems/{tier 소문자}.webp`를 시도한다. 실패 시 기존 `TIER RANK` 텍스트 배지로 대체한다. 언랭크는 `Unranked` 배지를 표시한다. 이미지 파일은 별도 자산 작업에서 추가한다.

## 로컬 검증

- `BGMS_USE_LOCAL_POSTGRES=true npm run verify:migrations`
- `bash scripts/verify_lol_persistence_local.sh`
- `npm run verify:core`
- `npm run verify:lol`
- `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-dev-browser.test.ts`

DB 시나리오는 무변화 중복 방지, 각 필드 변경, 언랭크, 재등장, 실패 시 롤백, 캐시 원자성, 최고 티어/단계/LP 순위, 30개 제한, 큐 격리, 접근 권한과 계정 cascade를 검사한다.

브라우저는 격리 fixture로 엠블럼 실패 대체, 기록별 차트 조건과 모바일 3종·데스크톱 넘침을 검사하며 기존 localhost:3000 서버를 재시작하지 않는다.

운영 DB 적용과 공식 이미지 자산 배치는 메인 담당이다. 이 작업에서는 Supabase 원격·실제 Riot API·실기기 모바일을 검증하지 않는다.

## 검증 결과 (2026-10-23)

- 로컬 PostgreSQL 17 공통 migration 검증 통과: `20261023010000_lol_ranked_history` 적용과 `LoL ranked history scenarios passed` 출력 확인.
- LoL 전용 격리 DB 검증 통과: 새 이력 시나리오와 기존 저장·권한·락 대기 만료·8개 동시 permit·재기동 캐시 시나리오 유지.
- `verify:core`: ESLint와 TypeScript 오류 0개. `verify:lol`: 6개 파일, 123개 테스트 통과.
- `RUN_LOL_DEV_BROWSER=true`: 11개 시나리오 통과. 375×667, 390×844, 430×932, 1024×900, 1440×900에서 넘침 없음. 누락 엠블럼 텍스트 대체, 0/1개 기록 차트 숨김과 2개 기록 차트 표시 확인.
- 변경 파일 대상 `awk 'length>300'` 출력 없음, 제품 LoL 코드의 금지 식별자 없음, `git diff --check` 통과.
- migration SQL SHA-256: `8c899c349c417b8ce961971ac0da0460e080279958d0cf2ec4b04b2fa03a7452`.
- `.agents/rules/project_rules.md`는 현재 작업 폴더에 없어 저장소 코드·문서·실제 로컬 검증을 기준으로 진행했다. 기존 변경과 미추적 파일은 보존했다.

미실행: 운영 DB 적용, Supabase 원격, 실제 Riot API, 공식 엠블럼 자산, 모바일 실기기, 별도 PostgREST 통합 실행. 운영 적용 전까지 DB 모드의 신규 RPC는 사용할 수 없으며 검색 이력은 소급되지 않는다.

## 운영 적용 (2026-10-22 20:40 UTC)

- `20261023010000_lol_ranked_history.sql`(SHA-256 `8c899c349c417b8ce961971ac0da0460e080279958d0cf2ec4b04b2fa03a7452`)을 임시 workdir(원격 이력 173개 자리표시 + 대상 1개)로 `--dry-run` 확인 후 단독 적용했다.
- 적용 후 확인: RLS 활성, anon·authenticated SELECT/INSERT 불가, service_role 가능, `get_lol_ranked_history` EXECUTE는 service_role만, `persist_lol_search_snapshot`에 이력 기록 포함.
- 실제 검색 1회 후 솔로·자유 각 1행 기록, 화면에 이번 시즌 게임 수·최고 티어(BGMS 기록)·기록 시작일 표시 확인.
- 기록 시작일은 UTC 저장값을 한국 날짜로 표시한다(`formatKstDate`).

## 티어 엠블럼 자산 (2026-10-23)

- 출처: Riot 개발자 문서 "Icons and Emblems"의 공식 `ranked-emblems-latest.zip`(64,478,096 bytes, last-modified 2023-10-24).
- `Rank=<Tier>.png` 10개(1000px)만 여백 제거 후 192px webp로 변환해 `public/lol/ranked-emblems/<tier>.webp`(각 8~15KB)에 두었다. 원본 zip·날개 이미지는 저장소에 넣지 않았다.
- `LolTierEmblem`은 이미지 옆에 티어명을 함께 표시하고, 로드 실패 시 텍스트 배지로 대체한다.
