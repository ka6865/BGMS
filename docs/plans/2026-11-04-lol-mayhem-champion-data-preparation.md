# 증바람 챔피언별 선택 통계 구현 준비 계획

> **For agentic workers:** 구현 시 `superpowers:executing-plans`로 작업별 검증을 수행한다. 아래 체크박스는 아직 구현하지 않은 작업이다.

**Goal:** 챔피언별 출처 제공 선택률을 패치·모집단·통계 날짜와 함께 검토·공개하고, 선택 관측과 제시 가능 여부를 구분한다.

**Architecture:** 기존 비공개 Supabase Storage에 원본과 챔피언별 정규화 JSON을 보관한다. Postgres에는 검토 가능한 릴리스와 공개 포인터만 추가한다. 수집은 후보를 생성하고 공개는 기존 관리자 권한·확인·감사 절차로 분리한다.

**Tech Stack:** 현재 Next.js/TypeScript, Supabase Postgres/Storage, GitHub Actions, Vitest, 기존 Puppeteer fixture. 신규 의존성은 추가하지 않는다.

**Spec:** [기존 콘텐츠 설계](2026-10-23-aram-mayhem-content-design.md)의 ID·출현 판정 원칙과 아래 조사 계약. 실명·URL·원본 스키마는 Git 제외 경로 `docs-private/lol-research/2026-11-04-mayhem-champion-dataset-research.md`에 있다. 이 문서는 공개 구현 계약을 포함하며, 공급원 연결을 시작할 때 비공개 조사 자료와 현재 API 문서를 함께 확인한다.

## 현재 확인한 범위

- CDN 후보에서 트위치 전체129개, 럭스121개, 유미110개의 증강 행을 받았다. 단계별 행과 트위치 상위 구간까지 합한 2,262행을 검사했다. 16.21 고정 공식 카탈로그 KIWI249개에 표본의 숫자 ID가 모두 연결됐다. 전체173명 전수 검사는 아니다.
- 별도 제3자 API 후보는 인증·스키마·한도가 문서화되어 있다. 운영 연동 1순위 검토 대상이며, 아직 key 인증 응답과 서버 저장·재게시 조건은 검증하지 않았다. CDN 후보는 개발 표본으로 사용한다. 다중 공급원 운영·자동 대체 기능은 초기 범위에서 제외한다.
- 제3자 원시 API는 챔피언 ID와 JSON 문자열 통계·버전·날짜의 tuple이다. 증강별 숫자 ID 키 아래 문자열 비율이 있으며 표본 수는 null일 수 있다. 친화형 상세의 count는 선택률과 다른 지역·수집원에서 올 수도 있다.
- 독립 관측 후보의 queue2400/patch26.21 챔피언×증강 집계는 10,679행이다(총 건수와 1행만 확인). 제시 횟수는 확인되지 않았다.
- 일부 서비스의 챔피언별 제외 분류는 패치 전후 선택 기록을 비교한 추정이다. 현재 공식 전체 허용·제외 행렬은 확보하지 못했다.

## Global Constraints

- 기존 문자열 ID 매핑·전역 선택률·편집 조합 후보를 보존한다. 새 숫자 ID 통계를 기존 미매핑249개 검수에 종속시키지 않는다.
- 같은 패치의 `lol_augment_patch_states`와 공식 챔피언 카탈로그로 숫자 ID를 검증한다. 이름 유사도로 매핑하지 않는다.
- 비율은 0~1 원문 소수를 문자열로 보존한다. 화면에서만 100을 곱한다. `193070 / 3952465`로 원문 `0.0697`을 덮어쓰지 않는다.
- 선택률의 분모가 불명확하면 `denominatorKind='unverified_source_definition'`, `denominatorCount=null`로 둔다. 제시 확률·제시 대비 선택률이라고 표시하지 않는다.
- 표본 0·null·누락을 구분한다. 다른 지역의 count를 선택률의 표본으로 붙이지 않는다. 출처 제공 비율과 관측 선택 횟수도 구분한다.
- 원본의 승률·승률 순위·티어·상승 효과는 정규화와 공개 DTO에서 제외한다. public API는 allowlist를 사용한다.
- 후보 생성은 공개를 변경하지 않는다. 실패·quota 소진·패치 변경 때 마지막 정상 공개본을 유지한다.
- secret은 서버·Actions Secret에만 둔다. URL query·manifest·로그·브라우저 번들에는 넣지 않는다.
- 이번 작업은 조사와 설계까지다. 운영 적재·계정/key 생성·외부 문의 발송·배포는 수행하지 않았다.

