# 증바람 챔피언별 선택 통계 운영 준비

## 범위와 현재 상태

기존 증바람 도감·전역 선택률·편집 조합을 유지하고, 숫자 ID 기반 챔피언 통계를 별도 후보로 수집한다. 자동 공개는 없다. 외부 API 키 생성·계정 등록·운영 migration 적용·운영 적재·배포는 이번 준비 범위에 포함하지 않는다. 운영 DB 적용과 실제 API 인증은 후속 작업에서 검증했다. 수집은 공급원 문서에 명시된 동기화·캐시 범위를 사용하며 공개 재사용 범위는 별도로 확인한다.

공급원의 실명·경로·원본 스키마·문의 초안은 Git 제외 `docs-private/lol-research/2026-11-04-mayhem-champion-dataset-research.md`에 있다. 공개 소스 키는 `champion_api_v1`, 모집단은 `source_default`다. 이 값으로 한국 서버 또는 전체 티어 표본을 의미하지 않는다.

## 설정

| 이름 | 위치 | 의미 |
| --- | --- | --- |
| `LOL_MAYHEM_STATS_API_KEY` | GitHub Secret / 서버 환경 | 제3자 데이터 API key. Riot API key와 별개 |
| `LOL_MAYHEM_STATS_REUSE_CONFIRMED` | GitHub variable / 서버 환경 | 공개 재사용 범위를 실제 확인한 후에만 true |
| `LOL_MAYHEM_STATS_REUSE_BASIS` | GitHub variable / 서버 환경 | 동기화·캐시/공개 범위를 구분한 확인 근거, 최소10자 |
| `LOL_MAYHEM_STATS_ATTRIBUTION` | GitHub variable / 서버 환경 | 공개 화면에 표시할 출처 문구 |
| `LOL_MAYHEM_CHAMPION_DATASET_ENABLED` | GitHub variable / 서버 환경 | 기본 false, 수집 및 공개 읽기 활성화 |
| `LOL_PERSISTENCE_ENABLED` | 서버 환경 / workflow | 영속화 활성화. 기존 설정 재사용 |

위 설정은 배포 서버와 Actions에 각각 필요하다. 설정값을 문서/로그/클라이언트에 복사하지 않는다. 재사용 확인 설정은 사용 권한을 만들어 주는 버튼이 아니며 실제 근거를 기록하는 값이다. API 응답을 받았다는 이유로 true로 설정하지 않는다. 문서에 안내된 동기화·캐시 근거와 출처가 있으면 false 상태에서도 비공개 후보를 수집·검토할 수 있다. 승인·공개·공개 API 제공은 true가 필요하다.

## 점검과 수집

환경 값은 실행 프로세스에 주입한다. CLI는 `.env.local`을 자동으로 읽지 않는다. 로컬 예시는 Node22의 `--env-file-if-exists=.env.local`을 명시한다.

```bash
# 무료 config와 설정 boolean만 확인. key 미설정으로도 가능, DB/Storage/유료 API 접근 없음.
npx tsx --env-file-if-exists=.env.local scripts/lol_mayhem_champion_dataset_sync.ts --check

# 공식 DB 카탈로그 읽기 + 제3자 유료 데이터 다운로드·검사. DB/Storage 쓰기 없음.
npx tsx --env-file-if-exists=.env.local scripts/lol_mayhem_champion_dataset_sync.ts --dry-run

# private 원본/진행 파일 저장 + 검수 후보 생성. 공개본 변경 없음.
npx tsx --env-file-if-exists=.env.local scripts/lol_mayhem_champion_dataset_sync.ts --apply
```

mode 충돌은 거부한다. 기본은 dry-run이다. 무료 점검도 source config 네트워크 요청은 발생한다. dry-run은 데이터 credit을 사용하므로 반복 검증은 합성 fixture 단위 테스트로 한다. 인증키가 없으면 유료 요청 전 `stats_api_key_missing`으로 종료한다.

워크플로 `.github/workflows/lol-mayhem-champion-dataset.yml`의 수동 기본값은 check다. 예약 실행은 6시간 간격이며 enable variable이 true일 때만 후보 수집을 실행한다. 바뀌지 않은 source version·카탈로그 해시는 목록/챔피언 유료 요청을 보내지 않는다. API key·수집 근거와 검증이 준비되기 전에는 enable을 false로 유지한다. 공개 재사용 확인 전에도 비공개 수집·관리자 검토는 가능하며 공개 데이터는 반환하지 않는다.

