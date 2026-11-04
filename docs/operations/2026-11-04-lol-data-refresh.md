# LoL 통계 최신화·증바람 데이터셋 운영

## 범위

2026-11-04 설계(`docs/plans/2026-11-04-lol-design-and-data-refresh.md`)의 저장·수집·검수 경로를 구현했다. AI 분석과 자동 삭제는 포함하지 않는다. 이 문서의 적용 결과는 마지막 절에 기록한다.

## 실행과 저장

| 대상 | 실행 위치·주기 | 저장 |
| --- | --- | --- |
| 챔피언 통계 | `lol-champion-stats.yml`, UTC `31 */3 * * *`, 최대 15분·2분당 20회, timeline 비율 0.5 | 기존 `lol_stat_*`, 커서·경기 ID 중복 방지 유지 |
| 증바람 해외 자료 | `lol-mayhem-dataset.yml`, UTC `43 */6 * * *`, 5분 작업 상한 | 기존 private Storage + 신규 `lol_mayhem_*` |
| 수집 건강 상태 | 각 작업이 기록 | `lol_data_sync_status`, 마지막 확인·성공·실제 변경·오류·건수 분리 |
| 랭킹 조회 | 기존 수집 3시간 유지 | 기존 게시본, 서버 조회 캐시 300초 |

GitHub repository variables `LOL_CHAMPION_STATS_ENABLED=true`, `LOL_MAYHEM_DATASET_ENABLED=true`가 각각 예약 실행을 활성화한다. 미설정 예약 작업은 Riot API나 외부 원본을 호출하지 않는다. 수동 실행은 `dry_run=true`가 기본이다. 챔피언 apply에는 기존 `LOL_COLLECT_ENABLED`, 해외 apply에는 `LOL_MAYHEM_DATASET_ENABLED`와 `LOL_PERSISTENCE_ENABLED`가 필요하다. 서버 관리자 화면의 수동 수집에도 후자의 설정이 적용된다.

서버 비밀 값은 기존 `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RIOT_API_KEY`를 사용한다. 키 값은 문서·로그·클라이언트에 넣지 않는다. GitHub 수집과 Vercel 웹 전적의 Riot 키를 교체할 때는 각 환경을 갱신하고 웹 배포도 갱신한다. 포털 키가 개발용이면 만료 후 다시 갱신해야 하며 예약 실행 자체가 유효 기간을 연장하지 않는다.

## 원본과 버전

```text
lol-augment-snapshots (private)
  external/arammayhem/objects/<raw_sha256>.json
  external/arammayhem/batches/<batch_sha256>/captures/<capture_sha256>/manifest.json
  external/arammayhem/batches/<batch_sha256>/captures/<capture_sha256>/normalized/<client_patch>/v1-m<mapping_revision>.json
```

- raw 객체는 index·전체 선택률·편집 조합·해당 패치 Data Dragon 챔피언 사전이다. 기존 공식 카탈로그의 파일 경로와 별도 접두사를 쓴다.
- `batch_sha256`는 augments·combos 내용의 식별자다. `capture_sha256`는 index·원본 응답 헤더·챔피언 사전을 포함한 원본 manifest의 해시다. 데이터 본문이 같아도 근거가 바뀌면 보관 버전을 구분하며 이전 파일을 덮어쓰지 않는다.
- 매핑은 `external_id,client_patch` 순으로 안정적으로 정렬한다. 변경 시 mapping revision을 늘리며 정규화 manifest와 RPC가 동일한 매핑 snapshot을 쓴다. DB는 snapshot이 현재 검수된 행과 일치하는지 검증한 뒤 그 snapshot만 정규화에 사용한다.
- 업로드는 `upsert:false`이고 중복 객체를 재사용한다. 외부 JSON은 파일당 4MiB·합계 12MiB·요청 30초 제한, 고정 HTTPS 경로·releaseId 교차 검사·형식 검증을 거친다. Storage와 DB 요청은 10초 제한이고 쓰기 lease는 각 업로드·최종 RPC 직전에 DB 시계로 갱신한다.
- 초기 버전은 약 1MB의 공개 원본을 다시 내려받아 내용 해시로 중복을 판별한다. ETag와 Last-Modified는 원본 근거로 보관하지만 조건부 다운로드 캐시는 구현하지 않았다. 원본 전송량이 커질 때 도입한다.

## 데이터 의미와 공개