## Review Focus

1. 숫자 ID가 있어도 다른 패치에만 존재하면 후보 공개를 막는다(Task 1·2).
2. 원천 데이터의 모집단이 불명확하거나 CN이면 KR·전체 티어 통계로 바꾸지 않는다(Task 1·4).
3. 중간에 원천 버전 변경·429·누락 파일이 생기면 이전 공개본을 유지한다(Task 3).
4. 관리자 두 명의 동시 공개와 만료된 lease는 재시도 폭주 없이 409로 끝난다(Task 2·4).
5. 통계 누락·0%·카탈로그 존재를 등장 불가/가능으로 표시하지 않는다(Task 1·4).

## 저장 및 공개 계약

첫 운영 공급원 키는 `champion_api_v1`, 모집단 키는 `source_default`로 고정한다. 실제 source/region은 지표별 메타에 별도로 보존한다. CDN 표본의 all/high는 서로 다른 구간이며 API 후보에 같은 구간 정의를 가정하지 않는다. 첫 버전은 단계 통합 선택률만 연동한다.

| 저장 위치 | 내용·제약 |
| --- | --- |
| 기존 private bucket `lol-augment-snapshots` | `external/champion-stats/champion_api_v1/objects/<sha256>.json`에 원본과 정규화 파일. `captures/<captureHash>/manifest.json`에 파일 참조. `upsert:false`, 내용 해시 대조, 원본 공개 금지 |
| 신규 `lol_mayhem_champion_dataset_releases` | `id bigint identity` PK, `source text`, `client_patch text` FK, `cohort text`, `upstream_version text`, `source_data_date date`, `capture_hash text`, `manifest_path text`, `normalizer_version integer`, `catalog_hash text`, `status text`, `metadata jsonb`, 검토자 UUID·검토/수집 시각 timestamptz |
| 신규 `lol_mayhem_champion_dataset_publications` | `(source,client_patch,cohort)` PK, `release_id bigint`, `previous_release_id bigint`, 공개자 UUID·시각. 두 참조 모두 릴리스 `(id,source,client_patch,cohort)` 복합 FK로 다른 패치·출처 공개를 차단 |
| 기존 `lol_data_sync_status`·`admin_audit_events` | 점검·수집·변경·공개 시각을 구분하고 오류 코드·수량만 기록. 검토·공개·롤백 감사 기록 |

릴리스는 `(source,client_patch,cohort,capture_hash,normalizer_version)` unique 및 복합 FK 대상 unique를 둔다. status는 pending/approved/rejected, source/cohort는 위 고정값을 CHECK한다. hash는 소문자 64hex, JSON 메타는 64KiB 이하, 경로는 서버 생성 prefix만 허용한다. 패치·상태·수집시각 인덱스와 검토자/공개 FK 인덱스를 둔다. 두 테이블 모두 RLS 활성화 및 anon/authenticated 직접 접근 차단, 서비스 역할만 쓴다.

정규화 단위 `ChampionStatsFile`은 다음으로 제한한다.