현재 API 문서 기준 무료200credits/UTC일,60req/min이다. 원시 파일은1credit이며 기존 공식 증강 카탈로그를 재사용해 별도 증강 목록 호출은 하지 않는다. 173명 예시에서 챔피언 목록1+원시173=174credits다. 최소25credits를 남긴다. 인원·날짜를 상수로 두지 않는다. HEAD로 남은 quota를 확인하고 quota header가 누락되면 중단한다. quota 부족은 deferred_quota로 반환하며 후보를 공개하지 않는다.

## 저장 및 용량

- private bucket: 기존 `lol-augment-snapshots`.
- 공통 prefix: `external/champion-stats/champion_api_v1/`.
- `objects/<sha256>.json`: 원본/정규화 불변 파일. 기존 경로가 있으면 내용 해시를 확인하고 재사용한다.
- `progress/<dataVersion>-<catalogHash>.json`: 전용 lease 하에서만 갱신하는 수집 진행 파일. 원본·정규화본 해시/bytes/ID/버전을 대조한 뒤 재개한다.
- `captures/<captureHash>/manifest.json`: 완료한 파일 목록. 예상 챔피언이 한 명이라도 빠지면 후보 생성/승인을 차단한다.
- Postgres: `lol_mayhem_champion_dataset_releases`, `lol_mayhem_champion_dataset_publications`. 원본/통계 상세 행을 DB에 중복 적재하지 않는다. RLS 및 서비스 역할 전용 권한.

개별 파일2MiB, metadata256KiB, manifest/progress1MiB, 한 실행의 누적 업로드64MiB, prefix 누적 예산2GiB다. 현재 누적 크기를 확인할 수 없으면 쓰기를 중단한다. metadata size 누락을0으로 보정하지 않는다. 누적 크기+배치 상한+진행 여유1MiB가 예산을 넘으면 업로드 전에 종료한다. 자동 삭제는 없다. 예산 초과 때는 마지막 공개본을 유지하고 별도 보관/정리 작업을 설계한다.

매일64MiB가 새로 생기는 상한 시나리오는30일 약1.88GiB다. 이는 실제 API의 측정된 수집량/요금이 아니다. 최초 전체 dry-run 및 후보 생성의 실제 bytes를 기준으로 용량을 재평가한다. 객체 해시 재사용과 진행 파일 덮어쓰기로 실제 증가량은 달라진다.

## 검토·공개·롤백

관리자 `/admin/lol/mayhem-datasets`의 챔피언 통계 영역에서 후보 버전·패치·표본 범위·원천 날짜·파일 완전성·사용 근거를 확인한다. 기존 관리자 로그인·same-origin·명시 확인을 사용한다. 동시 공개는 expectedPublication으로 차단하며 충돌은409다.

승인은 원본/정규화본·manifest 해시와 공식 카탈로그 ID를 다시 대조한다. raw는 외부에 직접 공개하지 않는다. 공개 API `/api/lol/mayhem/champion-stats/[championId]?patch=16.21`는 승인·게시된 버전의 allowlist 필드만 반환한다. 빠른 챔피언 전환 시 이전 응답을 현재 화면에 적용하지 않는다.

선택률은 출처가 제공한 비율이다. 원천 수식 미확인이면 분모를 만들지 않는다. null/0/누락 및 CN/WORLD 출처를 보존한다. 증강 승률·승률 기반 순위/티어는 공개하지 않는다. 선택 기록이 없으면 제시 여부 미확인이며, 등장 불가라고 표시하지 않는다.

공개 포인터 캐시60초, 불변 통계 캐시1시간을 사용하고 공개·롤백 시 전용 tag를 재검증한다. 이전 패치 자료를 현재 패치 통계로 바꾸지 않는다. 최신 공식 카탈로그만 있고 최신 통계가 없으면 과거 자료를 최신으로 채우지 않고 미제공 상태를 표시한다.

오류/원천 버전 변경/중복 작업/lease 만료는 후보 생성을 중단하고 공개본을 유지한다. lease는120초, token과 DB clock 검증,30초마다 갱신한다. 9분 수집 중단 상한으로 Actions10분 안에 상태 저장·lease 해제를 시도한다. RPC의 도메인 충돌은 `PT409`로 처리해 PostgREST 자동 재시도 폭주를 피한다.

## 적용 및 검증