출처는 [arammayhem.com 공개 데이터](https://arammayhem.com/data/)다. 전체 증강 선택률과 편집된 챔피언별 조합을 가져오며, 챔피언별 실제 선택률·등장 풀·증강 승률을 만들지 않는다. 조합 원문에는 패치·통계일이 없으므로 선택률 파일의 통계일을 조합 통계일로 복사하지 않는다. `sourceStatsDate`가 추정이면 이용 화면에도 표시한다.

DB 테이블은 releases, augment mappings, global pick rates, combos, combo members, publications와 공통 sync status의 7개다. 모두 RLS가 켜져 있고 service role만 접근한다. 원본 파일은 서버의 관리자 다운로드 API로만 제공한다. 공개 화면은 현재 공식 패치와 일치하는 승인본만 읽는다.

관리 경로: `/admin/lol/mayhem-datasets`.

1. **원본 확인·매핑 반영**으로 후보를 생성한다. 수집 성공은 공개 승인이 아니다.
2. 저장된 선택률·조합 원본을 내려받아 확인한다. 외부 증강 ID와 공식 이름·설명·등급을 대조하고 근거를 남긴다.
3. **조합 검수용 패치**와 **전체 선택률 원본 패치**가 다르면 각각 매핑한다. 한국어 표시 이름으로 자동 연결하지 않는다.
4. 매핑 반영을 다시 실행해 새 revision의 후보를 생성한다. 미매핑 항목이 하나라도 남으면 승인·공개할 수 없다.
5. 원본·전체 조합·매핑·패치를 확인한 뒤 **검수 승인**, 이어서 **승인본 공개**를 누른다. 현재 공식 패치·활성 증강 상태와 공개본 CAS를 DB가 다시 검사한다.
6. 제외할 후보는 10자 이상 사유를 남긴다. 매핑·승인·제외·공개·복구는 `admin_audit_events`에 해당 데이터 변경과 같은 트랜잭션으로 기록한다.

공개 화면 `/lol/kr/aram-mayhem`에는 공개본이 있을 때만 챔피언별 외부 조합과 전체 선택률 진입점이 표시된다. 출처·가공 여부·검수 패치·원본 통계일을 구별한다. 공개 포인터 캐시는 60초, 버전별 payload는 1시간이며 공개·복구 시 포인터 태그를 무효화한다.

## 실패·복구·보관

- Riot 401/403은 즉시 중단하고 키 갱신을 요구한다. 429/혼잡은 공유 호출 제한과 Retry-After를 지키되 남은 실행 시간보다 긴 대기는 시작하지 않는다. 긴 대기는 1초 단위로 중단 신호를 확인한다.
- 원본 403·release 불일치·미등록 패치·모호한 ID·Storage/DB 오류는 기존 공개본을 바꾸지 않는다. 실패 상태 저장이 실패하면 원문 대신 고정 오류 코드를 로그에 남긴다.
- 승인·제외한 release와 정규화 행은 불변이다. 복구는 현재 공개본의 직전 승인본으로만 가능하며 같은 CAS·공식 패치·증강 상태 검사를 거친다.
- 업로드 후 DB 저장이 실패하면 참조 없는 불변 원본이 남을 수 있다. 자동 삭제는 넣지 않았고 현재/직전 공개본·검수 참조는 보호한다. 정리는 별도 dry-run·참조 재검증·승인 경로로 도입한다.
- 일반 챔피언 통계의 원문 비저장·중복 방지·시드 티어 계약은 기존 운영 문서를 따른다. 페이지 마지막 집계 시각과 작업 마지막 성공 시각은 다른 값이다.

## 검증과 적용 기록

- 로컬 UI: 실제 Next 서버 375×667·390×844·430×932·1440×900에서 검색·챔피언·증바람 12페이지, 가로 넘침과 page error 없음. 공유 node_modules 링크의 Turbopack 제한 때문에 로컬은 `npm run dev -- --webpack --hostname 127.0.0.1 --port 3000`을 사용했다.
- 배포 빌드: 로컬 Node 26의 기본 2GiB 타입 검사 heap 한도로 실패한 뒤 `NODE_OPTIONS=--max-old-space-size=8192 npm run build -- --webpack`으로 완료했다. Vercel 프로젝트 런타임은 24.x다.
- 새 API·parser·수집기 및 브라우저, 전체 단위, 격리 migration 검증을 수행한다. 독립 리뷰의 패치 매핑·snapshot 경합·불변 원본·lease·대기 예산·감사 이력 지적에 회귀 시나리오를 추가했다.
- 운영 DB 사전 확인: DB 약 2.54GB, 기존 원본 버킷 비공개·JSON·64MiB 제한, 9객체·84,663,367바이트. 신규 데이터셋 테이블은 없었으며 기존 데이터 삭제는 계획하지 않았다.
- 실제 키 값은 출력하지 않고 Aside 개발자 포털에서 확인해 GitHub·로컬·Vercel production 설정을 갱신했다. Riot 상태 API 200을 확인했다.
- 운영 migration `20261103192202_lol_mayhem_datasets`와 `20261103193039_lol_mayhem_combo_group_capacity`를 적용했다. 실제 원본의 15개 증강 편집 묶음을 보존하도록 후속 migration에서 상한을 64로 조정했고, 적용된 원본 migration은 수정하지 않았다.
- 최초 원본 207행·조합 666개를 private Storage에 보관했다. 이후 upstream 내용이 바뀌어 두 번째 후보를 생성했고 같은 두 번째 원본을 다시 수집했을 때 release ID 2·전체 객체 20개가 유지됨을 확인했다. 미매핑 외부 ID는 249개이며 공개본은 없다. 수집 성공을 승인으로 바꾸지 않았다.
- 챔피언 통계를 1분·최대 5경기 제한으로 실제 실행해 API 8회·신규 5경기·timeline 1경기를 확인했다. 처리 경기 수 6,798→6,803, 마지막 집계와 작업 성공 시각이 갱신됐다.
- 최종 단위 6,419개, 관리자 433개, Jest 2개, 전적·증바람 브라우저 fixture 92개와 격리 migration 시나리오가 통과했다. 로컬 타입·린트는 오류 0·기존 경고 43개다. 실기기는 별도 검증 대상이다.
- 병합·원격 CI·배포 이력은 [PR #426](https://github.com/ka6865/BGMS/pull/426)과 연결된 실행에서 확인한다.
