# LoL 랭킹·장인 탭 구현 준비 (2026-10-30)

범위: 구현 전 데이터·정책·저장 계약 정리. 화면, migration, 수집기는 만들지 않았다. Claude 초안을 GPT Sol이 독립 검토했고, 코드 근거와 Riot 정책 문구는 메인이 다시 확인했다.

표기: **확정**(코드·운영 DB·공식 문서 확인), **추정**(간접 근거), **미확인**(구현 시작 시 확인).

## 1. 결론

1. **랭킹을 먼저 만든다.** Riot 승인 사용 사례에 "Official Ladder Leaderboards."가 있어, 공식 명단 순서를 그대로 보여 주는 화면은 허용 범주로 판단한다(2절 주의 참고).
2. **장인은 2단계다.** 숙련도 순위를 다루는 공식 문구가 없고, "실력 순위"로 읽히면 금지 조항과 부딪힐 수 있다.
3. **게시본에 PUUID를 저장하지 않는다.** 키 교체 영향과 개인정보 범위를 함께 줄인다.
4. **메뉴를 늘리지 않고 합친다.** "랭크 컷"을 "랭킹"으로 바꿔 순위표와 컷을 한 화면에 둔다. 장인만 메뉴를 하나 더한다.
5. **운영 수집은 프로덕션 키 승인 뒤에 켠다.** 개발 키는 24시간마다 만료되어 일일 수집을 맡길 수 없다.