- 헤더: `schemaVersion=1`, source, clientPatch, cohort, upstreamVersion, sourceDataDate, fetchedAt, championId, catalogHash.
- `rows[]`: augmentPlatformId, reportedPickRate(`string|null`), reportedSampleCount(`integer|null`), rateSource/region, countSource/region, countMeaning(`string|null`), denominatorKind, denominatorCount(`integer|null`). 같은 챔피언 내 증강 ID 중복은 거부한다.
- `selectionEvidence`: 검증된 선택 횟수가 양수일 때 reported_count, 양수 선택률만 있으면 reported_rate, 그 외 null. 두 경우를 모두 “실측 N회”로 표시하지 않는다. `offerEligibility='unknown'` 고정. 별도 제시 횟수·확률은 만들지 않는다.
- 단일 count 필드라도 rate와 범위가 다르면 공개 표본으로 연결하지 않는다. 원천 null은 null 그대로, 누락된 단계는 전체 단계 가능으로 확장하지 않는다.

manifest에는 예상·완료 챔피언 ID 목록, 원본/정규화 파일별 SHA·크기·ETag·수집시각·버전, 공식 카탈로그 해시, 정규화기 버전, 사용 조건 근거 및 출처 표기문을 기록한다. captureHash는 정렬된 내용 해시·메타로 계산한다. 자체 해시는 BGMS 파일 불변성을 보장하며 원천 서버 전체의 동시 갱신을 증명하지 않는다. 메타를 전후 재확인하고 개별 버전·날짜 일치도 별도 검사한다.

처음에는 상세 행을 Postgres에 중복 적재하지 않는다. 챔피언 선택 시 서버가 해당 JSON 하나를 읽는다. 챔피언 전체를 가로지르는 SQL 분석 요구가 생기면 측정 후 별도 집계를 설계한다. AI 분석·제보 시스템·R2 이전은 범위 밖이다.

보관 비용은 실제 원시 API 전수 수집 전에는 확정하지 않는다. 배치 상한64MiB가 매일 새로 생긴다면 30일 약1.88GiB이며, 이는 정규화본·manifest·공식 카탈로그를 포함한 배치 총량 상한이다. 최초 운영 전 이 prefix의 누적 예산2GiB를 확인하고 남은 예산보다 큰 작업은 쓰기 시작 전에 중단한다. 동일 해시 파일은 재사용한다. 초기 자동 삭제는 두지 않으며, 공개본·롤백본·진행 manifest의 참조를 고려한 별도 보관 정책을 정하기 전까지 예산 초과 시 마지막 공개본을 유지한다.

## 최신화 및 비용 계약

- metadata는 6시간마다 점검한다. HTTP 조건부 요청은 공급원이 지원하는 경우만 사용한다. 변경 없는 버전은 유료 데이터 요청을 보내지 않는다.
- 후보 API의 현재 문서 한도는 UTC일별200credits,60req/min이다. 원시 챔피언별 증강 파일1credit, 친화형 상세2credits다. 173명 예시에서 두 목록+원시 파일은175credits, 친화형 방식은348credits다. 챔피언 수173을 코드 상수로 쓰지 않는다.
- 초기 수집은 원시 파일 경로, locale `ko`를 사용한다. 숫자 ID·표시명은 기존 공식 카탈로그를 기준으로 한다. 문서의 quota 헤더와 사전 비용 추정 모두 확인하고 최소25credits를 남긴다. 문서/HEAD의 비용0을 데이터 응답304에도 임의 적용하지 않는다.
- 단일 worker, 요청 간 최소1초, 작업10분 상한, 개별 JSON2MiB·배치64MiB 상한을 둔다. 크기 초과는 안전하게 중단하고 측정 후 조정한다. 큰 부가 조합 파일은 수집하지 않는다.
- 버전별 진행 manifest를 private Storage에 기록해 받은 동일 파일을 재사용한다. 잔여 quota가 모자라면 다음 UTC일로 이어 받고 완전한 후보만 만든다. 원천에 이전 버전 조회가 없고 버전이 바뀌면 섞지 말고 새 후보로 시작한다.
- lease는 기존 acquire/release RPC에 전용 키 `ops:lol-mayhem-champion:champion_api_v1`, TTL120초를 사용한다. 기존 renew RPC는 옛 출처로 고정돼 있어 재사용하지 않는다. 전용 renew는 DB clock과 token·미만료 여부를 검증하고 매30초 및 DB 후보 저장 직전 갱신한다.
- 수집 실패·429는 정제된 오류/진행 상태를 남긴다. 공개본 자동 승격과 운영 자동 삭제는 하지 않는다. 안정화 전 스케줄은 꺼두고 수동 dry-run부터 시작한다.