migration `20261104110000_lol_mayhem_champion_datasets.sql`은 격리 로컬에서 검증한 뒤 별도 운영 적용 대상으로 관리한다. 기존 bucket을 다시 만들거나 현재 편집 조합 후보를 삭제하지 않는다.

```bash
npx vitest run tests/lol-mayhem-champion-*.test.ts
npm run verify:migrations
npm run verify:core
npm run verify:lol
RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-mayhem-browser.test.ts
npm run test:unit
```

모바일375×667,390×844,430×932 및 데스크톱1440×900의 fixture 브라우저 검증과 실제 모바일 기기 검증은 구분한다. API 인증·완전한 실제173명 수집·운영 적용을 합성 fixture 검증으로 대체해 완료로 보고하지 않는다.


## 준비 검증 기록 (2026-11-04)

- 실제 무료 `--check` 성공: source16.21/dataVersion16.21.5, 유료 API credit0·DB/Storage 쓰기0. key·재사용 확인·활성화 설정은 false.
- API 키가 없는 `--dry-run`은 유료 요청 전에 `stats_api_key_missing`, 종료 코드1.
- GitHub Secret 이름과 로컬 설정 이름을 확인했으며 새 통계 API key와 사용 조건 값은 없었다. Secret 값은 조회·출력하지 않았다.
- 공통 lint/타입, LoL, 관리자, 전체 단위 테스트 및 격리 PostgreSQL 검증 통과. 새 경로 focused test45개, 브라우저 fixture12개 통과. 캡처에서 모바일 통계 행·관리자 줄바꿈을 확인했다.
- 실제 인증·원본173명 전수 수집·운영 migration 적용·실기기·배포는 미실행이다. 운영에 반영할 때 API 인증 응답을 대조한 후 dry-run → 후보 저장 → 관리자 검수 → 공개 순서를 따른다.


## 실제 API 연동 보정 (2026-11-04)

인증된 원시 응답에서 선택률 출처는 CN이고 `num_games`는 별도 WORLD 익명 업로드에서 올 수 있음을 확인했다. 행의 `win_rate_source`, `win_rate_region`, `win_rate_game_patch`, `win_rate_date`가 선택률의 출처·지역·패치·날짜와 다르거나 명시적으로 미확인이면 공개 표본 수를 null로 보관한다. 원문은 private에 보존하며 비율은 변경하지 않는다. 이 count를 선택률의 분모로 사용하지 않는다.

공급원 문서는 제3자 API 연동, 진행 상황·로컬 캐시 저장을 안내한다. 이 근거를 기록해 비공개 검수 후보 수집을 허용한다. API 접근권과 공개 재사용 확인을 구분하며, `LOL_MAYHEM_STATS_REUSE_CONFIRMED=false`에서는 검수 승인·공개·공개 API 읽기를 차단한다. 공개 승인은 실제 데이터와 재사용 범위를 검토한 뒤 기존 관리자 절차로 수행한다.

## 챔피언 통계 공개 화면

`/lol/kr/aram-mayhem`의 기본 보기는 챔피언별 증강 통계이며 `전체 증강 도감`으로 기존 도감을 볼 수 있다. 챔피언 이름·영문·초성 검색과 증강 이름·효과·등급 필터를 제공한다. 정렬은 출처 제공 선택률 내림차순, 미제공은 마지막이며 0%와 구분한다. 원천 통계와 현재 카탈로그의 ID를 연결해 아이콘·등급·효과를 표시한다.

2026-11-04 사이트 소유자가 정제 통계의 공개 화면 제공을 요청했다. 공급원의 서드파티 연동 문서를 근거로 ARAMGG 출처를 명시해 표시하며 API 키와 원본 스냅샷은 비공개로 유지한다. 이 공개 범위는 승률이나 등장 가능 목록의 추정을 포함하지 않는다. 공개 전 기존 관리자 인증·후보 승인·게시 절차와 해시 검증은 유지한다. 신규 수집 후보는 계속 검수 후 게시한다.

공개 화면은 초상화 챔피언 목록과 증강 카드로 구성한다. 검색은 목록만 좁히며 클릭으로 챔피언을 확정한다. 모바일 목록은 기본 접힘이다. 사용자 요청에 따라 출처·지역 문구는 화면에서 제거하고 원본·정규화본의 출처 범위와 검증은 유지한다. 챔피언 초상화는 페이지에서 조회한 Data Dragon 버전을 그대로 사용한다.


