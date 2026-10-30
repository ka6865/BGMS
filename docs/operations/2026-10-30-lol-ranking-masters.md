# LoL 랭킹·장인 운영 절차 (2026-10-30, D안 반영 2026-10-31)

설계 기준: [랭킹·장인 설계](../plans/2026-10-30-lol-ranking-mastery-tabs.md). 이 문서는 적용 순서, 설정, 재개, 오류 대응, 되돌리기, 삭제 요청, 시즌 교체를 정한다.

## 구성

| 구분 | 이름 | 위치 |
| --- | --- | --- |
| 수집기 | `scripts/lol_ranking_snapshot.ts` | dry-run 기본. `--apply`는 쓰기 플래그 필요 |
| 삭제 요청 제외 | `scripts/lol_ranking_exclude.ts` | Riot ID로 제외 키를 만들고 작업 데이터와 게시본에서 뺀다. Riot API를 호출하지 않는다 |
| 정리 | `scripts/lol_cleanup_expired.ts` | 종료 후 30일 작업 데이터 정리(기존 정리 흐름에 포함) |
| 워크플로 | `.github/workflows/lol-ranking.yml` | 3시간마다, main만. 이어받기 |
| migration | `supabase/migrations/20261031030000_lol_ranking_publication.sql` | 게시 표, 시즌 작업 표, 제외 목록, RPC |
| 화면 | `/lol/kr/ladder`(랭킹), `/lol/kr/masters`(장인) | 장인은 플래그 필요 |

## 설정

| 이름 | 종류 | 위치 | 값과 의미 |
| --- | --- | --- | --- |
| `LOL_PERSISTENCE_ENABLED` | 환경 | 워크플로·서버 | `true`. DB 저장과 공유 호출 제한을 쓴다 |
| `LOL_RIOT_PRIORITY` | 환경 | 워크플로 | `background`. 검색 몫 90%가 아니라 background 50%만 쓴다 |
| `LOL_RANKING_ENABLED` | Variables | GitHub | `true`일 때만 `--apply`로 저장한다. 없으면 dry-run과 경고만 남긴다 |
| `LOL_RANKING_HMAC_KEY` | Secrets | GitHub | 32자 이상. 제외 키와 계정 키를 만든다. 바꾸면 기존 제외와 누적 키가 모두 달라진다 |
| `RIOT_API_KEY` | Secrets | GitHub | 프로덕션 키. 개발 키는 24시간마다 만료된다 |
| `LOL_SEASON_START` | Variables | GitHub | 시즌 시작 시각(ISO). 운영 기본 후보 `2026-01-08T00:00:00+09:00`(추정, 공식 확정 아님). 없으면 수집을 실패시킨다 |
| `LOL_SEASON_END` | Variables | GitHub | 시즌 종료 시각(ISO). 쓰기 실행에 필수다. 종료 후 30일에 작업 데이터를 지운다 |
| `LOL_RANKING_MAX_CALLS` | Variables | GitHub | 한 실행의 Riot 호출 상한. 기본 600. 프로덕션 권장 값은 실행 시간에 맞춘다(아래) |
| `LOL_RANKING_CHECK_HOURS` | Variables | GitHub | 계정 확인 주기. 기본 12 |
| `LOL_CLEANUP_ENABLED` | Variables | GitHub | 정리 쓰기 플래그. 시즌 작업 데이터 정리에도 쓴다 |
| `LOL_MASTERS_PUBLIC` | 환경 | 서버 | `true`일 때만 장인 메뉴와 경로를 연다. 꺼져 있으면 404 |

시즌 값은 GitHub Variables에 넣는다. 코드에 쓰지 않는다. 값을 바꾸면 새 시즌 키가 되어 이전 누적과 섞이지 않는다.

호출 상한 권장값(추정): 워크플로 제한이 40분이고 호출 한 번이 약 0.3초라면 실행당 6,000회를 넘기기 어렵다. 프로덕션에서는 3,000에서 5,000으로 시작하고, 실행 시간을 보고 조정한다. 개발 키는 100회/2분 중 background 50%만 쓰므로 한 실행 600회(약 24분)가 안전하다.

## 적용 순서