## 2. 정책 근거

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| 공식 순위표 표시 | 허용 범주(추정, 강함) | [LoL 문서](https://developer.riotgames.com/docs/lol) 승인 사용 사례: "Official Ladder Leaderboards." |
| 자체 실력 순위 | 금지(확정) | [일반 정책](https://developer.riotgames.com/policies/general): "Products cannot create alternatives for official skill ranking systems such as the ranked ladder.", "Prohibited alternatives include MMR or ELO calculators." |
| 숨겨진 플레이어 | 금지(확정) | "Products cannot identify or analyze players who are deliberately hidden by the game.", "Products cannot de-anonymize players who cannot reasonably be identified from visible information." |
| 숙련도 순위 | 미확인 | LoL 문서에 언급 없음. 금지도 허용도 확인되지 않았다 |
| 순위 데이터 보관·캐시 기간 | 미확인 | 위 두 문서에서 찾지 못했다 |

주의: 문서 HTML은 "Examples of Approved Use Cases for Personal Keys" 제목 아래 한 목록이고, 중간에 "Examples of Approved Use Cases for Production Keys."가 목록 항목처럼 들어 있다. 순위표 항목은 그 줄 뒤에 있어 프로덕션 사례로 읽었지만, 표기 오류로 보이는 구조라 단정하지 않는다. 신청서에는 이 문구를 그대로 쓰고 Riot이 프로덕션 범위로 확인했다고 적지 않는다.

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

- 챔피언마다 최대 10명을 보여 주고 KR만 다룬다.
- 보드 이름은 "챔피언 숙련도 상위"로 쓴다. 정의 문구, 표본 범위, 갱신 시각, 제외·삭제 안내를 같은 화면에 고정한다.

기각한 대안:
- 최근 경기 집중도: 인당 21회 호출이고, 경기 원문에 다른 참가자 정보가 남는다.
- 판수 기준: 큐 전체 판수는 챔피언별이 아니고, 챔피언별 판수는 위와 같은 경기 상세 수집이 필요하다.

공개 사이트 조사(2026-10-30, 3곳 시도): 두 곳은 자동 접근이 차단되어 확인하지 못했다. 나머지 한 곳은 숙련도 포인트 누적 기준의 챔피언별 상위 3명 보드였고, 지역이 섞여 있었으며 정의와 갱신 주기 문구가 없었다. 근거가 한 곳뿐이라 일반적인 관행으로 보지 않는다. 그 사이트가 Riot의 정책 판단을 받았다는 근거도 없다. 상세는 Git 제외 자료에 있다.

## 4. 데이터와 호출량

| 항목 | 상태 |
| --- | --- |
| 현재 명단 호출 | 확정. 랭크 컷이 3티어×2큐, 6회 호출하고 명단은 버린다 |
| 명단 응답 키 | **확정(2026-10-30 실측, 유효한 키)**. 최상위에 `queue`, `tier`, `entries`. entries 키는 `freshBlood, hotStreak, inactive, leaguePoints, losses, puuid, rank, veteran, wins`. `summonerId`와 `summonerName`은 없다 |
| 챌린저·그랜드마스터·마스터 인원 | **실측(2026-10-30)**: 챌린저 300명, 그랜드마스터 700명, 마스터 10000명. 마스터 값은 상한과 같아 잘렸을 수 있다(미확인). 게시 대상은 챌린저·그랜드마스터 1000명이다 |
| 비활성 계정 | **실측**: 챌린저 `inactive` 0명. 같은 LP가 70건 있어 동순위 정렬이 필요하다 |
| 숙련도 응답 | **실측**: `top?count=10`은 항목 10개. 키는 `championId, championLevel, championPoints, championPointsSinceLastLevel, championPointsUntilNextLevel, championSeasonMilestone, lastPlayTime, markRequiredForNextLevel, milestoneGrades, nextSeasonMilestone, puuid, tokensEarned`. 판수 필드는 없다. 항목의 `puuid`는 게시본에 넘기지 않는다 |
| Account-V1 by-puuid(asia) | **실측**: `gameName, puuid, tagLine` |
| 개발 키 한도 | **실측**: 100회/2분(`100:120`), 20회/1초(`20:1`). 개발 키는 24시간마다 만료된다 |

**비활성 계정 처리 규칙**: 공식 명단에 있는 계정은 `inactive`와 무관하게 순서를 바꾸지 않는다. 표시도 하지 않는다. 명단이 공식 순서의 근거이므로 BGMS가 임의로 빼지 않는다.

하루 호출 추정(대상 1,000명): 명단 2회(챌린저·그랜드마스터) + Riot ID 최대 1,000회 + 숙련도 최대 1,000회. 프로덕션 시작 한도(10초 500회, 10분 30,000회)에서는 1분 안팎이고, 개발 키(2분 100회)로는 약 40분이다.

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

1. 프로덕션 또는 유효한 개발 키로 명단·숙련도 응답 필드와 KR 인원을 실측한다. (2026-10-30 완료, 4절)
2. `lol-ladder.yml`에 background 우선순위를 넣는다(독립 수정).
3. `lib/lol/ranking.ts`와 단위 테스트. (완료)
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
| 장인 공개 조건 | **2026-10-30**: 먼저 구현한다. 공개 시점은 구현 뒤 다시 정한다 |
| 인게임 듀오 예측 | **확정(2026-10-30)**: 프로덕션 키 승인 뒤로 보류 |
| 미검색 계정 Riot ID 저장 | **확정(2026-10-30)**: 허용. 처리방침 갱신과 공지가 먼저다 |
| 운영 시점 | 프로덕션 키 승인 뒤 |


## 11. 구현 상태와 문서 초안 (2026-10-30)

구현 범위와 검증은 [운영 절차](../operations/2026-10-30-lol-ranking-masters.md)에 적었다. 아래는 공개 전 문구 초안이다. 실제 `/privacy`와 신청서 파일은 이번 작업에서 고치지 않았다.

### 11-1. 개인정보처리방침 초안 (공개 전 반영)

처리 항목 표에 추가할 행:

| 항목 | 보유 기간 |
| --- | --- |
| LoL 랭킹·장인 게시 명단(Riot ID, 티어, LP, 승패, 챔피언별 숙련도 포인트와 레벨) | 명단에서 빠진 뒤 다음 수집 때 삭제(최대 1일). 게시본은 하루 한 번 교체하며 이력을 남기지 않음 |
| LoL 삭제 요청 제외 목록(Riot ID의 HMAC 값) | 삭제 요청 처리 중 계속 보관(재수집 차단용). 원문 Riot ID는 저장하지 않음 |

처리 목적과 절차에 추가할 문장(2-6절 아래):

> LoL 랭킹과 장인 화면은 Riot 공식 챌린저·그랜드마스터 명단에 있는 소환사의 Riot ID, 티어, LP, 승패와 챔피언별 숙련도 포인트를 보여 줍니다. 검색하지 않은 소환사도 명단에 있으면 표시될 수 있습니다. Riot ID 삭제를 요청하면 다음 게시부터 제외하고, 제외 목록에 Riot ID의 HMAC 값을 보관해 다시 수집하지 않습니다. Riot ID를 변경한 경우 새 Riot ID로 다시 요청해 주세요.

### 11-2. 신청서 제품 설명 초안 (Riot 프로덕션 신청, 수정 전 원문은 그대로 둠)

추가할 문장:

> We also display an official ladder leaderboard for Challenger and Grandmaster solo queue players (Riot ID, tier, LP, and win/loss from League-V4), ordered as Riot returns the ladder. For those players we also show their Champion Mastery points per champion (top 10 champions per player). We do not compute any score, rating, or replacement for official ranks, and we do not show a player's history over time. Players can request removal of their Riot ID, which removes them from these boards and prevents re-collection.

확인할 것: 이 문장을 쓰면 신청서의 "without player identifiers" 문구와 맞지 않는 부분이 생긴다. 공개 전 Riot 신청 문구를 다시 맞추고, 프로덕션 범위 확인 여부는 적지 않는다.

### 11-3. 구현에서 설계와 달라진 점

- 게시 조건 실패 시 `--apply`는 exit 1로 끝난다. 이전 게시본은 그대로 남는다(설계는 "유지"만 적었고 실패 신호는 없었음).
- 제외 목록 대조는 Riot ID HMAC으로 한다. 설계 초안의 `puuid_hmac`은 키 교체 때 깨지므로 쓰지 않는다.
- 삭제 요청 경로는 `delete_lol_account_data`를 고치지 않고 `add_lol_ranking_exclusion`과 CLI로 처리한다. 게시본에 PUUID가 없어 PUUID 기준 삭제가 필요하지 않다.
- 장인 화면 금지 표현 검사는 `점수`, `실력`, `1등`을 본문 전체에서 찾는 테스트로 고정했다.
