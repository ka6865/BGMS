# LoL challenges 영구 요약과 챔피언 숙련도 비교

## 목적과 범위

경기 원문은 7일 뒤 만료되므로, 기존 본인 영구 요약에 핵심 challenges 숫자 31개를 보존한다.
관리자·공개 전적의 왼쪽 열에는 누적 숙련도와 저장된 최근 성과를 따로 표시한다.
추가 의존성, 벤치마크 변경, 운영 적용, 배포, 기존 migration 수정은 하지 않는다.

## 구현 계획

- [x] `challenges.ts` 화이트리스트·DTO와 신규 migration을 추가한다. 기존 공통 요약 함수는 열·추출식·충돌 갱신 외에 동일하게 유지한다.
- [x] 동일 추출기로 남은 원문을 백필한다. RLS와 service_role 전용, security invoker, 빈 search_path를 유지한다.
- [x] 기존 requestJson·중앙 가드·메트릭을 통해 숙련도 상위 10개를 조회하고, 검색 키를 v10으로 올린다.
- [x] 영구 요약 최근 최대 100개를 조회하여 챔피언별 판수·승률·합산 KDA를 계산한다. 공용 카드에서 관리자·공개 화면에 표시한다.
- [x] core·LoL·security·격리 migration·브라우저 fixture를 검증하고 결과를 기록한다.

## 저장 계약

`lol_player_match_summaries.challenges`는 NOT NULL jsonb이며 기본값은 `{}`이다.
객체만 허용하고 키 31개·직렬화 4096바이트 상한 CHECK를 둔다. SQL은 고정 배열 키와 숫자형 값만 추출한다.
비정상적으로 긴 숫자(문자열 변환 64바이트 초과)는 건너뛴다. 키 누락, null, 배열, 문자열, bool은 오류 없이 제외한다.
원문이 없는 요약은 그대로 남는다. 원문이 남은 행은 기존 공통 추출기를 호출해 백필한다.
기존 RPC가 SETOF 테이블을 반환하므로 새 열도 서버 요약 타입에 포함하며, 원문 검색의 본인 경기 DTO에도 같은 키만 전달한다.
화면에서 challenges 수치를 새로 노출하지 않는다. 익명 벤치마크 집계는 변경하지 않는다.

## 확인한 challenges 키

