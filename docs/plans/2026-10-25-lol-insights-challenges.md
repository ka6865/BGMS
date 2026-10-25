# LoL 라인전·기여와 도전과제 구현 계획

목적은 경기 후 사실 지표와 Riot 공식 도전과제 분포를 공개·관리자 프로필에서 제공하는 것이다.
기존 검색·requestJson·영구 요약·개인정보 제거 경계를 재사용한다. 벤치마크·종합 점수·리더보드·이미지는 추가하지 않는다.

- [x] `lib/lol/insights.ts`에서 challenges를 화면용 사실 지표로 선택하고 최근 최대 100경기 경향을 계산한다. 지표별 표본 3경기 미만은 숨긴다.
- [x] `lib/lol/challengeProfile.ts`에서 한국어 config·임계값과 티어 분포를 선택하고 희귀한 도전과제 최대 3개를 계산한다.
- [x] 새 RLS 테이블·service_role 전용 security invoker RPC로 일일 설정·분포 캐시를 보관한다. 기존 lease로 동시 갱신을 막는다.
- [x] `riotSearch.server.ts`, `types.ts`, `persistence.server.ts`에 연결하고 검색 키 v11로 변경한다. 추가 조회 실패는 전적 검색과 분리한다.
- [x] `LolMatchDetail`, `LolSearchPanel`에 공용 분석 섹션·최근 경향·도전과제 카드를 연결한다.
- [x] 숫자·누락·포지션·표본·분포·오류 격리·권한·TTL 단위 검증과 공개/관리자 375·390·430·데스크톱 fixture를 실행한다.
- [x] core·lol·security·격리 migration 결과와 SHA256을 기록한다.

## 공식 계약 확인과 제한

