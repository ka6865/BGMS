# LoL 진행 중 경기 조회 (2026-10-30)

검색한 Riot ID의 진행 중 경기를 Spectator-V5로 조회해 참가자 정보와 공개 랭크·챔피언 통계를 보여 준다.
기본은 비공개이며 `LOL_LIVE_ENABLED=true`일 때만 공개 경로와 진입점이 열린다.

## 계약

| 구분 | 경로 | 설명 |
| --- | --- | --- |
| 공개 화면 | `/lol/kr/{이름-태그}/live` | `LOL_PUBLIC_ENABLED`와 `LOL_LIVE_ENABLED`가 모두 `true`일 때만 열린다. 아니면 404 |
| 공개 API | `POST /api/lol/live` | body `{ riotId, tier? }`. 플래그가 꺼져 있으면 호출 제한에 기록하지 않고 404 |
| 관리자 화면 | `/admin/lol/kr/{이름-태그}/live` | 기존 관리자 가드(`requireLolDevPageAdmin`)만 사용. `LOL_LIVE_ENABLED`와 무관 |
| 관리자 API | `POST /api/admin/lol/live` | 기존 가드(`requireLolDevAdmin`)만 사용. `LOL_LIVE_ENABLED`와 무관 |

진입점: 전적 결과 헤더의 "진행 중인 게임" 링크(공개는 플래그가 켜졌을 때만, 관리자는 항상).

응답 `status`는 네 가지다.

- `ready`: 참가자 목록, 밴, 큐 이름, 조회 시점 경과 시간, 챔피언 통계 상태를 담는다.
- `not_in_game`: Spectator 404(진행 중 경기 없음).
- `unsupported_mode`: 커스텀 게임(`gameType` `CUSTOM_GAME` 또는 queue 0). 참가자와 밴을 담지 않는다.
- 오류: 400 형식, 404 계정 없음, 429(`Retry-After`), 503 키 갱신 안내(`riot_key_renewal`)·혼잡·busy·저장소, 504 시간 초과, 502 기타.

참가자별 칸은 독립적으로 실패한다. 랭크 조회가 실패하면 `rank.status: "failed"`와 사유(`rate_limited`, `key_or_permission`, `congested`, `timeout`, `upstream`)만 그 칸에 두고 전체 응답은 200이다.

## 호출량

한 번 조회의 Riot 호출은 최대 12회다.

1. Account-V1 `by-riot-id` (asia): Riot ID를 PUUID로 바꾼다. 캐시 적중 시 0회.
2. Spectator-V5 `active-games/by-summoner/{puuid}` (kr): 경로 이름은 by-summoner지만 인자는 PUUID다. 1회.
3. League-V4 `entries/by-puuid/{puuid}` (kr): 공개 참가자(puuid 있고 Riot ID 형식이 맞는 참가자)만, 최대 10회.

익명·봇 참가자에게는 추가 호출을 하지 않는다. 챔피언 통계는 Riot 호출이 없고 기존 `lol_stat` 집계 RPC(`get_lol_champion_stats`)만 쓴다. 솔로 랭크(420) 경기에서만 조회한다.

모든 호출은 기존 `requestJson`과 공유 호출 제한(DB 예약, 개발 키 한도)을 그대로 거친다. 공개 경로는 `guardLolPublicRequest`(검색 한도 분당 10회)를 적용한다.

## 캐시

DB에 저장하지 않는다. 프로세스 메모리 캐시(`globalThis`, 최대 500항목)로 같은 조회를 합친다. `requestJson`은 `LOL_PERSISTENCE_ENABLED=true`일 때 자체 메모리 캐시를 쓰지 않으므로, 이 캐시가 반복 호출을 막는다.

| 대상 | TTL | 비고 |
| --- | --- | --- |
| 계정(Riot ID → PUUID) | 10분 | |
| 관전 결과(파서가 만든 값, 404 포함) | 20초 | Riot 원문 응답은 보관하지 않는다 |
| 솔로 랭크 항목 | 60초 | |
| 챔피언 통계(티어 필터별) | 10분 | 전역 집계이므로 사용자별로 나누지 않는다 |

실패한 조회는 캐시하지 않는다. 캐시 키와 `RESULT_VERSION`·`ANALYSIS_CALCULATION_VERSION`·`TELEMETRY_VERSION`에는 영향이 없다. 기존 전적 DTO와 저장 계약도 바뀌지 않는다.

## 플래그