1. 코드가 main에 들어가고 배포된다. 이 시점에 `LOL_MASTERS_PUBLIC`과 `LOL_RANKING_ENABLED`는 끈다.
2. 운영 migration을 **파일 하나씩** 적용한다(`supabase db push` 금지). 적용 뒤 `list_lol_ranking_exclusion_keys`가 빈 배열을 돌려주는지 본다.
3. `LOL_RANKING_HMAC_KEY`를 Secrets에 넣는다. 이미 있다면 바꾸지 않는다.
4. `LOL_SEASON_START`와 `LOL_SEASON_END`를 Variables에 넣는다. 시작은 §설정의 후보 값을 쓴다. 종료는 다음 시즌 시작 시각을 쓴다(추정). 실제 시즌 공지와 맞춘다.
5. 프로덕션 키를 `RIOT_API_KEY`에 넣는다. 워크플로를 수동 실행한다. `LOL_RANKING_ENABLED`는 아직 끈 상태로 **dry-run**을 먼저 돌린다.
6. dry-run 결과를 확인한다(아래 "첫 실행 확인").
7. `LOL_RANKING_ENABLED=true`로 켜고 수동 실행한다. 결과에 `published.master`가 `true`로 나오면 저장이 된 것이다.
8. 공개 방침 갱신과 시행일 공지를 끝낸다(설계 §11-1). 방침이 바뀌기 전에는 장인을 열지 않는다.
9. `LOL_MASTERS_PUBLIC=true`로 장인을 연다.

## 첫 실행 확인 (dry-run)

- 결과의 `counts.candidates`가 명단 수(1,000)와 같은지, `counts.resolved`가 95% 이상인지 본다.
- `counts.countedMatches`가 0보다 크면 판수가 세지고 있다. 0이면 시즌 날짜와 큐를 확인한다.
- `counts.skippedMatches`가 많으면 상세 형식이 바뀌었는지 본다.
- 출력에 PUUID와 해시값 원문이 없는지 본다. 수집기 출력은 개수만 찍는다.
- 개발 키로 하루 1회 수집은 불가능하다(24시간마다 만료). 개발 키 확인은 한 번만 하고 운영 수집은 프로덕션 키 뒤로 미룬다.

## 재개 (호출 상한과 중간 실패)

- 한 실행은 `LOL_RANKING_MAX_CALLS`에 닿으면 저장하고 정상 종료한다. 결과의 `budget.exhausted`가 `true`다.
- 다음 3시간 실행이 저장된 커서부터 이어받는다. 같은 실행을 여러 번 해도 판수는 늘지 않는다(멱등).
- 계정 단위로 저장하므로 중간에 실패해도 끝난 계정은 그대로 남는다. 실패한 계정은 다음 실행이 다시 본다.
- 수동으로 연속 실행하려면 `workflow_dispatch`를 여러 번 누른다. 동시 실행은 워크플로의 concurrency가 막는다.
- 백필(시즌 처음 전체 수집)은 실행을 여러 번 반복한다. 진행률은 장인 화면의 수집 범위에서 본다.

## 401과 403(키 오류)

증상: 수집 로그에 "Riot 키 오류(401/403)입니다"가 나오고 실행이 실패한다.

1. 명단을 게시하지 않는다. 장인과 명단은 마지막 게시본이 그대로 남는다.
2. 저장된 커서는 건드리지 않는다. 키를 바꿔도 누적은 이어진다.
3. 새 프로덕션 키를 `RIOT_API_KEY` Secret에 넣는다.
4. 워크플로를 수동 실행한다. 실패 기록을 확인하고 정상이면 끝난다.
5. 개발 키를 쓰고 있었다면 24시간 뒤 만료되므로, 프로덕션 키로 바꾸지 않으면 다음 실행도 같은 오류로 멈춘다.

## 키 교체와 누적 연속성

- 계정 키는 PUUID에서 만든 해시다. 키를 바꾸면 PUUID가 달라질 수 있다. 그러면 같은 소환사가 새 계정 행으로 들어가 **이번 시즌 누적이 끊긴다**(미확인, 실측 필요).
- 교체 전후에 `lol_check_key_puuid` 같은 점검 스크립트로 PUUID가 같은지 확인한다(기존 키 교체 절차 참고).
- PUUID가 바뀌었으면 시즌 행을 새로 쌓는다. 옛 행은 시즌 종료 후 30일에 지워진다. 옛 행을 바로 지울 때는 운영 승인과 dry-run이 필요하다.
- 제외 키(Riot ID 해시)는 PUUID와 무관하므로 키를 바꿔도 유지된다. 단 Riot ID 해시 키 자체(`LOL_RANKING_HMAC_KEY`)를 바꾸면 모든 제외가 풀린다. 바꾸지 않는다.

## 삭제 요청 처리

