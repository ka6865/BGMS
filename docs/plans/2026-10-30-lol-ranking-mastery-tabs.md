# LoL 랭킹·장인 탭 구현 준비 (2026-10-30)

범위: 구현 전 데이터·정책·저장 계약 정리. 화면, migration, 수집기는 만들지 않았다. Claude 초안을 GPT Sol이 독립 검토했고, 코드 근거와 Riot 정책 문구는 메인이 다시 확인했다.

표기: **확정**(코드·운영 DB·공식 문서 확인), **추정**(간접 근거), **미확인**(구현 시작 시 확인).

## 1. 결론

1. **랭킹을 먼저 만든다.** Riot이 프로덕션 키 승인 사용 사례로 "Official Ladder Leaderboards."를 적고 있어, 공식 명단 순서를 그대로 보여 주는 화면은 허용 범주다.
2. **장인은 2단계다.** 숙련도 순위를 다루는 공식 문구가 없고, "실력 순위"로 읽히면 금지 조항과 부딪힐 수 있다.
3. **게시본에 PUUID를 저장하지 않는다.** 키 교체 영향과 개인정보 범위를 함께 줄인다.
4. **메뉴를 늘리지 않고 합친다.** "랭크 컷"을 "랭킹"으로 바꿔 순위표와 컷을 한 화면에 둔다. 장인만 메뉴를 하나 더한다.
5. **운영 수집은 프로덕션 키 승인 뒤에 켠다.** 개발 키는 24시간마다 만료되어 일일 수집을 맡길 수 없다.

