# LoL 화면 개선과 통계·증바람 데이터 저장 및 최신화 설계

작성일: 2026-11-04. 화면 개선은 이 브랜치의 구현 범위다. 아래 신규 테이블·수집 주기·보관 정책은 **구현 전 설계안**이며 운영 DB, 버킷, Actions 설정을 변경하지 않았다. 운영 실행 여부·실제 사용량·계약 요금은 조회하지 않았다.

## 1. 결정

- 소환사 전적과 일반 랭크 통계는 기존 Supabase Postgres 저장 계약을 유지한다.
- 증바람 해외 JSON 원본은 기존 **비공개 Supabase Storage `lol-augment-snapshots`** 안에 별도 접두사로 저장한다. 화면 조회용 관계·수치는 Postgres에 정규화한다.
- `수집 완료 → 검증 → 검수 → 공개 포인터 교체`를 분리한다. 수집 실패 시 공개본을 유지한다.
- 해외 추천 조합, 전체 증강 선택률, 챔피언별 선택률, 등장 가능 여부를 혼합하지 않는다. 현재 확보한 공개 파일만으로 챔피언별 실제 선택률·등장 풀은 만들 수 없다.
- R2로 기존 증강 원본을 옮기거나 새 큐·웨어하우스·AI 분석을 추가하지 않는다. 현재 자료는 파일당 1MB 안팎이어서 기존 저장 경로를 확장하는 편이 단순하다.

## 2. 현재 코드에서 확인한 저장 위치

| 데이터 | 현재 저장 위치 / 읽는 경로 | 해석과 제한 |
| --- | --- | --- |
| 검색 기록·즐겨찾기 | 브라우저 `localStorage`, `bgms:lol-search-history:v1` | 최근 10개·즐겨찾기 20개. 계정 동기화 없음. Riot ID가 이 브라우저에 남으며 삭제 기능 유지 |
| 소환사·개별 경기 | `lol_accounts`, `lol_ranked_entries`, `lol_matches`, `lol_match_participants`, `lol_player_match_summaries`, `lol_api_cache` 등 기존 테이블 | 개인 전적 저장 계약을 별도 통계 데이터셋에 복제하지 않음 |
| 솔로 랭크 챔피언 통계 | `lol_stat_totals`, `lol_stat_champions`, `lol_stat_bans`, `lol_stat_builds`, `lol_stat_matchups` | 큐 420, 패치·티어별 익명 누적. 별도 수집기는 PUUID·Riot ID·경기 원문을 저장하지 않음 |
| 통계 중복 방지·재개 | `lol_stat_processed_matches`, `lol_stat_collector_state` | 경기 ID로 중복 누적 방지, 티어별 페이지·순번 재개 |
| 공식 증강 카탈로그 | `lol_game_patches`, `lol_augments`, `lol_augment_patch_states`, `lol_augment_localizations` 등 | 공개 포인터는 `lol_augment_publication`. 공식 패치 상태가 해외 조합보다 우선 |
| 공식 증강 원본 | Storage `lol-augment-snapshots`, `${clientPatch}/${kind}-${sha256}.json` 및 manifest | migration 기준 비공개, JSON만, 파일당 64MiB 제한. 실제 버킷 설정은 운영 반영 전 재확인 |
| 증강 아이콘 | 별도 기존 아이콘 버킷 | 원본 JSON 보관과 구분하고 기존 아이콘 제공 경로 재사용 |

근거: `scripts/lol_augments_ingest.ts`, `lib/lol/augments/{persistence,admin,catalog}.server.ts`, `supabase/migrations/20261024010000_lol_augment_catalog.sql`, `supabase/migrations/20261028130000_lol_champion_stats.sql`, `docs/operations/2026-10-27-lol-champion-stats.md`.

현재 `lol_augment_ingestion_runs.snapshot_path`는 공식 파일명만 허용하고, `lol_augment_data_sources.kind`도 `client_data|official_note`만 허용한다. 해외 자료를 공식 수집 실행으로 위장해 넣지 않는다. Storage 버킷만 재사용하고 아래 별도 데이터셋 메타데이터로 관리한다.