1. 요청자의 Riot ID(게임 이름#태그)를 확인한다(방침의 절차).
2. 서버 환경에서 `LOL_RANKING_HMAC_KEY`와 `LOL_PERSISTENCE_ENABLED=true`를 설정하고 dry-run을 먼저 한다.
   `npx tsx scripts/lol_ranking_exclude.ts "게임이름#태그" --dry-run`
3. 확인 후 `--apply`로 실행한다. 제외 키를 넣고, 시즌 작업 행(판수 포함)을 지우고, 명단과 장인 게시본에서 같은 Riot ID를 뺀 뒤 순위를 다시 매긴다.
   `npx tsx scripts/lol_ranking_exclude.ts "게임이름#태그" --apply`
4. 출력에는 Riot ID 원문이 나오지 않는다. 제거된 명단 행 수만 나온다.
5. 다음 수집에서도 제외 키를 대조하므로 다시 들어오지 않는다.
6. 잔여 위험: 요청자가 Riot ID를 바꾸면 새 이름은 제외되지 않는다. 새 Riot ID로 다시 요청하도록 안내한다.

## 시즌 교체

1. 새 시즌 시작 시각을 `LOL_SEASON_START`에, 새 종료 시각을 `LOL_SEASON_END`에 넣는다. 이전 시즌 종료 시각은 그대로 둔다.
2. 다음 실행부터 새 시즌 키(KST 날짜)로 쌓인다. 이전 시즌 누적은 섞이지 않는다.
3. 이전 시즌 작업 데이터는 `LOL_SEASON_END` 후 30일에 `scripts/lol_cleanup_expired.ts`가 지운다. 정리는 `LOL_CLEANUP_ENABLED=true`가 있을 때만 쓴다.
4. 새 시즌 초기에는 장인 화면에 "수집 중"이 보인다. 백필이 끝날 때까지 이 문구가 유지된다.

## 되돌리기

- 장인만 숨기기: `LOL_MASTERS_PUBLIC`을 끈다. 경로는 404가 되고 데이터는 그대로 있다.
- 수집 멈추기: `LOL_RANKING_ENABLED`를 끈다. 워크플로는 dry-run으로만 돈다. 게시본은 남는다.
- 장인 게시본 비우기: 운영 DB 쓰기다. 승인과 dry-run 대상 확인 뒤에만 한다. 이후 장인은 "아직 집계되지 않았습니다"를 보인다.
- 시즌 작업 데이터 지우기: 운영 DB 쓰기다. 승인 뒤에 `purge_lol_expired_season_accounts`의 기준을 맞춰 실행하거나 해당 시즌 행을 지운다.
- 제외 목록은 되돌리지 않는다. 삭제 요청의 결과이므로 풀지 않는다.
- migration 되돌림은 함수와 표를 삭제하는 것이다. 제외 목록이 쌓인 뒤에는 실행하지 않는다.

## 정리 (방침 보관 기간)

- `lol_cleanup_expired.ts`를 `--apply`로 돌리면 기존 정리 뒤에 `purge_lol_expired_season_accounts(now)`가 실행된다.
- 기준은 시즌 종료 후 30일이다. 종료 시각이 없는 행은 지우지 않는다. 그래서 쓰기 실행은 `LOL_SEASON_END`를 요구한다.
- dry-run은 아무것도 지우지 않는다. 결과의 `seasonPurge.dryRun`이 `true`면 지워지지 않았다는 뜻이다.

## 표현 기준

- 장인 화면과 방침에 "수집된 판수"라고 쓴다. 시즌 전체 판수라고 단정하지 않는다.
- 실측에서 일부 계정의 경기 목록이 시즌 승패 합보다 짧았다(예: 승패 합 594에 목록 452, 505에 213). 원인은 미확인이다. 판수가 실제보다 적을 수 있다는 안내를 유지한다.
- 금지 표현: "점수", "실력", "1등", "숙련도".

## 검증 기록

- `npm run verify:core`: eslint 오류 0, tsc 통과. 경고는 기존 파일의 것이다.
- `npm run verify:lol`: 결과는 최종 실행 기록에 적는다.
- 단위 테스트: 장인 자격과 정렬, 경기 추출, 커서 멱등성, 수집기 시나리오(멱등, 경기 중복 없음, 호출 상한 재개, 시즌 분리, 제외, 키 오류, 누락 경기), 정리 함수, 공개 게시본에 PUUID와 해시 없음.
- migration 시나리오: 권한, RLS, 입력 거부, 커밋 잠금(40001), 제외 재정렬, 시즌 종료 후 30일 정리.
- 브라우저 fixture(`RUN_LOL_DEV_BROWSER=true`): 375x667, 390x844, 430x932, 1440x900에서 랭킹과 장인, 빈 상태와 오류 상태.
