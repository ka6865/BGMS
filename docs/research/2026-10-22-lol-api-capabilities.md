# LoL API 제공 정보와 BGMS 적용 범위

조사일: 2026-10-22. 다른 에이전트의 화면·DB·분석 작업을 위한 필드 지도다.

## 1. 확인 범위와 결론

- **확인됨:** Riot 공식 API 문서의 Account-V1, Summoner-V4, League-V4, Match-V5, Champion Mastery-V4, Spectator-V5, Challenges-V1, Champion-V3, Status-V4 명세를 읽었다. 공식 페이지가 동적으로 불러오는 `/api-details/{api-name}` 문서 JSON의 `html`을 각각 HTTP 200으로 확인했다. 이는 게임 데이터 API 호출이 아니며 API 키를 사용하지 않았다.
- **확인됨:** 현재 BGMS는 `lib/lol/riotSearch.server.ts`의 `searchLolRiotId()`, `getLolMatchDetails()`, `summarizeMatch()`, `getStaticData()`에서 이 정보 중 일부만 DTO로 변환한다. `components/lol/LolSearchPanel.tsx`는 그 DTO만 표시한다.
- **제안:** 상세 전적은 이미 가져오는 Match-V5 필드를 먼저 활용하고, 타임라인·숙련도·진행 중 경기처럼 별도 호출이 필요한 기능을 뒤에 추가한다.
- **추가 검증 필요:** 명세에 필드가 있어도 모든 패치·모드·계정에 값이 존재한다는 뜻은 아니다. 이번에는 실제 회원·Riot 계정·실제 경기·키 권한을 조회하지 않았다.