| 환경 변수 | 역할 |
| --- | --- |
| `LOL_LIVE_ENABLED` | 공개 화면·공개 API·공개 진입점. 기본은 꺼짐 |
| `LOL_PUBLIC_ENABLED` | 기존 공개 LoL 영역 전체. 이 값이 꺼져 있으면 공개 진행 중 경기도 열리지 않는다 |
| `LOL_DEV_ENABLED` | 관리자 LoL 화면 가드. 관리자 확인 화면은 여기에 의존한다 |

운영에서 켜려면 `LOL_LIVE_ENABLED=true`를 설정하는 것만으로 충분하다. 이 변경은 이 PR에 포함되지 않으며, 운영 환경 변수는 바꾸지 않았다.

## 정책 경계

- 듀오·파티 예측, 함께 플레이 여부 추정, 다른 참가자 최근 경기 교차 분석은 구현하지 않았다. 관련 UI 자리표시도 없다.
- 참가자 신원은 응답의 puuid와 Riot ID에서만 얻는다. 익명(puuid null·형식 불일치·Riot ID 없음)이면 "비공개 참가자"로 표시하고, 다른 경로로 복원하거나 조회하지 않는다.
- 커스텀 게임은 표시하지 않는다.
- 추천, 승패 예측, 유불리 점수, 경고성 결론을 만들지 않는다. 사실 값만 나열한다.
- 증강·아레나 아이템 승률을 표시하지 않는다.
- 참가자 원문을 수집·저장하지 않으며, 진행 중 경기 데이터를 DB에 영구 저장하지 않는다.

## 미확인 필드

- 공식 Spectator-V5 문서(`developer.riotgames.com/api-details/spectator-v5`)를 확인했을 때 `CurrentGameParticipant`에 `riotId` 필드가 나타나지 않았다. 파서는 `riotId`가 있을 때만 공개 참가자로 보고, 없으면 익명으로 처리한다. 실제 응답에 `riotId`가 없다면 모든 참가자가 "비공개 참가자"로 보인다. 이때 이름을 얻으려면 Account-V1 `by-puuid`(gameName, tagLine 반환을 확인함)를 참가자마다 추가로 불러야 하는데, 이는 이번 호출 예산과 명세 범위 밖이라 구현하지 않았다.
- 2026-10-30 메인 실측: 키 유효 상태에서 Spectator-V5 경로와 인증은 동작하고 게임 중이 아니면 404다. 200 응답의 필드는 아직 확인하지 못했다(상위 약 15명 조회, 게임 중인 사람 없음). 따라서 게임 중 응답의 필드는 방어적으로 파싱하며, 필드가 없으면 해당 칸만 비운다.
- `gameLength`는 공식 설명상 "시작 후 지난 초"이며 실측 전이다.

## 운영 체크리스트

1. `LOL_PERSISTENCE_ENABLED=true` 환경에서 개발 키(100/120s, 20/1s) 한도 안에서 실측한다. 참가자 10명 기준 최대 12회다.
2. 실제 게임 중 계정으로 200 응답 필드를 확인하고, 필요하면 파서를 맞춘다.
3. 참가자 entries 10회는 `LOL_RIOT_PARALLEL_REQUESTS`에 따라 직렬·병렬로 나뉘어 응답이 늦을 수 있다. 화면은 로딩 상태를 보여 준다.
4. 프로덕션 키 승인 뒤에 공개 플래그를 켠다.

## 검증 (이번 구현)

- `npm run verify:core` (eslint 0 error, tsc 통과)
- `npm run verify:lol` (41개 파일 통과, 브라우저 fixture 제외 602 테스트 통과)
- `tests/lol-live-game.test.ts`: 파서, 익명·봇 분류, 커스텀 판정, 솔로 랭크, 챔피언 통계 규칙
- `tests/lol-live-routes.test.ts`: 플래그 꺼짐 404, 같은 출처, 게임 중 아님, 커스텀 제외, 익명·봇 추가 호출 없음, 일부 실패, 429·키 만료, 캐시, 큐별 통계, 관리자 가드, 응답에 puuid 원문 없음
- `RUN_LOL_DEV_BROWSER=true tests/lol-live-browser.test.ts`: 375x667, 390x844, 430x932, 1440x900에서 넘침 없음, 터치 44px 이상, 빈·커스텀·오류·키 상태
- `RUN_LOL_PUBLIC_BROWSER=true tests/lol-public-browser.test.ts`: 기존 23개 통과
- migration 없음. `verify:migrations`는 필요 없다.