## 증바람 전용 아이템 평가 (로컬, 배포 보류)

`LOL_MAYHEM_ITEMS_ENABLED=true`에서 챔피언별 `증바람 아이템`을 표시한다. 증강 통계 플래그와 독립적으로 켤 수 있다. 일반 칼바람(450)의 빌드·스킬·주문은 연결하지 않는다.

- 원천: `https://data.v2.iesdev.com/api/v1/query_objects/prod/lol/aram_mayhem_champion?champion_id={id}`. 서버에서 키 없이 조회한다. `meta.query=aram_mayhem_champion`, `meta.game=lol`, 챔피언 ID·패치·기준일과 아이템의 1~5티어를 검증한다.
- 저장: Next.js Data Cache에 챔피언별 정규화 결과를 6시간, 패치별 Data Dragon 아이템 메타데이터를 6시간, 버전 목록을 1시간 캐시한다. 새 DB 테이블·Storage 파일·브라우저 저장은 만들지 않는다. 이 캐시는 수집 이력을 보존하는 데이터셋이 아니다. 기존 증강 데이터셋은 private Storage와 검수·게시 계약을 그대로 사용한다.
- 화면: 공급원의 평가 등급과 같은 패치 한국어 이름·아이콘·제작 재료만 제공한다. 재료 순서는 실제 구매 순서를 의미하지 않는다. 선택률·승률·표본 수·스킬·주문을 추정하지 않는다.
- 2026-11-04 확인본은 아이템16.22, 기존 게시 증강16.21이다. 패치와 기준일을 각각 표시하며 일치하는 Data Dragon 패치가 없으면 다른 패치로 대체하지 않는다.
- 이 변경은 PR #434 초안과 로컬에만 유지한다. 운영 플래그 변경·머지·배포는 하지 않는다.

포로 간식(ID2052·220013)은 원천에 평가 등급이 있어도 아이템 및 제작 재료 목록에서 제외한다. 정규화 캐시 키는 `lol-mayhem-item-ratings-v2-no-poro-snax`로 바꿔 기존 캐시에 남은 항목도 제거한다. UI의 1~5티어는 원천의 `items[id].tier` 그대로이며 산정식·가중치·등급 경계는 확인되지 않았다. 승률 순위나 BGMS 자체 평가로 설명하지 않는다.

2026-11-05 사용자 요청으로 장비·신발 보기를 분리했다. 같은 패치 Data Dragon의 `Boots` 태그를 `isBoots`로 정규화하며 일반 신발과 상위/모드별 신발을 동일하게 분류한다. 새 캐시 키는 `lol-mayhem-item-ratings-v3-boots`다. 분류를 바꾸면 검색·티어 필터를 초기화하고 각 분류 안에서 검색·티어를 적용한다. 화면의 산정식·선택률·구매 순서 안내 문장과 검색 placeholder는 제거한다. 검색 입력의 접근성 이름 `아이템 검색`은 유지한다. 등급과 원천 지역에 대한 저장 계약은 변경하지 않는다.


### 한국 지역 증바람 통계 확인 (2026-11-05)

현재 증강 선택률의 CN은 공급원의 모집단이며 게임 서버 선택 설정이 아니다. IESDEV 아이템 평가 응답에는 지역 구분이 없어 KR 통계라고 표시하지 않는다. Riot의 Mayhem match-v5 비공개 처리는 [공식 개발자 저장소 이슈](https://github.com/RiotGames/developer-relations/issues/1109)에 정상 동작으로 정리돼 있다. [OP.GG 안내](https://help.op.gg/hc/en-us/articles/60909599637657-How-to-Check-ARAM-Mayhem-Match-History)는 연결한 계정의 본인 경기만 데스크톱 앱으로 수집한다고 명시한다.

[METAsrc 한국 필터 페이지](https://www.metasrc.com/lol/mayhem/champions/teemo/build?region=kr)는 Mayhem 구간의 수치·추천을 ARAM과 Arena 경기에서 파생했다고 밝힌다. 이를 한국 증바람 실측 자료로 연결하지 않는다. 바로 연동할 수 있는 KR 전용 증바람 공개 집계 API는 이번 확인에서 확보하지 못했다. 한국 표본을 확보하려면 지역을 확인할 수 있는 별도 제공자와 연동하거나 한국 플레이어가 동의한 클라이언트 수집이 필요하다. 새 수집기·데이터베이스·외부 전송은 이 UI 변경에 포함하지 않는다.