## 파일 및 실행 작업

### Task 1: 인증 응답과 숫자 ID·지표 계약 확정

**Files:** 신규 `lib/lol/mayhemChampionDataset.ts`, `tests/lol-mayhem-champion-dataset.test.ts`, `tests/fixtures/lol-mayhem-champion/`.

**Interfaces:** `normalizeChampionAugments(input: unknown, context: ChampionStatsContext): ChampionStatsFile`. 같은 파일에서 위 두 타입을 export한다. context는 패치·모집단·championId·공식 허용 ID 집합·원천 버전·날짜·수집 시각·카탈로그 해시를 전달한다.

- [ ] 문서화된 제3자 key 경로의 트위치·럭스·유미 응답을 검증하고 저장·재게시 조건, 분모·표본 정의를 조사 기록에 반영한다. 현재 미확인 값을 사실로 바꾸지 않는다. 조건 미확인 상태에서도 오프라인 파서 검증은 가능하다.
- [ ] 응답에서 필요한 최소 필드만 남긴 fixture를 만들고, rate0.0697 보존·null/0 구분·범위 밖 비율·잘못된 tuple/JSON·중복·미등록 ID·다른 패치 ID·모집단 불일치·count 범위 불일치 테스트를 먼저 작성한다. 원본 데이터 fixture를 저장소에 넣기 전 재사용 조건을 확인한다. 그렇지 않으면 계약 기반 합성 fixture를 쓴다.
- [ ] `npx vitest run tests/lol-mayhem-champion-dataset.test.ts`의 실패를 확인한 뒤 최소 파서를 구현한다. reported_rate와 reported_count를 구별하고 rate0/누락에도 offerEligibility는 unknown인 테스트를 통과시킨다.
- [ ] 같은 명령 PASS를 확인하고 이 작업 파일만 커밋한다.

### Task 2: private 스냅샷과 원자적 검토·공개 저장

**Files:** 신규 `supabase/migrations/<구현시각>_lol_mayhem_champion_datasets.sql`, `lib/lol/mayhemChampionDatasetStore.server.ts`, `tests/lol-mayhem-champion-store.test.ts`, `tests/fixtures/migration-check/lol-mayhem-champion-dataset-scenarios.sql`; 수정 `scripts/verify_migrations_local.sh`.

**Interfaces:** Task 1 타입 사용. `getPublicChampionStats(patch: string, championId: number): Promise<ChampionStatsFile|null>`, `createChampionDatasetCandidate(input: ChampionCandidateInput): Promise<number>`를 export한다. `ChampionCandidateInput`은 위 릴리스 식별 필드·수량/검증 메타·manifest 해시/경로·leaseToken을 포함한다. 새 RPC `ingest_lol_mayhem_champion_dataset(p_candidate jsonb,p_token uuid)`가 이 입력을 검증하고 ID를 반환한다. `review_lol_mayhem_champion_dataset(p_id bigint,p_action text,p_expected_publication bigint,p_reviewed_by uuid,p_reason text)`와 `renew_lol_mayhem_champion_dataset_lease(p_token uuid)`를 포함해 모두 서비스 역할 전용이다.

