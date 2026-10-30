# LoL 랭킹·장인 탭 구현 준비 (2026-10-30)

범위: 구현 전 데이터·정책·저장 계약 정리. 이 문서 단계에서는 화면, migration, 수집기를 만들지 않았다. 표기는 **확정**(저장소·운영 DB에서 확인), **미확인**(구현 시작 시 확인)으로 나눈다.

## 1. 현재 있는 것

| 항목 | 상태 |
| --- | --- |
| 상위 티어 명단 호출 | 확정. `scripts/lol_ladder_snapshot.ts`가 챌린저·그랜드마스터·마스터 명단을 받는다. 단 LP 집계만 저장하고 명단은 버린다 |
| 공유 호출 제한 | 확정. `requestJson` + `reserve_lol_riot_request`를 수집기에서도 그대로 쓴다 |
| 숙련도 호출 | 확정. 검색 계정에만 `champion-masteries/by-puuid/{puuid}/top?count=10`을 호출한다 |
| 헤더 | 확정. 모바일은 메뉴가 둘째 줄이고 가로 스크롤이 가능해 7개까지 받을 수 있다 |
| 삭제 요청 | 확정. `delete_lol_account_data`가 PUUID 기준으로 지운다. 새 표는 아직 대상이 아니다 |
| 명단 응답의 `puuid` | 미확인. 집계는 LP·플래그만 읽는다. 구현 첫 단계에서 실제 응답을 확인한다 |

## 2. 탭 정의

### 랭킹 (`/lol/kr/ranking`)

- 솔로 랭크 챌린저·그랜드마스터 상위 1,000명을 순위, Riot ID, 티어, LP, 승패로 보여 준다. 자유 랭크는 2차로 둔다.
- 순위는 Riot 명단의 티어·LP 순서만 쓴다. MMR이나 자체 실력 점수를 만들지 않는다. 대체 실력 랭킹은 Riot 정책 금지 항목이다.
- 행을 누르면 기존 `/lol/kr/{이름-태그}` 전적으로 이동한다.

### 장인 (`/lol/kr/masters`)

- 챔피언을 고르면 **랭킹 대상 1,000명 안에서** 그 챔피언의 Riot 숙련도 점수 순으로 보여 준다.
- 값은 Riot 공식 숙련도만 쓴다. BGMS 장인 점수나 칭호를 계산하지 않는다.
- 화면에 "상위 티어 표본 기준이며 서버 전체 순위가 아닙니다"를 고정 표시한다. 전체 서버 숙련도 순위는 모든 계정을 조회해야 해서 공식 API로 만들 수 없다.

## 3. 호출량 (하루 1회)

| 단계 | 호출 수 | 개발 키(100회/2분) | 프로덕션 시작 한도(30,000회/10분) |
| --- | --- | --- | --- |
| 명단 2개 | 2 | 즉시 | 즉시 |
| PUUID → Riot ID | 최대 1,000 | 약 20분 | 1분 미만 |
| 숙련도 상위 5개 | 최대 1,000 | 약 20분 | 1분 미만 |

- 개발 키로도 40분 안팎이지만 그동안 공개 검색이 같은 한도를 나눠 쓴다. **프로덕션 키 승인 뒤 운영 수집을 켠다.** 그전에는 dry-run과 소량 표본만 실행한다.
- Riot ID가 이미 저장되어 있고 7일 안에 확인한 계정은 조회를 건너뛰어 다음 날부터 호출을 줄인다.

## 4. 저장 계약 (migration 초안)

- `lol_ranking_entries`: `queue`, `rank`, `puuid`, `tier`, `league_points`, `wins`, `losses`, `game_name`, `tag_line`, `identity_checked_at`, `observed_at`. 기본 키 `(queue, puuid)`, 순위 조회 인덱스 `(queue, rank)`.
- `lol_mastery_leaders`: `champion_id`, `puuid`, `champion_points`, `champion_level`, `observed_at`. 기본 키 `(champion_id, puuid)`, 조회 인덱스 `(champion_id, champion_points desc)`.
- `lol_ranking_exclusions`: `puuid_hmac`, `created_at`. 삭제를 요청한 계정이 다음 수집에서 다시 들어오지 않게 한다.
- 공통: RLS 사용, anon·authenticated 회수, service_role 전용 RPC, `search_path=''`.
- `save_lol_ranking_snapshot(p_entries, p_masteries, p_observed_at)`: 전체 응답이 유효할 때만 한 트랜잭션으로 교체한다. 일부만 성공하면 이전 게시본을 유지한다. 시점별 이력은 남기지 않는다.
- `delete_lol_account_data`에 두 표 삭제와 제외 목록 추가를 넣는다.
- `scripts/verify_migrations_local.sh` 배열과 시나리오 SQL을 함께 갱신한다.

## 5. 수집기

- `scripts/lol_ranking_snapshot.ts`: 기존 랭크 컷 스크립트와 같은 `--dry-run`/`--apply`, 쓰기 플래그 `LOL_RANKING_ENABLED`.
- `.github/workflows/lol-ranking.yml`: 하루 1회, GitHub Secret `RIOT_API_KEY` 사용. 플래그가 없으면 dry-run으로 경고만 남긴다.
- 순수 로직 `lib/lol/ranking.ts`: 명단 정렬·상위 1,000명 자르기, 숙련도 변환, 입력 검증.

## 6. 개인정보·정책 (구현 전 필수)

- 지금까지는 **검색한 계정**만 식별 정보를 저장했고, 상위 티어 명단은 일부러 버렸다. 이 기능은 **검색하지 않은 계정의 Riot ID·PUUID를 매일 저장**하므로 처리 방침이 바뀐다.
  - `/privacy`의 처리 항목·보관 기간(랭킹 이탈 시 다음 수집에서 삭제)을 갱신하고 시행일을 공지한다.
  - 삭제 요청 처리에서 제외 목록까지 확인한다.
- Riot 신청 설명에 없는 기능이다. 신청서·제품 설명에 랭킹과 장인을 추가한 뒤 공개한다.
- 표시 금지: Riot ID 변경 이력, 시점별 순위 이력에서 파생한 추적 기능, 자체 실력 점수.
- 일반 공개 프로필과 달리 순위표는 계정을 나열하므로, Riot 정책 원문을 공개 직전에 다시 확인한다.

## 7. 구현 순서

1. 실제 명단 응답 필드 확인, `lib/lol/ranking.ts`와 단위 테스트.
2. migration, RPC, 삭제 경로, 시나리오 SQL.
3. 수집기와 워크플로(dry-run 기본).
4. 개인정보처리방침 갱신과 Riot 신청 설명 갱신.
5. `/lol/kr/ranking`, `/lol/kr/masters` 화면과 메뉴. 빈·오류 상태, 375·390·430·데스크톱 fixture.
6. 프로덕션 키 승인 뒤 운영 migration, 수집 활성화.

## 8. 사용자 결정

| 항목 | 권장 |
| --- | --- |
| 대상 범위 | 솔로 랭크 챌린저·그랜드마스터 1,000명 |
| 장인 기준 | 대상 안의 Riot 숙련도 점수 |
| 운영 시점 | 프로덕션 키 승인 뒤 |
| 미검색 계정 저장 | 방침 갱신 후 허용 |