## 3. 해외 데이터의 의미와 식별자

첫 후보는 [arammayhem.com 공개 데이터](https://arammayhem.com/data/)다. 데이터는 CC BY 4.0으로 재사용 가능하다고 명시되어 있으며 화면·재배포 데이터에 출처 링크와 가공 여부를 표시한다. Riot 이미지·상표의 권리까지 이 라이선스에 포함된다고 해석하지 않는다.

2026-11-04 조사에서 실제 내려받은 파일 기준:

| 파일 | 확인 규모 | 저장·공개 의미 |
| --- | --- | --- |
| `data/v1/index.json` | 약 8KB, 최신 통계 패치 26.21, 통계일 2026-11-02 | 파일 주소·releaseId·날짜의 출처. 과거 `estimated` 날짜는 추정 표시 유지 |
| `data/v1/latest/augments.json` | 152,250바이트, 207행 | **전체 증강 선택률**. 챔피언별 조건부 선택률이 아님. 분모·서버·표본 수가 없으면 null로 둠 |
| `data/v1/latest/combos.json` | 867,900바이트, 666개 조합, 157챔피언 | **편집된 챔피언–증강 조합**. `god`, `trap`, `blackTech`는 편집 태그이며 실측 티어·선택률이 아님 |

조사 시 combos의 meta에는 releaseId만 있고 패치·통계일이 없었다. 같은 releaseId의 전체 선택률 파일에서 날짜를 복사해 조합의 통계일처럼 표시하지 않는다. 공개 시 별도의 `검수한 게임 패치`와 `원본 확인 시각`을 쓴다. 이 규모는 조사 시점의 관측값이며 수집기 상수로 고정하지 않는다.

- 외부 `championId`는 `Brand`, `Shyvana` 같은 문자열이다. 동일 패치 Data Dragon 챔피언 목록의 `id → key`로 숫자 챔피언 ID에 매핑한다. 표시용 한국어 이름으로 조인하지 않는다.
- 원본 표시 패치 `26.21`과 DB 클라이언트 패치 `16.21`은 기존 `lol_game_patches`의 검증된 대응 행으로 연결한다. 대응 행이 없으면 보류하며 문자열 추측으로 새 패치를 등록하지 않는다.
- 외부 `augmentId`는 `infernal_conduit`, `marksmage` 같은 자체 ID다. BGMS `lol_augments.platform_id`는 정수다. 최초 매핑은 이름·설명·등급·공식 패치 상태를 대조해 검수하고, 문자열 유사도만으로 공개하지 않는다.
- `augmentIds` 여러 개는 한 조합으로 보존한다. 분리한 항목을 각각 독립적인 추천 관계로 바꾸지 않는다.
- 공식 `KIWI` 풀에 존재한다는 사실은 해당 챔피언에게 반드시 등장한다는 증거가 아니다. `등장 가능`, `등장 불가` 판정은 챔피언 조건을 확인한 별도 근거가 생기기 전까지 미확인이다. 선택률 0도 등장 불가의 근거가 아니다.
- 다른 해외 사이트의 챔피언별 수치는 재배포 허용·패치·분모를 확인하기 전 수집 대상에서 제외한다. 현 범위에서는 증강 승률을 가져오거나 계산·노출하지 않는다.

## 4. 원본 파일 저장 계약

버킷: 기존 비공개 `lol-augment-snapshots`. 새 접두사만 사용한다.

```text
external/arammayhem/objects/<raw_sha256>.json
external/arammayhem/batches/<batch_sha256>/manifest.json
external/arammayhem/batches/<batch_sha256>/normalized/<client_patch>/v<normalizer_version>-m<mapping_revision>.json
```

`objects/`에는 index·augments·combos 각각의 응답 원문을 해시 이름으로 저장한다. `batch_sha256`는 augments·combos의 파일 종류와 원문 SHA-256을 정렬해 계산한다. index의 확인 시각만 바뀐 경우 새 데이터 버전을 만들지 않는다. 외부 releaseId를 경로로 직접 쓰지 않는다. 원본 manifest에는 파일별 객체 경로·URL·해시·바이트 수·ETag/Last-Modified·최초 응답 확인 시각·외부 releaseId·라이선스를 넣는다. `normalized/` manifest에는 원본 manifest 경로, 정규화 버전·매핑 revision·검수 패치·사용한 매핑과 결과 건수를 넣고 release가 이를 참조한다. 매핑 수정이나 다음 패치 검수가 원본 manifest를 덮어쓰지 않도록 경로도 버전별로 다르게 둔다.

원문과 manifest는 수정하지 않으며 업로드는 `upsert:false`다. 같은 내용은 다시 저장하지 않고 재확인 시각은 DB 작업 상태만 갱신한다. 같은 외부 releaseId라도 내용이 수정되면 새 해시의 버전이 된다.

브라우저는 원본 버킷에 직접 접근하지 않는다. 기존 서버 service role로 업로드·검수 다운로드하고, 공개 API는 검수된 DTO만 반환한다. private bucket은 다운로드에도 접근 제어가 적용된다([Supabase 공식 문서](https://supabase.com/docs/guides/storage/buckets/fundamentals)).

수집은 고정된 HTTPS 호스트·파일 종류만 허용한다. 외부 JSON 안의 임의 URL을 따라가지 않는다. 허용되지 않은 리디렉션, HTML 응답, 파일당 4MiB 초과, 배치 합계 12MiB 초과, 30초 초과 요청은 중단한다. 이 한도는 기존 버킷 최대값보다 작은 애플리케이션 검증 한도다.

## 5. 조회용 Postgres 설계 — 신규 제안, 미적용

기존 공식 카탈로그를 복제하지 않고 다음 데이터만 추가한다. PK/FK 열에는 인덱스를 두고 공개 쿼리에 필요한 복합 인덱스만 추가한다. PK의 선두 열이 같은 중복 인덱스는 만들지 않는다.

| 제안 테이블 | 키와 핵심 필드 | 계약 |
| --- | --- | --- |
| `lol_mayhem_dataset_releases` | `id bigint identity` PK, `source text`, `upstream_release_id text`, `batch_hash text`, `normalizer_version integer`, `mapping_revision integer`, `verified_client_patch text`, `manifest_path text`, 파일별 meta `jsonb`, `fetched_at timestamptz`, `status text`, 검수 기록 | `(source,batch_hash,normalizer_version,mapping_revision,verified_client_patch)` UNIQUE. 검수 대상 패치는 기존 패치 FK. 원본 패치·통계일은 파일별 nullable. `pending/validated/approved/rejected`로 공개 여부와 분리 |
| `lol_mayhem_augment_mappings` | `(source,external_id,client_patch)` PK, `platform_id integer`, `mode_name='KIWI'`, `status`, 근거·검수자·검수 시각 | `(platform_id,client_patch,mode_name)` → 기존 `lol_augment_patch_states` FK. `approved`만 정규화 가능. 한국어 번역·별칭은 공식 카탈로그와 구분 |
| `lol_mayhem_augment_pick_rates` | `(release_id,platform_id)` PK, `external_id`, `source_client_patch text`, `pick_rate numeric(7,4)`, `pick_rate_rank integer`, `sample_size bigint NULL`, `denominator text NULL` | **전 챔피언 합산** 범위 고정. 원본 통계 패치의 승인 매핑을 사용. 0~100 검증, 순위는 양수, 미제공 값은 null. `release_id` FK 및 공식 증강·패치 FK |
| `lol_mayhem_combos` | `(release_id,external_combo_id bigint)` PK, `champion_id integer`, `client_patch text`, `mode_name='KIWI'`, `editorial_tags text[]`, 검증한 `source_url text` | 목록 `(release_id,champion_id,external_combo_id)` 인덱스. `relation_kind=editorial_combo` 고정. 라이선스·원본 이름은 release/원문에서 추적 |
| `lol_mayhem_combo_augments` | `(release_id,external_combo_id,position smallint)` PK, `platform_id integer`, `client_patch text`, `mode_name='KIWI'` | 조합으로 FK, 공식 패치 상태로 복합 FK. 부모의 검수 패치와 일치하도록 복합 FK 구성. 조합 내 같은 증강 중복 금지. 외부 순서를 보존하되 구매·선택 순서라는 의미는 부여하지 않음 |
| `lol_mayhem_dataset_publications` | `(source,client_patch)` PK, `release_id bigint` FK, `previous_release_id bigint NULL` FK, `published_at timestamptz`, `published_by` | 공개 포인터만 변경. 해당 공개본의 모든 조합 검수 패치와 포인터 패치 일치 검증. 이전 공개본으로 원자적 복구 |
| `lol_data_sync_status` | `job_key text` PK, `last_checked_at`, `last_fetch_succeeded_at`, `last_data_changed_at`, `last_published_at`, `last_success_at`, `last_error_code`, `consecutive_failures`, 처리 건수·구간별 진척 `jsonb` | 제안한 공통 작업 상태. champion-stats/ranking/catalog/external 작업별 한 행. 원문 오류·비밀 값·계정 식별자 저장 금지 |

챔피언은 현재 DB에 새 전용 마스터를 만들지 않고 검수 시 패치가 고정된 Data Dragon 사전에 숫자 ID가 있는지 검증한다. 사용한 Data Dragon 버전·사전 해시는 manifest에 기록한다. 공식 증강 패치 상태는 FK와 공개 직전 검사로 확인한다.

새 release에 미매핑·모호한 조합이 있으면 **해당 공개 후보 전체를 대기**시킨다. `rejected` 처리에는 사유를 남긴다. 원본에는 모든 항목을 보존하되 일부 성공만 공개해 전체 데이터처럼 보이게 하지 않는다. 전역 선택률은 원본 파일의 패치를 유지하고, 조합의 검수 패치와 다를 경우 한 최신 통계로 합쳐 표시하지 않는다.

매핑 수정으로 기존 공개본이 달라지지 않도록 조합·선택률 행에 해석된 platform_id를 저장한다. 승인 후 release 내용은 불변이며, 매핑 변경은 `mapping_revision`, 정규화 규칙 변경은 `normalizer_version`을 올려 새 후보로 만든다. 사용한 매핑 전체와 revision은 manifest에 기록한다. 한 release는 한 조합 검수 패치에만 사용한다. 다음 게임 패치에서는 동일 원본이어도 새 검수 후보를 만들고 확인 후 새 공개 포인터를 둔다. 과거 통계일·패치가 새 검수 패치로 바뀌지는 않는다.

모든 신규 테이블은 기존 LoL 테이블과 동일하게 RLS를 켜고 `public/anon/authenticated` 권한을 회수한다. 서버 service role만 접근한다. 공개 API와 관리자 API는 기존 인증·요청 제한을 재사용한다. 공개/검수 RPC는 `security invoker`, 빈 `search_path`, 입력 제한, 고정 SQL을 적용하고 실행 권한도 service role로 제한한다. 공개 응답에 manifest의 내부 저장 경로·검수자·오류 원문은 포함하지 않는다.

## 6. 수집·검증·공개·복구

1. 공통 collection lease에서 `ops:lol-mayhem-external:arammayhem`를 획득한다. 만료 시각·소유 토큰을 검증하고 장기 작업은 갱신한다. 동시에 한 수집기만 쓴다.
2. index를 읽고 고정된 대상 파일을 받는다. 제공되는 ETag/Last-Modified로 조건부 요청하고, 없으면 원문 해시로 변경을 확인한다. 304는 확인 성공이지 신규 통계 생성이 아니다.
3. 모든 파일 releaseId와 index의 기대 releaseId를 맞춘다. 다운로드 후 index를 다시 확인해 수집 중 원본이 바뀌었으면 배치를 폐기하고 제한된 재시도로 넘긴다. 다른 시점 파일을 섞지 않는다.
4. 스키마, 중복 ID, 값 범위, 출처 라이선스, 통계일 역행, ID 매핑, 공식 패치 상태를 검증한다. 행 수가 직전 공개본보다 20% 이상 감소하거나 구조가 바뀌면 검수 보류한다. 사라진 증강을 즉시 삭제하지 않는다.
5. 불변 원본+manifest를 업로드한 뒤 DB에 후보를 트랜잭션으로 넣는다. 업로드 후 DB 실패는 참조 없는 원본만 남으며 공개본에는 영향이 없다. 동일 해시·정규화 버전·매핑 revision·검수 패치 재실행은 중복을 만들지 않는다.
6. 최초 자료·새 매핑·새 패치·편집 조합 변경은 관리자 검수 후 승인한다. 기존 공식 카탈로그의 승인 gate를 우회하거나 외부 수집 성공만으로 자동 승인하지 않는다. 검수 화면에는 원문 링크·변경 건수·미확인 관계·출처와 날짜를 표시한다.
7. 공개 RPC는 포인터 행을 잠그고 기대 이전 releaseId와 lease 소유를 확인한다. 승인 상태·공식 공개 패치·참조 무결성을 다시 확인한 뒤 포인터와 공개 시각만 원자적으로 교체한다. 승인과 공개 사이의 패치 변경도 차단한다.
8. 서버는 `(source,client_patch)` 공개 포인터만 읽는다. 오류가 나면 마지막 정상 공개본을 유지하고 보류 사유는 관리자에게 표시한다. 복구는 보존된 previous release로 같은 RPC의 검사 후 전환한다.

캐시는 공개 포인터 60초, 불변 조회 결과는 `(source,client_patch,release_id)`별 1시간을 제안한다. 후보·원본 확인 시각 변경은 화면 데이터를 교체하지 않는다. 외부 스크립트는 Next 캐시 태그를 직접 지울 수 없으므로 초기 버전은 TTL을 사용한다. 필요 시 기존 관리자 인증 revalidate 경로를 확장하되 새 무인증 훅은 만들지 않는다.

## 7. 통계 최신화 주기와 실행 위치

| 대상 | 현재 코드 | 권장 시작안 | 저장·표시 |
| --- | --- | --- | --- |
| 개인 전적 | 계정별 갱신 제한 120초, 오래된 저장 결과에 후속 자동 갱신 | 유지. 방문자 요청으로 전체 통계 수집을 시작하지 않음 | 기존 개인 전적 테이블. `전적 갱신 시각` |
| 챔피언 통계 | 장기 수집기와 DB 커서는 있음. 저장소에 정기 실행 workflow 없음 | GitHub Actions로 **3시간마다 최대 15분**, `--per-2min=20 --timeline-ratio=0.5 --max-minutes=15`부터. 작업 timeout 20분, 동시 실행 1개, 기존 DB lease·cursor 재사용 | 기존 `lol_stat_*`. 조회 캐시 5분 제안. 패치·필터별 표본 수와 `마지막 집계 시각` |
| 랭킹 | Actions `17 */3 * * *`, 코드상 3시간. 게시본 캐시 1시간 | 수집 간격 유지, 게시본 포인터 캐시는 5분으로 단축 제안 | 기존 공개본. `마지막 공개 시각`과 실패 상태 분리 |
| 티어 분포 | Actions `19 20 * * *`, KST 05:19 일 1회 | 유지 | 날짜별 기존 스냅샷 |
| 공식 증강 도감 | Actions `25 4 * * *`, KST 13:25 일 1회, 공개는 검수 별도 | 일 1회+패치 당일 수동 확인. 미확인 신패치는 이전 패치 표시 유지 | 기존 Storage+카탈로그. 게임 패치·검수 시각 |
| 해외 증바람 자료 | 없음 | Actions **6시간마다 변경 확인**, 변경된 파일만 후보 생성, 실행 상한 5분 | 제안한 Storage+DB. 파일별 원본 통계일 또는 조합 검수 패치·확인 시각 |

위 시간은 코드의 예약 설정과 제안이지 실제 운영 성공 기록이 아니다. 기존 enabled/apply 플래그를 확인하고 dry-run 검증 후 활성화해야 한다. GitHub 예약은 지연·누락될 수 있고 기본 브랜치에서 실행되므로, 화면에 정각 갱신을 보장하지 않는다([GitHub 공식 문서](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)).

15분×8회는 하루 120분, 30일에 **러너 약 3,600분+설치 시간**이다. 기본 호출 간격 기준 회당 최대 약 150회 수준이며 실제 신규 경기 수는 중복·timeline·혼잡에 따라 줄어든다. 이를 현재 문서의 상시 수집 처리량과 혼동하지 않는다. 운영 키 공유 예산·Actions 과금·표본 증가량을 3일 관측한 뒤 빈도를 결정한다. 이미 상시 실행 환경이 확인되면 동일 수집기를 프로세스 감독 아래 계속 실행하는 편이 낫지만, 현재 그런 서버가 있다고 가정하지 않는다.

429는 Retry-After와 기존 공유 제한을 준수하고, 401/403은 작업 중단·관리자 확인 상태로 전환한다. 해외 원본 403도 접근 차단 우회 없이 중단한다. 일시 오류는 제한된 재시도 후 마지막 정상본을 유지한다.

최신화 상태는 다음을 구별한다.

- `last_checked_at`: 작업 실행/원본 확인 시각. 새로운 표본이나 최신 패치를 뜻하지 않음.
- `last_data_changed_at`: 실제 신규 집계·새 파일 내용이 생긴 시각.
- `source_stats_date`: 원본이 밝힌 통계 기준일. 없으면 null, 추정이면 추정 표시.
- `last_published_at`: 검수 후 서비스에 공개한 시각.
- 구간별 커서·신규 경기 수·중복 수·timeline 표본 수: 수집이 진행되는지 판단하는 자료. 마지막 집계 시각 하나로 정상 작동을 단정하지 않음.

챔피언 통계는 필터별 최근 집계와 표본 수를 함께 표시하고, 새 게임 패치가 확인돼도 구패치 수치를 신패치로 바꾸지 않는다. 새 패치 행이 있으면 그 패치를 명시하고 20판 미만은 기존처럼 표본 부족으로 표시한다. 신패치 집계가 없으면 구패치 라벨을 유지한다. 2회 주기 이상 작업 성공이 없으면 관리자 경고, 통계 내용이 오래됐으면 이용자에게 기준 시각 안내를 제안한다. 전체 티어를 다 수집했다는 근거가 없으므로 백분율 진행률을 꾸며내지 않는다.

## 8. 용량·보존·삭제

외부 augment+combo 원문은 조사 시 합계 약 1.02MB다. 원문·index·manifest·정규화된 DB 행과 인덱스를 합쳐 **고유 버전당 약 2~4MB**를 초기 예산으로 잡되 실제 업로드 바이트와 `pg_total_relation_size`로 보정한다. 매일 내용이 바뀌면 90일에 약 180~360MB이고, 같은 해시 확인만 반복하면 새 버전이 쌓이지 않는다. 다른 게임 패치 재검수 시 DB 행은 늘어도 같은 batch 원본은 공유한다. 이 숫자는 계획값이며 요금·실측 저장량이 아니다.

- 현재 공개본, 직전 복구본, 보류 중 검수에서 참조하는 원본은 기간과 무관하게 보호한다.
- 실패한 참조 없는 업로드: 30일 후 정리 후보. 삭제 전에 manifest와 모든 release 참조를 재검사한다.
- 공개에서 내려간 과거 버전: 90일 후 정리 후보. 감사용 해시·라이선스·변경 건수·검수 기록은 최소 180일 유지하고 삭제된 원본 여부를 표시한다.
- 자동 삭제는 첫 버전에 넣지 않는다. dry-run 목록→현재 참조 재검증→운영 승인 경로의 순서로 별도 도입한다. Storage 객체는 Storage API로 삭제하며 메타데이터 SQL 삭제로 대신하지 않는다.
- 일반 챔피언 집계의 패치 정리는 별도 정책이다. 우선 최근 3패치를 온라인 유지하는 안을 검토하되, 누적 집계 원문이 없어 재생성이 어려우므로 내보내기·복원 시험 전 삭제하지 않는다. 중복 방지 경기 ID도 조회 기간 내 재수집될 수 있는 동안 삭제하지 않는다.
- 코드의 DB 8GiB/R2 10GiB 한도값은 운영 경고 기본값이다. 실제 요금제·현재 잔여 용량으로 해석하지 않는다. 활성화 전에 DB와 **Supabase Storage** 사용량·egress·백업 보존을 각각 확인한다.

## 9. 화면 개선 범위

- 성공한 검색 뒤 기록은 접어 첫 결과까지의 스크롤을 줄인다. 검색 전에는 펼치며 키보드로 열고 닫을 수 있다.
- 현재 계정 즐겨찾기는 프로필에 표시하고 눌림 상태를 제공한다. 목록에서 재검색·삭제·전체 비우기와 저장 실패 안내를 유지한다.
- 모바일 프로필에서 이름과 작업 버튼을 다른 행에 배치해 긴 Riot ID가 버튼과 경쟁하지 않게 한다.
- 경기 상세 이름·KDA·피해·와드·CS는 12~13px 이상으로 읽기 쉽게 하고, 이름 버튼과 상세 탭을 최소 44px로 늘린다. 좁은 화면은 보조 지표를 두 열로 배치한다. 넓은 표의 열 정렬은 유지한다.
- 승패·자기 계정 강조, 모바일 통계 탭, 인게임 접기/펼치기, 타임라인의 기존 요청 재사용을 보존한다.

## 10. 구현 순서와 수용 조건

1. 이 변경: 화면 구현+기존 fixture 브라우저 QA와 저장 설계 문서.
2. 수집 운영화: champion-stats bounded workflow·작업 상태·패치/표본별 최신화 표시. 운영 키 예산과 러너 사용량 확인 후 활성화.
3. 해외 자료: 위 신규 테이블 migration, 원본 수집 dry-run, ID 매핑 검수 도구. 최초 후보를 사람이 검수한 뒤 공개.
4. 공개 읽기: 챔피언별 **외부 추천 조합**과 **전체 선택률**을 출처·패치별로 구분. 챔피언별 실제 선택률·등장 가능 여부는 증거 확보까지 미제공.

후속 데이터 구현의 필수 검증:

- 동일 파일 재실행·동시 실행에서 중복 행과 이중 공개가 없음.
- 파일 releaseId 불일치, 같은 releaseId의 수정, 미매핑·다중 매핑·삭제된 공식 증강·날짜 역행을 구별함.
- 원본 업로드 직후/DB 저장 도중/포인터 전환 직전 실패해도 공개본이 유지됨.
- 검수 후 공식 패치가 바뀌면 공개가 차단됨. 복구 시 이전 공개본과 원본 참조가 보존됨.
- RLS·RPC 권한·공개 응답에 원문 경로·service role·검수자·PII가 노출되지 않음.
- 기존 증강 수집·공개·정리 경로가 `external/` 원본을 삭제하거나 공식 카탈로그로 오인하지 않음.
- fixture로 375×667, 390×844, 430×932, 1440×900에서 긴 이름, 빈 상태, 실패, 오래된 자료, 출처 링크를 검증함. 실기기 검증은 별도.

관련 명령: `npm run verify:core`, `npm run verify:lol`, UI는 `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-public-browser.test.ts tests/lol-dev-browser.test.ts tests/lol-live-browser.test.ts`. 후속 migration 구현 시 `npm run verify:migrations`와 권한·중복·복구 시나리오를 추가한다.

이번 화면 구현 검증: `verify:core` 오류 0·기존 경고 43개, 롤 단위 684개, 전체 단위 6,384개, 위 브라우저 fixture 84개 통과. 375×667·390×844·430×932·1440×900에서 접힘·키보드·즐겨찾기 복원·44px 터치 영역·글자 크기·넘침·참가자 이동과 기존 요청 재사용을 확인했다. 실제 Riot·운영 DB·실기기는 미검증이며 신규 데이터 테이블과 수집 예약은 적용하지 않았다.