[Riot 공식 Match-V5 문서](https://developer.riotgames.com/apis#match-v5)의 ChallengesDto 키와 타입을 확인했다.
`tests/fixtures/lol/challenges.ts`는 이 키들의 가상 숫자 표본이며 실제 Riot ID·운영 원문을 포함하지 않는다.
실제 패치·모드에 따라 키가 없을 수 있으며 부재를 0으로 보정하지 않는다.
라인전 달성 플래그와 비율을 실제 골드·경험치 차이로 해석하지 않는다.

| 키 | 의미·단위 |
| --- | --- |
| `laningPhaseGoldExpAdvantage` | 라인전 골드·경험치 우위 달성 여부(0/1) |
| `earlyLaningPhaseGoldExpAdvantage` | 초반 라인전 골드·경험치 우위 달성 여부(0/1) |
| `maxCsAdvantageOnLaneOpponent` | 라인 상대 대비 최대 CS 우위 |
| `maxLevelLeadLaneOpponent` | 라인 상대 대비 최대 레벨 우위 |
| `visionScoreAdvantageLaneOpponent` | 라인 상대 대비 시야 점수 우위 비율 |
| `laneMinionsFirst10Minutes` | 첫 10분 라인 미니언 처치 수 |
| `jungleCsBefore10Minutes` | 첫 10분 정글 CS |
| `turretPlatesTaken` | 획득한 포탑 방패 수 |
| `soloKills` | 단독 처치 수 |
| `damageTakenOnTeamPercentage` | 팀 전체 받은 피해 중 본인 비율(0~1) |
| `teamDamagePercentage` | 팀 챔피언 피해 중 본인 비율(0~1) |
| `killParticipation` | 킬 관여 비율(0~1) |
| `kda` | Riot 제공 KDA |
| `visionScorePerMinute` | 분당 시야 점수 |
| `wardTakedowns` | 와드 제거 관여 수 |
| `controlWardsPlaced` | 설치한 제어 와드 수 |
| `stealthWardsPlaced` | 설치한 투명 와드 수 |
| `epicMonsterSteals` | 에픽 몬스터 스틸 수 |
| `dragonTakedowns` | 드래곤 처치 관여 수 |
| `baronTakedowns` | 내셔 남작 처치 관여 수 |
| `riftHeraldTakedowns` | 협곡의 전령 처치 관여 수 |
| `firstTurretKilled` | 첫 포탑 처치 달성 여부(0/1) |
| `turretTakedowns` | 포탑 파괴 관여 수 |
| `killsUnderOwnTurret` | 아군 포탑 아래에서 올린 킬 수 |
| `tookLargeDamageSurvived` | 큰 피해를 받고 생존한 횟수 |
| `saveAllyFromDeath` | 아군 사망을 막은 횟수 |
| `effectiveHealAndShielding` | 유효 치유·보호막 합계 |
| `skillshotsDodged` | 회피한 논타겟 스킬 수 |
| `skillshotsHit` | 적중한 논타겟 스킬 수 |
| `goldPerMinute` | 분당 골드 |
| `damagePerMinute` | 분당 챔피언 피해 |

## 숙련도 검색·캐시 계약

[Riot 공식 Champion-Mastery-V4 문서](https://developer.riotgames.com/apis#champion-mastery-v4)의
`GET https://kr.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/{encryptedPUUID}/top?count=10`를 사용한다.
공식 문서의 동적 API 본문(`/api-details/champion-mastery-v4`)에서 경로·count·필드를 확인했다.
챔피언 ID, championLevel, championPoints, lastPlayTime(Unix 밀리초), championPointsUntilNextLevel,
championSeasonMilestone만 선택한다. nextSeasonMilestone 등 보상 원문과 puuid는 공개 DTO에서 제외한다.
숙련도는 검색 캐시 miss/갱신 시 1회 추가하며 랭크와 동일한 120초 TTL을 사용한다. 캐시 적중 시 추가 Riot 호출은 없다.
추가 경기 조회·수집에는 숙련도 호출을 하지 않는다. 숙련도 실패는 카드 메시지로 격리한다.

## 최근 성과·배지 규칙

영구 요약은 최근 최대 100경기이며 캐시 적중에서도 DB를 다시 읽어 새 수집·원문 만료 후 상태를 반영한다.
카드는 반드시 `BGMS에 저장된 최근 N경기 기준 · 큐 전체`로 표시한다. 큐 필터와 독립이다.
다시하기, 5분 미만, 승패·챔피언 ID 누락은 성과에서 제외한다. K/D/A가 하나라도 없으면 합산 KDA는 미제공이다.
합산 KDA는 `(킬 합계 + 어시스트 합계) / 데스 합계`이다. 무사망이면서 킬·어시스트가 있으면 Perfect, 모두 0이면 미제공이다.

- 최근 성과 좋음: 해당 챔피언 3판 이상, 승률 60% 이상, 합산 KDA 3 이상 또는 Perfect.
- 주력: 숙련도 상위 10개에 속하면서 최근 성과 좋음.
- 최근 부진: 숙련도 상위 10개 중 3판 이상, 승률 40% 미만, 합산 KDA 2 미만.
- 떠오르는 챔피언: 숙련도 상위 10개 밖이면서 최근 성과 좋음. 절대 숙련도가 낮다는 단정은 하지 않는다.
- 3판 미만·성과 누락·숙련도 실패 시 비교 배지를 붙이지 않는다.

누적 숙련도 목록은 Riot 제공 포인트 순서를 유지하고 최근 성과 목록은 최근 경기 등장 순서로 표시한다.
새 점수·순위·MMR을 만들지 않는다. DB 조회 실패는 최근 성과 안내만 표시하고 숙련도와 전적을 유지한다.

## 검증

- `npm run verify:core`: exit 0, ESLint 오류 0개·기존 경고 47개, TypeScript 통과.
- `npm run verify:lol`: 26개 파일·434개 통과, 조건부 테스트 59개 skip. 브라우저는 아래 별도 실행으로 확인했다.
- `npm run verify:security`: 6개 파일·91개 통과.
- `BGMS_USE_LOCAL_POSTGRES=true npm run verify:migrations`: 격리 로컬 PostgreSQL에서 명시된 migration 97개 적용 및 전체 시나리오 통과. 신규 challenges 권한·백필·필터·상한 검증 10개 그룹 포함.
- `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-dev-browser.test.ts tests/lol-public-browser.test.ts --maxWorkers=1`: 관리자 36개·공개 14개, 총 50개 통과.
- 관리자 정상 화면 캡처 추가 후 `-t '검색·요약·상세가' --maxWorkers=1`: 5개 통과, 관련 없는 31개 선택 제외.
- 뷰포트: 관리자 375×667·390×844·430×932·1024×900·1440×900, 공개 375×667·390×844·430×932·1440×900. 정상·빈 숙련도·숙련도 실패에도 전적 보존 확인.
- 기존 브라우저의 전체 결과 문구 금지 검사는 기존 요약 영역으로 한정했다. 새 카드에는 필수 표본 문구가 들어간다.
- 병렬 브라우저 실행 중 공개 페이지 진입 timeout 2건이 발생해 파일 순차 실행으로 재검증했다. 최종 순차 실행 50개 모두 통과했다.
- `git diff --check`와 변경 파일의 300자 줄 제한 검사 통과. 함수 원본 비교·SQL/TS 키 일치 테스트 통과.

화면 증거: `tmp/lol-detail-alignment/mastery-375x667.png`, `mastery-390x844.png`, `mastery-430x932.png`, `mastery-1024x900.png`, `mastery-1440x900.png`.
모바일 카드는 스크롤 영역 안에 있으며 요소 캡처 일부는 뷰포트 경계에서 잘린다. 실제 뷰포트 검사는 가로 넘침·카드 표시·오류 보존을 확인했다.
공개 화면 증거는 `tmp/lol-public-review/`에 있다.

### migration SHA256과 교체 함수 차이

`20261024030000_lol_summary_challenges.sql` SHA256:

`7c8dea682f732677029ebb6c19372c859ff4f2ad5f46d1d660c04fb06c2c3143`

직전 `20261023060000_lol_participant_identity.sql`의 함수와 비교하면 insert 대상 challenges 열,
선택 값의 화이트리스트 추출식, on conflict의 challenges 대입만 추가했다. 이 세 부분을 제거하면 함수 문자열이 완전히 같음을 테스트했다.
기존 RPC·RLS·함수 security invoker·빈 search_path를 유지하고 실행 권한도 service_role로 명시했다.

### 미실행·운영 적용 주의

실제 Riot 호출 0회이며 공식 동적 문서와 가상 fixture로 검증했다. 실제 모바일 앱·실기기, 운영 DB, 배포 환경 검증은 하지 않았다.
운영 적용·커밋·push·배포·개발 서버 재시작은 하지 않았다. 새 migration을 먼저 적용한 뒤 코드를 배포해야 한다.
`.agents/rules/project_rules.md`는 이 작업 폴더에 없어 추적된 AGENTS.md와 제공된 BGMS 스킬을 기준으로 진행했다.
숙련도 상위 10개 밖이라는 사실만으로 절대 숙련도가 낮다고 단정하지 않는다. 원문이 이미 만료된 과거 경기에는 challenges를 복구할 수 없다.

### 변경 파일

- `components/lol/LolMasteryCard.tsx`
- `components/lol/LolSearchPanel.tsx`
- `docs/plans/2026-10-24-lol-challenges-mastery.md`
- `lib/lol/challenges.ts`
- `lib/lol/mastery.ts`
- `lib/lol/persistence.server.ts`
- `lib/lol/riotSearch.server.ts`
- `lib/lol/types.ts`
- `scripts/verify_migrations_local.sh`
- `supabase/migrations/20261024030000_lol_summary_challenges.sql`
- `tests/fixtures/lol/browserScenario.ts`
- `tests/fixtures/lol/challenges.ts`
- `tests/fixtures/migration-check/lol-challenges-backfill-setup.sql`
- `tests/fixtures/migration-check/lol-challenges-scenarios.sql`
- `tests/lol-challenges-mastery.test.ts`
- `tests/lol-collect.test.ts`
- `tests/lol-dev-browser.test.ts`
- `tests/lol-persistence.test.ts`
- `tests/lol-public-browser.test.ts`
- `tests/lol-riot-search.test.ts`