- [ ] 위 저장 계약을 로컬 migration scenario로 작성한다. anon 접근 차단, 중복 ingest 멱등, 불완전 manifest 승인 거부, 잘못된 패치 FK, 동시 공개 CAS, 롤백·감사 기록을 검사한다. 일반 충돌은 SQLSTATE `PT409`로 끝나야 한다.
- [ ] 고정 공급원 전용 테이블·검토/후보 생성·renew RPC를 구현한다. 승인 시 ID·버전·파일 개수·카탈로그 해시·사용 조건 근거를 서버에서 재검증한다. 클라이언트가 보낸 검증 완료 bool만 신뢰하지 않는다.
- [ ] store는 공개 포인터60초, 불변 JSON1시간 캐시를 기존 Next API 방식으로 구현한다. 캐시 키에 source/patch/cohort/release/champion을 포함하고 해시·경로·크기·공개 DTO를 재검증한다. pending 후보는 읽히지 않는 테스트를 추가한다.
- [ ] `npx vitest run tests/lol-mayhem-champion-store.test.ts`와 `npm run verify:migrations`를 격리 로컬 DB 대상으로 통과시킨다. 운영 DB에는 적용하지 않고 관련 파일만 커밋한다.

### Task 3: quota 안에서 수집·중단 후 재개

**Files:** 신규 `lib/lol/mayhemChampionIngest.server.ts`, `scripts/lol_mayhem_champion_dataset_sync.ts`, `.github/workflows/lol-mayhem-champion-dataset.yml`, `tests/lol-mayhem-champion-ingest.test.ts`.

**Interfaces:** `ingestChampionDataset(options: {apply: boolean}): Promise<ChampionIngestSummary>`. CLI `--dry-run` 기본, `--apply` 명시. dry-run은 DB/Storage 쓰기 없이 받아서 검사한다. resume는 apply 경로에서만 저장한다. Task 1 파서·Task 2 저장 계약 사용.

- [ ] mock HTTP로 변경 없음·173명175credits·무료 한도보다 큰 목록·표본 null·429·파일 누락·버전 전환·재개 시 해시 불일치·동시 수집·lease 만료·보관 예산 초과를 검사한다. 173명 중1개라도 빠지면 기존 공개 포인터가 유지돼야 한다. 보관 예산 초과는 업로드0회여야 한다.
- [ ] 허용된 HTTPS 호스트와 경로를 코드에 고정하고 redirect 목적지도 검증한다. timeout·실제 응답 byte 상한·JSON 중첩 검사·quota 헤더/예산 검사와 위 갱신 계약을 구현한다. 수집 진행과 완료 후보를 구분하며 부분 manifest로 릴리스를 승인 가능 상태로 만들지 않는다.
- [ ] workflow는 기존 Actions 버전 고정·read-only contents·동시 실행 제한을 따른다. `LOL_MAYHEM_CHAMPION_DATASET_ENABLED` 기본 false, `LOL_MAYHEM_STATS_API_KEY` 서버 Secret, 수동 실행 dry-run 기본 true, timeout10분으로 둔다. 기존 전체 조합 수집 job은 변경하지 않는다.
- [ ] `npx vitest run tests/lol-mayhem-champion-ingest.test.ts`와 `npx tsx scripts/lol_mayhem_champion_dataset_sync.ts --dry-run`을 실행한다. 실제 인증이 없으면 후자는 미실행 사유를 남긴다. 성공한 관련 파일만 커밋한다.

### Task 4: 관리자 검토와 기존 증바람 화면의 챔피언 선택 연결

**Files:** 신규 `app/api/admin/lol/mayhem-champion-datasets/route.ts`, `app/api/lol/mayhem/champion-stats/[championId]/route.ts`, `components/lol/LolMayhemChampionStats.tsx`, `tests/lol-mayhem-champion-api.test.ts`; 수정 `app/admin/lol/mayhem-datasets/MayhemDatasetReviewPanel.tsx`, `components/lol/LolMayhemView.tsx`, `app/lol/kr/aram-mayhem/page.tsx`, `tests/lol-mayhem-browser.test.ts`.

