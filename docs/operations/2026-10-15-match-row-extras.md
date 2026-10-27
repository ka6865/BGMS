# 전적 목록 보조 값(이동 거리·최장 킬·팀원)

전적 목록 행과 왼쪽 열 카드에 이동 거리, 최장 킬 거리, 함께한 팀원을 표시한다. 텔레메트리를 받지 않고 기본 전적 수집이 이미 받는 공식 경기 응답(참가자 통계와 roster)만 쓴다.

## 저장 계약

`20261015120000_player_match_row_extras`가 `pubg_player_matches`에 NULL 허용 컬럼 세 개를 추가한다.

| 컬럼 | 의미 | 원본 |
| --- | --- | --- |
| `teammates` | 같은 팀 참가자 `[{name, account_id}]`, 최대 8명 | roster의 같은 팀 참가자. 봇·계정 ID 없음·경기 안 닉네임/계정 중복·비공개 플레이어는 제외 |
| `travel_distance` | 도보·차량·수영 거리 합(m, 정수) | 참가자 `walkDistance + rideDistance + swimDistance`, 하나라도 없으면 NULL |
| `longest_kill` | 최장 킬 거리(m, 정수). 킬이 없으면 공식 0 | 참가자 `longestKill` |

- `teammates`가 NULL이면 roster로 팀을 확인하지 못한 것이고, 빈 배열이면 팀은 확인했지만 적을 팀원이 없는 것(솔로 등)이다.
- 팀원 본인의 기록 행은 만들지 않는다. 2026-10-16부터 수집은 검색·연동 대상 플레이어 행만 저장하므로(#298), 팀원은 그 행 안에 이름과 계정 ID만 적는다.
- 기존 행은 모두 NULL이다. 원본 경기 응답은 14일 뒤 사라지므로 과거 경기를 소급해서 채우지 않는다.
- `upsert_pubg_participant_matches`는 세 값을 선택 입력으로 받는다. 관측하지 못한 값은 기존 값을 지우지 않는다(`coalesce`). 기존 검증·원자 저장·계정 충돌 시 전체 취소 계약은 그대로다.
- CHECK 제약 `pubg_player_matches_row_extras_check`는 `NOT VALID`로 추가해 기존 행 전체 검증 스캔을 생략한다.

## 조회와 개인정보

- 화면에는 이름만 보낸다. 목록·조우 API는 저장된 `teammates` 원본(계정 ID 포함)을 응답에서 빼고, 조회 시점의 비공개 목록(닉네임·계정 ID)으로 거른 `teammate_names`만 싣는다(`lib/pubg/playerMatchTeammates.ts`).
- 팀원이 저장 이후 닉네임을 바꾸면 기록에는 그 경기 당시 이름이 남는다. 비공개 신청은 계정 ID로도 걸러지므로 이름이 바뀌어도 숨겨진다.
- 비공개 목록을 읽지 못하거나 거르는 중 오류가 나면 팀원 표시만 생략하고 전적 응답은 그대로 보낸다.
- 상세 분석이 있는 경기는 분석 결과의 팀 구성 이름을 쓴다.
- 전체 전적 화면에서 장기 성과 요약을 합칠 때는 같은 목록 응답의 `teammate_names`를 반영한다. 장기 성과 요약에는 팀원이 없으므로 이를 그대로 대체하면 응답 순서에 따라 팀원이 사라진다. 현재 목록에 이름이 없으면 이전 화면이나 성과 요약의 이름을 복원하지 않는다. 상세 분석 요약 우선순위는 유지한다.

## 배포 순서

새 코드는 목록 조회에서 세 컬럼을 select한다. **운영 DB에 migration을 먼저 적용한 뒤 앱을 배포한다.** 순서가 바뀌면 전적 목록 API가 존재하지 않는 컬럼 오류로 실패한다.

1. `npm run verify:migrations`로 격리 검증한다(시나리오: `tests/fixtures/migration-check/player-match-row-extras-checks.sql`).
2. 운영에 이 migration 하나만 적용한다(`2026-10-10-remaining-review-fixes.md`의 파일 단위 적용 절차).
3. 적용 확인: 컬럼 세 개 존재, 함수가 `SECURITY INVOKER`·빈 `search_path`·service role 전용 실행 권한 유지.
4. 앱을 배포한 뒤 새로 수집된 경기에서 값이 채워지는지 확인한다.

## 보존 작업과의 관계

과거 복구 RPC는 행 전체를 `jsonb_populate_record` 스냅샷과 비교한다. 새 컬럼이 없는 기존 스냅샷은 NULL로 채워지므로 기존 행과 일치한다. 복구 대기 중인 legacy 행에 재수집으로 새 값이 들어가면 그 복구는 스냅샷 불일치로 중단되며 데이터는 바뀌지 않는다.

## 운영 적용 실적 (2026-10-15 UTC)

- 적용 전 기준: `pubg_player_matches` 컬럼 16개, 새 컬럼 없음, `upsert_pubg_participant_matches` 본문 md5 `6d50579a…`, `SECURITY INVOKER`·`search_path=""`.
- 방법: 임시 작업 폴더에 원격 이력 161개의 빈 자리표시 파일과 대상 파일 하나를 두고 `supabase db push --linked --workdir <임시 폴더>`. 먼저 `--dry-run`으로 대상이 `20261015120000_player_match_row_extras.sql` 하나임을 확인했다.
- 적용: 18:12:29~18:12:32 UTC.
- 적용 후: 컬럼 19개(`teammates` jsonb, `travel_distance`·`longest_kill` integer), 함수 본문 md5 `337194a0…`, `SECURITY INVOKER`·`search_path=""` 유지, anon·authenticated 실행 불가·service_role 실행 가능, CHECK 제약 `NOT VALID`, 이력 162개·최신 `20261015120000`.
- 배포 순서: migration 적용 → #298(참가자 저장 중단) 병합 → #297 병합 → Production `b0d29fb9` 배포(18:17 UTC).
- 배포 후 확인: 운영 `/api/pubg/player/matches` 200·20경기, 응답에 새 컬럼 포함·원본 `teammates` 미포함. `/api/pubg/matches-summary`(`collect:false`) 200, 분석된 경기는 팀원 이름 표시. 새로 수집되는 경기의 값 채움은 다음 검색 이후 확인한다.