[공식 Challenges-V1 문서](https://developer.riotgames.com/apis#lol-challenges-v1)와 동적 `/api-details/lol-challenges-v1` 본문을 확인했다.
config는 `id`, `localizedNames`, `state`, `tracking`, `thresholds`를, player-data는 `preferences.title` 문자열과 총점·카테고리·도전과제를 정의한다.
전체 percentiles 문서는 ChallengeId → Season → Level → 비율 구조다. 단일 시즌과 직접 Level 맵을 지원하며 복수 시즌은 추정하지 않는다.
`ChallengePointDto`에는 `precentile` 오자가 있어 `percentile`과 둘 다 검증한다. 비율은 0~1만 허용하고 백분율로 표시한다.
2026-10-25 config 실호출 1회는 403이었다. 메인은 추가 실호출 금지 및 칭호의 추정 매핑 금지를 지시했다.
공식 문서에 칭호 ID와 한국어명 관계가 없으므로 공개 화면은 칭호를 숨기고 관리자만 매핑 미확인을 안내한다.
새 키 확보 후 실제 config/분포/칭호 응답을 재검증해야 한다. 운영 적용·커밋·push·배포·개발 서버 재시작은 하지 않는다.
로컬 `.agents/rules/project_rules.md`는 없어 제공된 AGENTS.md·추적 문서·실제 코드를 기준으로 작업한다.

## 화면·데이터 계약

본인 경기 요약에 선택된 `insights.laning`·`insights.contribution` 문구만 추가한다. 참가자 10명의 설명을 중복하지 않아 기존 검색 캐시 256KiB 상한을 유지한다.
원문 challenges와 PUUID는 기존 공개 DTO 변환에서 제거된다. 참가자 상세 캐시는 변하지 않아 v4를 유지한다.
골드·경험치 우위 0은 우위 미달성이며 열세를 뜻하지 않는다. 시야 격차는 같은 포지션 상대가 정확히 1명일 때 실제 시야 점수의 차이다.
상대 원문 challenges에 10분 라인 CS가 남아 있으면 본인 10분 CS 설명에 상대 수치도 함께 표시한다. 상대 원문이 없으면 본인 수치만 표시한다.
라인전 지표는 협곡 일반·랭크(400·420·430·440·490)의 TOP·MIDDLE·BOTTOM에만 표시한다. UTILITY는 시야 비교, JUNGLE은 10분 정글 CS만 표시한다.
10분 미만 경기는 10분 CS를 숨기고, 다시하기·5분 미만 경기는 분석에서 제외한다. 칼바람 등에서 협곡 오브젝트는 숨긴다.
최근 경향은 저장된 최근 최대 100경기 중 유효 경기이며 각 지표별 3경기 이상, 표시 가능한 지표가 3개 이상일 때만 카드를 제공한다.
라인전 우위 비율·팀 피해 비중·킬 관여율·시야 점수의 표본을 각각 표시하며 큐 필터와 독립이다.

추가 Riot 호출은 분석 0회, 검색 miss/갱신 시 player-data 1회, 공유 일일 캐시 miss 시 config·percentiles 각각 1회다.
검색 캐시 적중·경기 더보기·수집에는 새 도전과제 호출이 없다. 기존 requestJson의 중앙 가드·8초 타임아웃·메트릭을 재사용한다.
player-data는 1MiB, 설정·분포 각각 8MiB를 본문 스트림 읽기 중에도 제한한다. 한국어 설정·임계값·티어 분포로 축소한 캐시는 1MiB 이하다.
`lol_challenge_catalog_cache`는 고정 키 한 행을 24시간 보관한다. 기존 60초 collection lease로 중복 갱신을 막고 쓰기 RPC가 같은 lease·토큰·만료를 검증한다.
플레이어 원문·칭호 ID·선택 휘장 ID는 이 캐시에 저장하거나 공개하지 않는다. RLS를 켜고 public·anon·authenticated 권한을 회수한다.
읽기·쓰기 RPC는 security invoker와 빈 search_path를 사용하며 service_role만 실행할 수 있다. 기존 migration은 변경하지 않는다.
분포·설정·DB 조회 실패는 총점과 카테고리를 보존한다. player-data 실패도 기존 전적을 유지한다. 로컬 실패 재시도 간격은 120초다.

## 신규 migration

`supabase/migrations/20261025010000_lol_challenge_catalog.sql`

SHA256: `f72d5f06cd0fc26cc58575a8312cb3e0232381d26efcdf95e9685a7c7c360205`

운영 데이터 삭제는 없고, 만료된 캐시는 다음 검색에서 교체된다. 운영에는 새 migration을 적용한 뒤 코드를 배포해야 한다.

## 검증과 남은 확인

- `npm run verify:core`: exit 0, ESLint 오류 0개·기존 경고 47개, TypeScript 통과.
- `npm run verify:lol -- --maxWorkers=1`: exit 0, 28개 파일·468개 통과, 4개 조건부 파일·68개 테스트 제외. 브라우저 검증은 아래 별도 실행이다.
- `npm run verify:security`: exit 0, 6개 파일·91개 통과.
- `BGMS_USE_LOCAL_POSTGRES=true BGMS_MIG_CHECK_PORT=55435 npm run verify:migrations`: exit 0. 격리 PostgreSQL에서 명시된 migration 99개 적용 및 전체 RPC 시나리오 통과.
  새 도전과제 캐시는 읽기·TTL·lease·본문 상한·만료·RLS·권한·invoker/search_path 8개 시나리오를 추가했다.
- `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-public-browser.test.ts --maxWorkers=1`: 공개 18개 통과.
- `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-dev-browser.test.ts --maxWorkers=1`: 관리자 41개 통과.
- 공개 뷰포트 375×667·390×844·430×932·1440×900, 관리자에 1024×900도 추가했다. 정상·실패·분포 누락·최소 표본 미달 숨김과 기존 전적 보존을 확인했다.
- 개별 카드 캡처 `tmp/lol-public-review/challenges-{width}x{height}.png`, `tmp/lol-detail-alignment/challenges-{width}x{height}.png`.
  공개 375px·관리자 1440px 이미지를 열어 칭호 숨김/관리자 안내·문구 줄바꿈·분포·카테고리 배치를 확인했다.
- 병렬 재검증에서 기존 CLI·페이지 import와 Chromium 시작/검색 단계의 timeout이 발생했다. 테스트 시간 제한 변경은 되돌렸고 단독 순차 실행으로 재검증했다.
- `git diff --check` 및 변경 20개 파일의 300자 줄 제한 검사를 통과했다. 하위 워커 금지에 따라 자체 코드 검토만 수행했고 독립 검토·통합은 메인이 수행한다.
- 실제 Riot 호출은 config 형태 확인 1회(403)뿐이다. 실제 계정·실기기·iOS Safari/Android WebView·운영 DB·배포 검증은 하지 않았다.
- 공식 칭호 ID→한국어명 매핑과 복수 시즌 분포의 시즌 연결은 새 키와 공식 계약 확인이 필요하다. 현재 공개 화면은 이를 추정하지 않는다.
- 하위 워커·의존성·운영 설정 변경·개발 서버 재시작·커밋·push·배포는 수행하지 않았다.

## 변경 파일

- `components/lol/LolInsightCards.tsx`
- `components/lol/LolMatchDetail.tsx`
- `components/lol/LolSearchPanel.tsx`
- `lib/lol/challengeProfile.ts`
- `lib/lol/insights.ts`
- `lib/lol/persistence.server.ts`
- `lib/lol/riotSearch.server.ts`
- `lib/lol/types.ts`
- `supabase/migrations/20261025010000_lol_challenge_catalog.sql`
- `scripts/verify_migrations_local.sh`
- `tests/fixtures/lol/browserScenario.ts`
- `tests/fixtures/lol/challengeProfile.ts`
- `tests/fixtures/migration-check/lol-challenge-catalog-scenarios.sql`
- `tests/lol-insights-challenges.test.ts`
- `tests/lol-collect.test.ts`
- `tests/lol-dev-browser.test.ts`
- `tests/lol-persistence.test.ts`
- `tests/lol-public-browser.test.ts`
- `tests/lol-riot-search.test.ts`
- `docs/plans/2026-10-25-lol-insights-challenges.md`
