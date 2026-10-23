# LoL 상세 전적 정보 확장

2026-10-22 기준. 관리자 전용 상세 화면에 Match-V5 참가자의 챔피언 레벨, 두 소환사 주문, 핵심 룬과 주·보조 룬 트리를 추가했다. 서버는 기존 저장 원문 `lol_matches.request_json`을 재사용하며 참가자의 계정 소환사 레벨과 구분한다. 정적 라벨/아이콘은 Data Dragon `summoner.json`과 `runesReforged.json`에서 읽고 기존 24시간 서버 캐시에 둔다. 정적 데이터가 없으면 두 주문 슬롯과 룬에 `미제공`을 표시하거나 원본 ID를 표시한다. 주문 `key`와 숫자 ID를 매핑하고, 룬 아이콘은 버전이 없는 `/cdn/img/{icon}` 경로를 쓴다.

챔피언 대상 피해(`totalDamageDealtToChampions`)와 받은 피해(`totalDamageTaken`)는 한국어 라벨, 천 단위 숫자, 가로 막대로 표시한다. 막대 비율은 같은 경기의 모든 팀 참가자 중 해당 지표 최댓값으로 각각 계산한다. 0은 숫자 0과 빈 막대로, null·비유한 수·음수는 `미제공`으로 처리한다.

상세 DTO 캐시 키에만 전용 `v2`를 추가해 `match:v1:<platform>:<route>:<Data Dragon 버전>:v2:<matchId>` 형태로 저장한다. 캐시 행의 `data_version`에는 계속 Data Dragon 버전을 기록한다. 검색 DTO와 캐시 키, Match-V5 원문 캐시 및 Riot 수집 경로는 바꾸지 않았다.

## 검증

- `npx vitest run tests/lol-riot-search.test.ts tests/lol-dev-page.test.ts tests/lol-dev-access.test.ts tests/lol-dev-status.test.ts --testTimeout=30000`: 4개 파일, 84개 통과. 필드 매핑, 레벨 18 초과, 미제공/잘못된 수치, 상세 캐시 버전 분리, 저장 원문 재사용과 Riot 0회 호출, 정적자료 로딩 경합을 확인했다.
- `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-dev-browser.test.ts --testTimeout=30000 --hookTimeout=90000`: 6개 통과. 검색/상대 검색 회귀, 모든 팀 공통 피해 정규화, 아이템 7칸, 넘침과 외부 이미지 fixture를 확인했다.
- `npm run verify:core`: 통과. ESLint 오류 0개, 경고 47개, TypeScript 오류 0개.
- 실제 공개 Data Dragon 정적 파일 확인: 버전 고정 spell PNG 및 버전 없는 rune PNG가 각각 HTTP 200이었다. 브라우저 화면은 외부 이미지 다운로드를 fixture PNG 대신 합성 SVG로 대체한 격리 캡처다.
- 격리 fixture 스크린샷: `tmp/lol-detail-enrichment/{375x667,390x844,430x932,1440x900}.png`. viewport 렌더 결과이며 실기기/Safari 확인은 아니다. Riot API와 운영 DB에는 연결하지 않았다.

## UI 정렬 작업 기록

- 참가자 행에 고정 챔피언 이미지 슬롯, 잘리는 이름 칸, 챔피언명/레벨 칸, 주문 2칸과 룬 3칸을 배치했다. 모바일 K/D/A 열 폭도 고정해 팀과 참가자별 아이콘 시작점이 같도록 했다.
- `tests/lol-dev-browser.test.ts`에서 10명 슬롯 좌표(1px 허용), 누락 아이콘/이름 fallback, 긴 챔피언명과 레벨 표시, 검색/상세 및 가로 넘침을 검사했다. 브라우저 6개 테스트 통과, `npm run verify:core` 통과(ESLint 오류 0개·기존 경고 47개, TypeScript 오류 0개).
- 캡처: `tmp/lol-detail-alignment/{375x667,390x844,430x932,1440x900}.png`. 뷰포트 확인이며 실기기 검증은 아니다.