**Interfaces:** 관리자 GET은 후보·manifest 요약, POST는 approve/reject/publish/rollback + `expectedPublication`·명시 확인을 받는다. 새 public GET은 `?patch=16.21`과 등록된 championId만 받으며 Task 2 `getPublicChampionStats`를 호출한다. 브라우저는 공급원·Storage에 직접 접근하지 않는다.

- [ ] 현재 관리자 `requireLolDevAdmin`·same-origin·영속화 flag·본문 상한·감사 패턴을 재사용한다. 권한 없음·확인 누락·비정상 patch/ID·미승인본·CAS409·비밀/승률 필드 유출 없음 테스트를 먼저 작성한다.
- [ ] 기존 관리자 화면에 챔피언 통계 검토 영역을 추가하고 별도 API를 사용한다. 원본 버전·표본 정의·미확인 분모·사용 조건·차이·검증 누락을 표시하고 검토 실패 시 publish를 막는다. 공개/롤백 시 새 캐시 tag를 재검증한다.
- [ ] 기존 `/lol/kr/aram-mayhem` 안에서 챔피언 선택 시 통계가 아래에 나타나도록 연결한다. 새 독립 페이지는 만들지 않는다. 로딩·오류·“이 챔피언의 선택 통계가 아직 없습니다”·재시도 상태를 제공하고 빠른 챔피언 전환의 이전 응답이 덮어쓰지 않게 한다.
- [ ] 출처·실제 지역·원천 패치·통계 날짜·서버 확인 시각을 구별해 표시한다. 공식 카탈로그가 최신이어도 이전 통계는 “이전 패치 통계”로 표시한다. count가 없으면 표본 수를 만들지 않고, 분모 미확인 시 “출처 제공 선택률 · 분모 미확인”, 관측 공백은 “제시 여부 미확인”으로 쓴다.
- [ ] `npx vitest run tests/lol-mayhem-champion-api.test.ts`와 기존 fixture 하네스 `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-mayhem-browser.test.ts`를 통과시킨다. 375×667,390×844,430×932,1440×900에서 선택·빈/오류·오래된 통계·키보드 조작·44px 터치 영역·가로 넘침을 확인한다. 실제 모바일 기기 검증과 구별한다.
- [ ] `npm run verify:core`, `npm run verify:lol`, `npm run test:unit` 통과 후 관련 파일만 커밋한다. 구현 시작 전 저장소에 설치된 Next 문서와 관련 BGMS UI 스킬을 읽는다.

## 적용 순서와 완료 조건

Task 1 → Task 2 → Task 3 → Task 4 순서로 진행한다. 최초 검증은 세 챔피언 dry-run, 이후 목록 전체의 완전한 후보 생성, 관리자 검토·공개·롤백 로컬 검증까지다. 전체 수집 전 실제 응답 크기·총 bytes·quota 비용을 다시 측정한다. 공개 후보는 ID 조인 미해결0·잘못된 비율0·예상 파일 누락0·버전 혼합0이어야 한다.

운영 API 인증·저장/재게시 조건이 미확인인 상태를 준비 완료한 운영 연동으로 보고하지 않는다. 공급원 변경이 필요하면 source CHECK와 parser 계약을 명시적으로 변경하고 기존 데이터를 다른 출처 이름으로 저장하지 않는다. 전체 허용·제외표는 별도 공식 규칙 또는 검증된 제시 관측이 확보될 때 확장한다.

## 이번 준비 작업의 검증 기록

- 재현 명령: `python3 tmp/lol-mayhem-research/2026-11-04/validate_samples.py`.
- 산출물: 같은 폴더 `sample-validation.json`, `selected-stats-preview.json`, HTTP/ETag·원본 SHA 기록. CDN 표본4개·2,262행·숫자 ID 미해결0·운영 쓰기0이며 API 후보 인증 검증과 다르다.
- 문서만 변경했으므로 제품 lint/build/단위 테스트·브라우저·운영 DB 검증은 실행하지 않는다. 현재 구현 상태·관련 경로·package.json 명령·문서 계약을 대조한다.