근거: [공식 API 목록](https://developer.riotgames.com/apis), [LoL 가이드](https://developer.riotgames.com/docs/lol), [개발자 포털 가이드](https://developer.riotgames.com/docs/portal).

## 2. API별 식별자·라우팅·제공 범위

한국 서비스의 기본 조합은 플랫폼 `KR` → `kr.api.riotgames.com`, 경기 지역 `ASIA` → `asia.api.riotgames.com`이다. Account-V1의 지역 라우트와 게임 플랫폼을 같은 값으로 취급하지 않는다. `tagLine`이 곧 게임 서버인 것도 아니다.

| API | 주요 경로 | 식별자·한국 라우트 | 얻는 정보·경계 |
| --- | --- | --- | --- |
| Account-V1 | `/riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}`, `/accounts/by-puuid/{puuid}` | Riot ID ↔ PUUID, `asia` | 계정 식별자와 표시 이름. 아이콘·레벨·랭크는 다른 API |
| Summoner-V4 | `/lol/summoner/v4/summoners/by-puuid/{encryptedPUUID}` | PUUID, `kr` | `profileIconId`, `revisionDate`, `puuid`, `summonerLevel` |
| League-V4 | `/lol/league/v4/entries/by-puuid/{encryptedPUUID}` | PUUID, `kr` | 큐별 현재 티어·디비전·LP·승패. 경기 당시 등급이나 LP 증감 이력은 아님 |
| Match-V5 목록 | `/lol/match/v5/matches/by-puuid/{puuid}/ids` | PUUID, `asia` | 경기 ID 목록. `start`, `count`, `queue`, `type`, `startTime`, `endTime` 필터 |
| Match-V5 상세 | `/lol/match/v5/matches/{matchId}` | `KR_…` 경기 ID, `asia` | 경기 메타·참가자·팀·최종 아이템·결과 통계 |
| Match-V5 타임라인 | `/lol/match/v5/matches/{matchId}/timeline` | 경기 ID, `asia` | 시간 프레임·이벤트·참가자별 골드·CS·경험치·레벨·좌표 등 |
| Champion Mastery-V4 | `/lol/champion-mastery/v4/champion-masteries/by-puuid/{encryptedPUUID}` | PUUID, `kr` | 챔피언별 숙련도. 승률·경기 수 통계를 대신하지 않음 |
| Spectator-V5 | `/lol/spectator/v5/active-games/by-summoner/{encryptedPUUID}` | **경로 이름은 by-summoner지만 인자는 PUUID**, `kr` | 진행 중 경기의 기본 정보·챔피언·스펠·룬·밴 |
| Challenges-V1 | `/lol/challenges/v1/player-data/{puuid}` 등 | PUUID, `kr` | 계정 도전과제·점수·분포·진행도. Match 응답의 `challenges`와 별도 제품 |
| Champion-V3 | `/lol/platform/v3/champion-rotations` | `kr` | 무료 챔피언 로테이션 |
| Status-V4 | `/lol/status/v4/platform-data` | `kr` | 플랫폼 점검·장애 공지. BGMS 자체 연결 상태와 구분 |
| Data Dragon | `/cdn/{version}/data/ko_KR/*.json` | 패치·언어, 공개 CDN | 챔피언·아이템·스펠·룬·아이콘 등의 이름과 자산. 유저 통계 아님 |
| RSO | OAuth/OIDC 및 Account-V1 `/accounts/me` | 승인된 RSO access token | 로그인한 Riot 계정의 소유권 확인. 일반 API 키만으로 본인 소유권을 인증하지 않음 |

각 API 상세 근거: [Account](https://developer.riotgames.com/api-details/account-v1), [Summoner](https://developer.riotgames.com/api-details/summoner-v4), [League](https://developer.riotgames.com/api-details/league-v4), [Match](https://developer.riotgames.com/api-details/match-v5), [Mastery](https://developer.riotgames.com/api-details/champion-mastery-v4), [Spectator](https://developer.riotgames.com/api-details/spectator-v5), [Challenges](https://developer.riotgames.com/api-details/lol-challenges-v1), [Rotation](https://developer.riotgames.com/api-details/champion-v3), [Status](https://developer.riotgames.com/api-details/lol-status-v4).

**문서 충돌 주의:** LoL 설명 문서 일부는 Summoner ID 변환을 설명하지만, 이번 Summoner-V4 상세의 `SummonerDTO`는 위 4개 필드만 열거한다. 오래된 이름 기반 검색이나 `id` 반환을 새 구현의 전제로 삼지 않는다. League 조회도 현재 PUUID 엔드포인트를 사용한다.

## 3. 현재 상세 화면과 바로 확장할 수 있는 정보

아래 항목은 **Match-V5의 동일 경기 상세 응답 안에 정의된 필드**다. 이미 해당 응답이 확보됐다면 추출 때문에 별도 Riot 호출은 필요하지 않는다. DTO·DB 저장 범위·화면은 별도 변경이며 이 문서가 구현 완료를 뜻하지 않는다.

| 표시할 정보 | 공식 필드 | BGMS 현재 상태·활용 |
| --- | --- | --- |
| Riot ID·팀·챔피언 | `riotIdGameName`, `riotIdTagline`, `teamId`, `championId`, `championName` | 현재 표시. 참가자 연결은 서버의 PUUID 기준 |
| 챔피언 레벨 | `champLevel` | **구현됨(2026-10-23, [상세 확장](../plans/2026-10-22-lol-detail-enrichment.md)).** 계정 레벨 `summonerLevel`과 구분해 표시 |
| 라인·역할 | `teamPosition`, `individualPosition`, `lane`, `role` | 추가 가능. 일반 5대5는 공식 권장인 `teamPosition` 우선; 서버의 추정 배치임을 고려 |
| 스펠 | `summoner1Id`, `summoner2Id` | **구현됨(2026-10-23, [상세 확장](../plans/2026-10-22-lol-detail-enrichment.md)).** Data Dragon 스펠 수치 key → 이미지 매핑 적용 |
| 룬·능력치 조각 | `perks.styles[].style`, `selections[].perk`, `perks.statPerks` | **구현됨(2026-10-23, [상세 확장](../plans/2026-10-22-lol-detail-enrichment.md)).** 핵심 룬과 주·보조 룬 트리까지 표시 |
| K/D/A·승패 | `kills`, `deaths`, `assists`, `win` | 현재 표시 |
| 아이템·장신구 | `item0`~`item6` | 현재 7칸 표시. 최종 상태이며 구매 순서는 아님 |
| 챔피언 대상 피해 | `totalDamageDealtToChampions` | 현재 표시. `totalDamageDealt`와 의미가 다름 |
| 피해 종류 | `physicalDamageDealtToChampions`, `magicDamageDealtToChampions`, `trueDamageDealtToChampions` | 물리·마법·고정 피해 구성 추가 가능 |
| 받은 피해·피해 경감 | `totalDamageTaken`, `damageSelfMitigated`, 피해 종류별 taken 필드 | `totalDamageTaken`은 **구현됨(2026-10-23, [상세 확장](../plans/2026-10-22-lol-detail-enrichment.md))** — 가한 피해와 같은 팀 내 최댓값 기준 막대로 표시. `damageSelfMitigated`·피해 종류별 taken 필드는 여전히 추가 가능 |
| 아군 회복·보호막 | `totalHealsOnTeammates`, `totalDamageShieldedOnTeammates` | 서포터 기여 지표 후보. `totalHeal` 전체를 아군 회복량으로 쓰지 않음 |
| 시야·와드 | `visionScore`, `wardsPlaced`, `wardsKilled`, `detectorWardsPlaced`, `visionWardsBoughtInGame` | 시야 점수는 현재 표시. 설치·제거·구매는 서로 다른 지표 |
| CS·정글 CS | `totalMinionsKilled`, `neutralMinionsKilled` | 현재 총 CS는 두 값 합산. 라인 CS·정글 CS를 따로 보관하면 재계산 가능 |
| 골드 | `goldEarned`, `goldSpent` | 획득·소비 골드 표시 가능. 순수 라인전 우세를 뜻하지 않음 |
| 건물·오브젝트 피해 | `damageDealtToObjectives`, `damageDealtToTurrets`, `damageDealtToBuildings` | 추가 가능. 공격 피해만으로 전체 오브젝트 기여를 단정하지 않음 |
| 오브젝트 처치·스틸 | `baronKills`, `dragonKills`, `objectivesStolen`, `objectivesStolenAssists`, `turretTakedowns` 등 | 처치·관여·피해는 의미를 나눠 표시 |
| 멀티킬·첫 킬 | `doubleKills`~`pentaKills`, `firstBloodKill`, `firstBloodAssist` | 추가 가능 |
| 사망 시간·군중제어 | `totalTimeSpentDead`, `timeCCingOthers`, `totalTimeCCDealt` | 서로 다른 통계이므로 합치지 않음 |
| 종료 구분 | `gameEndedInSurrender`, `gameEndedInEarlySurrender`, `teamEarlySurrendered`, `info.endOfGameResult` | 항복·짧은 경기 처리 후보. 최신 실제 표본으로 판정 계약 추가 검증 |
| 팀 오브젝트·밴 | `info.teams[].objectives`, `bans` | 팀별 바론·용·전령·타워·억제기 및 `horde` 항목 명세 존재 |
| 패치·모드·맵·시간 | `gameVersion`, `queueId`, `gameMode`, `mapId`, 시간 필드 | 패치·큐별 분석 구분과 정적 데이터 버전 선택에 사용 |

근거: [Match-V5 ParticipantDto·TeamDto](https://developer.riotgames.com/api-details/match-v5).

`challenges`에도 `damagePerMinute`, `goldPerMinute`, `killParticipation`, `teamDamagePercentage`, `visionScorePerMinute`, `soloKills`, `turretPlatesTaken`, `laneMinionsFirst10Minutes`, `jungleCsBefore10Minutes`, `skillshotsHit`, `skillshotsDodged` 등이 정의돼 있다. **모드·패치별 선택 필드로 취급**한다. 예를 들어 `skillshotsHit`만으로 모든 스킬의 적중률을 만들면 분모가 불명확하다. `maxCsAdvantageOnLaneOpponent`는 10분 시점 CS 차이와 동일하지 않다.

## 4. 자체 계산과 누적 저장이 필요한 정보

| 기능 | 계산·필요 데이터 | 표시 조건 |
| --- | --- | --- |
| KDA 비율 | `(kills + assists) / deaths` | 사망 0은 별도 표시. 누락은 0으로 임의 대체하지 않음 |
| 킬 관여율 | `(kills + assists) / 같은 팀 참가자 kills 합계` | 팀 합계 0·참가자 누락 방어. 서버 `challenges.killParticipation`과 혼용 시 출처 명시 |
| 팀 피해 비중 | 본인 챔피언 피해 / 팀 챔피언 피해 합계 | 같은 피해 정의·동일 경기·누락 검증 |
| 분당 CS·피해·골드·시야 | 해당 수치 / 유효 경기 분 | 중도 이탈의 실제 참여 시간과 경기 전체 시간을 구분 |
| 개인 챔피언별 승률·KDA | 수집한 본인 경기에서 챔피언·패치·큐별 집계 | 수집 범위·경기 수 표시. 숙련도 API만으로 계산 불가 |
| 최근 추세 | 정해진 최근 N경기 또는 기간 집계 | 5경기 표본을 시즌 전체 통계로 표시하지 않음 |
| LP 변화·랭크 이력 | 시각이 기록된 League 스냅샷 누적 | 처음 저장하기 전의 과거 변화를 복원했다고 주장하지 않음 |
| 전체 챔피언 티어·픽률·승률 | 충분한 여러 유저 경기 표본·중복 제거·집계 | 공식 API가 완성된 전 세계 메타 통계를 주는 구조는 아님. 검색 유입 표본 편향 명시 |
| BGMS 경기 평가·개선점 | 검증된 계산 지표 + 근거를 제한한 별도 분석 | 공식 Riot 점수와 구분. 챔피언·역할·패치 표본 없이 정확한 상대 평가를 약속하지 않음 |

## 5. 타임라인으로 확장할 수 있는 분석

**확인됨:** 타임라인 명세는 `frameInterval`, `frames[].timestamp`, `participantFrames` 및 프레임별 `totalGold`, `currentGold`, `minionsKilled`, `jungleMinionsKilled`, `xp`, `level`, `position`, `championStats`, `damageStats`를 정의한다.

**제안:** 10·15분 골드/CS/레벨 차이, 팀 골드 그래프, 성장 흐름, 관측 좌표 기반 위치 요약을 만들 수 있다. 반드시 실제 프레임 시각을 사용하고 원하는 시각의 프레임이 없을 때 누락·근사 여부를 표시한다. `frameInterval`을 읽지 않고 항상 1분 간격이라고 고정하지 않는다.

**추가 검증 필요:** 현재 공식 `EventsTimeLineDto` 설명은 `timestamp`, `realTimestamp`, `type`만 열거해 타입별 payload 설명이 충분하지 않다. 킬 장면·구매 순서·스킬 레벨업·와드 이벤트를 제품 계약으로 사용하기 전, 소량의 승인된 실제 표본에서 이벤트 종류와 필드 의미를 확인한다. 이번 조사에서는 추정한 이벤트 스키마를 DB 계약으로 확정하지 않았다.

타임라인은 연속 좌표·모든 클릭·시야 전체·플레이어 의도를 보장하는 텔레메트리나 영상이 아니다. 프레임만으로 정확한 이동 경로, 갱 판단의 의도, 단일 패배 원인을 단정하지 않는다. 근거: [Match-V5 TimelineDto](https://developer.riotgames.com/api-details/match-v5).

## 6. 숙련도·진행 중 경기·리플레이

- **숙련도:** `championLevel`, `championPoints`, `lastPlayTime`, 레벨 진행·시즌 마일스톤 정보가 있다. 전체·특정 챔피언·상위 N개·전체 숙련도 점수 조회 경로가 있다. `milestoneGrades`를 특정 경기의 S/A/B 등급으로 표시하지 않는다. [Mastery 명세](https://developer.riotgames.com/api-details/champion-mastery-v4)
- **진행 중 경기:** Spectator는 기본 경기 정보·팀·챔피언·밴·스펠·룬을 제공한다. 현재 DTO는 익명 참가자의 `puuid`가 null일 수 있음을 명시한다. 숨겨진 플레이어의 신원을 다른 경로로 복원하지 않는다. 이 API를 실시간 KDA·골드·상대 위치 제공 API로 설명하지 않는다. [Spectator 명세](https://developer.riotgames.com/api-details/spectator-v5)
- **리플레이 — 새로 확인:** 현재 Match-V5 명세에는 `/lol/match/v5/matches/by-puuid/{puuid}/replays`가 있으며 `ReplayDTO.total`, `matchFileURLs`의 `.rofl` URL 목록을 정의한다. 따라서 리플레이 관련 API가 없다고 단정하면 안 된다. **실제 키 접근 가능 여부, URL 유효기간·보관·권한·버전 호환·다운로드 비용은 미검증**이며 브라우저 영상 재생이나 데이터 파싱이 자동으로 제공된다는 뜻도 아니다. DB MVP에는 포함하지 않는다. [Replay 명세](https://developer.riotgames.com/api-details/match-v5)
- **사용자 PC 전용 API:** Live Client Data와 Replay API의 `127.0.0.1:2999`는 게임이 실행 중인 사용자 PC의 API다. Vercel 서버에서 해당 사용자의 클라이언트를 조회하는 일반 웹 API가 아니다. 웹 전적 MVP와 분리한다. [Game Client API 안내](https://developer.riotgames.com/docs/lol#game-client-api)

## 7. 공개 전적 서비스 참고 화면과의 대응

| 참고 화면 요소 | 공식 데이터로 가능한가 | BGMS 판단 |
| --- | --- | --- |
| 챔피언·레벨·스펠·룬 | Match 필드 + Data Dragon | **구현됨(2026-10-23, [상세 확장](../plans/2026-10-22-lol-detail-enrichment.md))** |
| KDA·킬 관여율 | 원본 + 계산 | 추가 호출 없는 우선 후보 |
| 가한 피해·받은 피해·비교 막대 | Match 필드 + 동일 기준 계산 | 가한/받은 피해 막대는 **구현됨(2026-10-23, [상세 확장](../plans/2026-10-22-lol-detail-enrichment.md))**. 비교 기준 확장은 여전히 후보 |
| 와드 설치/제거·분당 CS | Match 필드 + 계산 | 지표 정의를 표시하고 적용 |
| 아이템 7칸·팀 총 킬/골드·오브젝트 | Match 참가자/팀 합계 | 참가자 누락과 모드 차이 방어 |
| 참가자 티어 | League 추가 조회 또는 유효한 DB 캐시 | **현재** 랭크다. 10명 일괄 갱신은 최대 10회 추가 호출을 유발하므로 화면마다 실행하지 않음 |
| 경기 당시 티어·경기별 LP 증감 | 당시 저장된 스냅샷 등 필요 | Match만으로 복원 불가 |
| OP Score·MVP·ACE·1~10등 | 해당 서비스 자체 분석 | Riot 제공 값처럼 복제하거나 가짜 수치 생성 금지 |
| 팀 분석·빌드 진행 | 파생 분석·타임라인 검증 필요 | 별도 후속 범위 |

## 8. 정책·데이터 한계

- **확인됨:** Development 키는 비공개 개발용이며 24시간마다 비활성화된다. 공개 서비스에는 Production 승인이 필요하다. RSO는 Production 및 별도 연동 대상이다. [키 안내](https://developer.riotgames.com/docs/portal#api-keys), [RSO](https://developer.riotgames.com/docs/lol#rso-integration)
- **확인됨:** 공식 정책은 MMR/ELO 계산기 같은 대체 실력 랭킹, 게임이 숨긴 플레이어 식별·분석을 금지한다. 사용자 지정 경기의 공개 전적에는 별도 동의/RSO 조건이 있고, 증강 및 아레나 아이템 승률 표시 제한도 있다. 일반 소환사의 협곡 경기와 모드별 정책을 구분한다. [LoL 정책](https://developer.riotgames.com/docs/lol#game-policy)
- **확인됨:** Match 목록 `count`는 0~100, 기본 20이며 `start`는 기본 0이다. 시간 필터는 초 단위다. `startTime` 설명에 2021-06-16 이전 경기의 제약이 있지만, 이것이 그 이후 모든 경기의 영구 가용성을 보장하지는 않는다. [Match 목록 명세](https://developer.riotgames.com/api-details/match-v5)
- **추가 검증 필요:** 이번 문서 검토로 모든 Riot 원본에 적용되는 단일 보관 일수를 확정하지 않았다. 기존 설계의 요약/원본 30일·타임라인 7일은 **BGMS 제안값**이며 Riot이 보장·허용한 기간이라고 인용하지 않는다. 운영 저장 전 적용 약관·승인 조건·삭제 계약을 재확인한다.
- **추가 검증 필요:** API 필드 `challenges`, 종료 판정, 시즌 마일스톤, 특수 모드 수치는 설명이 낡거나 부족할 수 있다. 예를 들어 일부 항복 관련 필드의 설명에 다른 도전과제 설명이 섞여 있어 설명을 그대로 분석 규칙으로 쓰지 않는다.
- **확인됨:** API 키 보유가 계정 소유권 인증은 아니다. 즐겨찾기·검색 기록·RSO 계정 연결은 서로 다른 기능이다.

## 9. Data Dragon과 호출 비용 기준

**확인됨:** 조사 시 공식 `versions.json` 첫 항목과 `realms/kr.json` 버전은 `16.21.1`, 한국 언어는 `ko_KR`다. 정적 자산은 플레이어마다 Riot 키로 재조회하지 않고 패치·언어별로 재사용한다. 게임 클라이언트 버전과 Data Dragon 빌드가 항상 같다고 가정하지 않는다. [버전 목록](https://ddragon.leagueoflegends.com/api/versions.json), [한국 realm](https://ddragon.leagueoflegends.com/realms/kr.json)

현재 검색 캐시가 전부 비었을 때 기본 흐름은 Account 1 + Summoner 1 + League 1 + 경기 ID 1 + 경기 상세 최대 5 = **최대 9 Riot 요청**이다. 정적 CDN 요청은 이 수와 구분한다. 참가자 스펠·룬·레벨·받은 피해·와드·팀 합계를 기존 경기 응답에서 추출하는 것은 추가 Riot 요청 0회다. 타임라인은 경기당 별도 1회, 본인 숙련도는 별도 1회가 필요하며 캐시가 있으면 줄어든다.

제안 우선순위는 **DB 영속 캐시/호출 제한 → 기존 Match 필드로 상세 완성 → 개인 챔피언 집계 → 요청 기반 타임라인 → 근거 기반 코칭**이다. 이번 DB 작업에 위 모든 필드를 한꺼번에 저장하도록 요구하지 않는다. 안정된 저장 버전을 두고 필요한 필드만 후속 마이그레이션으로 추가한다.

## 10. 검증과 인계

공식 문서 응답과 추출 텍스트는 Git 제외 `tmp/lol-api-research/`에 보관한다. 원본은 공개 문서이며 API 키·실계정·경기 데이터가 없다. 근거 링크가 문서 본문에 있고, 임시 파일이 없어도 재조사할 수 있다.

이 문서는 조사 산출물이다. 신규 UI 필드·타임라인·숙련도·리플레이·RSO·AI 기능을 구현하거나 실제 Riot 호출을 실행하지 않았다. DB 구현/격리 검증 상태는 `docs/plans/2026-10-22-lol-persistence-foundation.md`와 `tmp/lol-db-foundation/report.md`를 별도로 따른다.