## 2. 정책 근거

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| 공식 순위표 표시 | 허용 범주(확정) | [LoL 문서](https://developer.riotgames.com/docs/lol) 승인 사용 사례: "Official Ladder Leaderboards." |
| 자체 실력 순위 | 금지(확정) | [일반 정책](https://developer.riotgames.com/policies/general): "Products cannot create alternatives for official skill ranking systems such as the ranked ladder.", "Prohibited alternatives include MMR or ELO calculators." |
| 숨겨진 플레이어 | 금지(확정) | "Products cannot identify or analyze players who are deliberately hidden by the game.", "Products cannot de-anonymize players who cannot reasonably be identified from visible information." |
| 숙련도 순위 | 미확인 | LoL 문서에 언급 없음. 금지도 허용도 확인되지 않았다 |
| 순위 데이터 보관·캐시 기간 | 미확인 | 위 두 문서에서 찾지 못했다 |

금지 기준에 맞춰 다음을 만들지 않는다: 자체 점수로 매긴 순위, 공식 순서를 바꾸는 보정, 순위 시점별 추적, Riot ID 변경 이력.

신청서 수정이 필요하다(확정). `2026-10-30-lol-production-key-application.md`의 제품 설명은 집계 통계를 "without player identifiers"라고 적고 순위표를 설명하지 않는다. 공개 전 설명에 "official ladder leaderboard"를 추가하고, 장인을 내면 그 내용도 넣는다. "We do not compute MMR or any replacement for official ranks" 문구는 공식 순서만 쓰면 유지할 수 있다(추정).

## 3. 탭 정의

### 랭킹 (`/lol/kr/ladder`, 메뉴 이름 변경)

- 첫 화면은 솔로 랭크 순위표, 그 아래 기존 컷 그래프를 둔다. 자유 랭크는 2차.
- 대상은 챌린저·그랜드마스터. 마스터는 인원이 많아 2차로 둔다(실제 인원 미확인).
- 표시: 순위, Riot ID, 티어, LP, 승패. 행을 누르면 기존 전적으로 이동한다.
- 순서는 Riot 명단의 티어·LP를 그대로 따른다. 같은 LP는 Riot ID로 정렬해 게시마다 흔들리지 않게 한다.
- 375px은 표 대신 카드 목록으로 Riot ID 잘림을 막고 터치 영역 44px을 지킨다.

### 장인 (`/lol/kr/masters`, 2단계)

- 챔피언을 고르면 랭킹 대상 가운데 그 챔피언의 Riot 숙련도 포인트 순으로 보여 준다.
- 숙련도는 계정별 상위 N개만 받으므로, 상위 10개 안에 든 사람만 비교된다. 화면에 "챌린저·그랜드마스터 N명 중, 숙련도 상위 10개 챔피언 기준이며 서버 전체 순위가 아닙니다"를 고정 표시한다.
- "점수", "실력", "1등 장인" 같은 표현을 쓰지 않는다.
- 표본이 적은 챔피언은 "표본 부족"으로 둔다.
- 정책 문제가 생기면 숙련도 대신 현재 시즌 판수 기준으로 바꾸거나 탭을 내린다.

기각한 대안: 최근 경기 집중도. 인당 21회 호출이고, 경기 원문에 다른 참가자 정보가 남는다.

## 4. 데이터와 호출량

| 항목 | 상태 |
| --- | --- |
| 현재 명단 호출 | 확정. 랭크 컷이 3티어×2큐, 6회 호출하고 명단은 버린다 |
| 명단의 `puuid`·`wins`·`losses` | 미확인. 2차 미러에만 근거가 있고 공식 문서 본문을 읽지 못했다. 로컬 키가 401이라 실측도 못 했다 |
| 숙련도 응답 | 코드 파서 기준 판수 필드 없음. 공식 DTO 미확인 |
| KR 티어별 인원 | 미확인 |

하루 호출 추정(대상 1,000명 가정): 명단 3회 + Riot ID 최대 1,000회 + 숙련도 최대 1,000회. 프로덕션 시작 한도(10초 500회, 10분 30,000회)에서는 1분 안팎이고, 개발 키(2분 100회)로는 약 40분이다.

호출 예산(확정): `reserve_lol_riot_request`는 interactive에 창의 90%, background에 50%를 허용한다. 수집기는 `LOL_RIOT_PRIORITY=background`로 돌려 검색 몫을 남긴다.
**현재 `lol-ladder.yml`에는 이 값이 없어 interactive로 돈다(확정).** 챔피언 통계 수집기만 background를 쓴다. 새 수집기를 만들 때 함께 고친다.

## 5. 저장 계약 (migration 초안)

조회 경로의 DB 호출을 시간당 수준으로 묶고, PUUID를 게시본에 남기지 않는다.

- `lol_ranking_publication`: `queue` 기본 키, `payload jsonb`(순위 행 배열), `observed_at`, `player_count`. 순위 행은 순위, Riot ID, 티어, LP, 승패만 가진다.
- `lol_mastery_publication`(2단계): `champion_id` 기본 키, `payload jsonb`(Riot ID, 포인트, 레벨), `observed_at`.
- `lol_ranking_exclusions`: `riot_id_hmac` 기본 키, `created_at`. 삭제 요청 계정을 다음 수집에서 뺀다.
- 공통: RLS 사용, anon·authenticated 회수, service_role 전용 RPC, `search_path=''`, 크기 상한.
- `save_lol_ranking_publication`: `save_lol_ladder_daily`처럼 입력 전체를 검증하고 한 트랜잭션으로 교체한다. 시점별 이력을 남기지 않아 명단에서 빠진 계정은 다음 게시에서 사라진다.

재수집 차단 키를 PUUID로 두면 키 교체 때 깨질 수 있다(`2026-10-30-lol-production-key-switch.md`). Riot ID 정규화 값의 HMAC을 쓴다. 이름을 바꾸면 차단이 풀리는 잔여 위험이 있으므로, 수집 직후 게시 전에 차단 목록을 대조하고 처리방침에 삭제 요청 재접수 안내를 적는다.

## 6. 수집기

- `scripts/lol_ranking_snapshot.ts`: `--dry-run`/`--apply`, 쓰기 플래그 `LOL_RANKING_ENABLED`, 우선순위 background.
- `.github/workflows/lol-ranking.yml`: 하루 1회. 플래그가 없으면 dry-run으로 경고만 남긴다.
- 순수 로직 `lib/lol/ranking.ts`: 입력 검증, 정렬, 표시 행 변환. 경기 원문은 수집하지 않는다.
- 혼잡 대응: 공유 예약 대기는 4초를 넘으면 `congested`로 끝난다(확정). 재시도와 진행 상태가 필요하다.
- 게시 조건: 대상 명단 전부 유효, Riot ID 해석률 95% 이상. 못 미치면 이전 게시본을 유지하고 화면에 기준 시각을 표시한다. 수치는 표본 확인 뒤 조정한다.
- PUUID는 수집 중 메모리에서만 쓰고 로그에 남기지 않는다.

## 7. 조회와 캐시

- 페이지는 `unstable_cache`(1시간)로 게시본을 읽는다. 증강 카탈로그와 같은 패턴이다. 수집기는 Next 밖에서 돌아 태그를 비울 수 없으므로 시간 기준으로 갱신한다.
- 게시본은 UTF-8 2MB 미만으로 제한한다. 넘으면 티어별로 나눈다.
- 빈 상태 "아직 집계되지 않았습니다", 오류 상태는 재시도 안내, 수집 실패 시 마지막 게시본과 기준 시각(KST)을 표시한다.

## 8. 개인정보

지금까지는 검색한 계정만 식별 정보를 저장했고 명단은 일부러 버렸다. 이 기능은 **검색하지 않은 계정의 Riot ID를 저장**하므로 처리 범위가 넓어진다.

- `/privacy`에 항목을 추가한다: 처리 항목(Riot ID, 티어, LP, 승패), 목적, 보관(순위 이탈 시 다음 수집에서 삭제).
- 시행일 공지는 코드 배포보다 먼저 한다.
- 삭제 요청: 게시본에서 즉시 제거하고 제외 목록에 넣는다. `delete_lol_account_data`는 PUUID만 받으므로 Riot ID 기준 경로를 추가한다.
- 숙련도는 프로필에 공개된 값이지만 계정과 묶어 나열되므로 같은 항목에 포함한다.

## 9. 구현 순서

1. 프로덕션 또는 유효한 개발 키로 명단·숙련도 응답 필드와 KR 인원을 실측한다.
2. `lol-ladder.yml`에 background 우선순위를 넣는다(독립 수정).
3. `lib/lol/ranking.ts`와 단위 테스트.
4. migration, RPC, 삭제 경로, 시나리오 SQL. `verify_migrations_local.sh` 배열 갱신.
5. 수집기와 워크플로(dry-run 기본).
6. 신청서·제품 설명, 개인정보처리방침 갱신과 시행일 공지.
7. 랭킹 화면과 메뉴 이름 변경. 375·390·430·데스크톱 fixture.
8. 프로덕션 키 승인 뒤 운영 migration, 수집 활성화.
9. 장인 탭(2단계).

## 10. 사용자 결정

| 항목 | 권장 |
| --- | --- |
| 출시 순서 | 랭킹 먼저, 장인은 2단계 |
| 메뉴 | **확정(2026-10-30)**: "랭크 컷"을 "랭킹"으로 합침 |
| 대상 | 솔로 챌린저·그랜드마스터 |
| 장인 기준 | 대상 안의 Riot 숙련도 포인트, 범위 고정 표시 |
| 장인 공개 조건 | Riot 문의 뒤. 문의를 계속 보류하면 랭킹만 공개 |
| 미검색 계정 Riot ID 저장 | **확정(2026-10-30)**: 허용. 처리방침 갱신과 공지가 먼저다 |
| 운영 시점 | 프로덕션 키 승인 뒤 |
