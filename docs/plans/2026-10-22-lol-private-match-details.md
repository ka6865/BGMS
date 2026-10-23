# LoL 관리자 전용 경기 상세 보완

2026-10-22 기준. 기존 `/admin/lol` 검색·관리자 인증을 유지하고 캐시된 경기 상세, 한국어 챔피언/아이템 정보와 최근 5경기 통계를 표시한다. 경기 카드의 우측 세로 토글과 참가자 Riot ID 검색도 같은 관리자 화면에 연결한다.

> **현재 상태(2026-10-23):** 아래 "10분 프로세스 캐시"는 위 기준일의 초기 기록이며 `LOL_PERSISTENCE_ENABLED`가 off인 메모리 경로에만 적용된다. persistence on이면 경기 원문·참가자는 DB에 최대 7일 저장되고 상세 DTO는 전용 `v2` 캐시 키를 쓴다. 현재 계약은 [영속 저장 기반](2026-10-22-lol-persistence-foundation.md), [상세 확장](2026-10-22-lol-detail-enrichment.md)을 본다.

## 구현

- `GET /api/admin/lol/matches/[matchId]`는 매 요청 관리자 가드 후 `KR_숫자` 형식을 확인하고 `private, no-store`로 필요한 상세 DTO만 반환한다. 검색 계정과 참가자 연결은 서버에서 PUUID로 하고, 화면 표시 이름으로 Riot ID를 쓴다. PUUID/raw Match-V5 응답은 브라우저에 보내지 않는다.
- Match-V5 raw payload는 기존 프로세스 10분 캐시를 재사용한다. 최근 검색 상세 cache hit은 Riot 추가 요청 0회, cache miss는 단일 경기 상세 요청 1회다. 기존 256 KiB 캐시 항목 제한을 넘은 응답은 재사용되지 않는다. (persistence off 경로의 기록. persistence on이면 10분 프로세스 캐시 대신 DB에 원문을 최대 7일 저장하고 재사용하며, DTO·원문 모두 없을 때만 Riot 1회를 수집해 40회 중앙 예산을 소비한다.)
- queue 0/`gameType: CUSTOM_GAME`은 이번 관리자 전용 MVP의 지원 범위에서 제외하고 상세도 차단한다. Riot Game Policy는 사용자 지정 경기 기록의 공개 표시와 본인 경기 데이터 접근에 조건을 두지만, 이 구현의 제외는 해당 정책 문구를 모든 사용자 지정 경기 접근의 일반 금지로 해석한 결과가 아니다. Tournament API 설명은 이 제외의 근거로 사용하지 않는다. [Riot LoL Developer API Policy](https://developer.riotgames.com/docs/lol)
- Data Dragon `16.21.1` Korean champion/item metadata는 서버 프로세스에서 24시간 캐시한다. 챔피언 수치 키를 메타 키와 맞춰 한국어명 및 이미지 식별자를 얻고, 로드 실패는 Riot 챔피언 식별자/아이템 이미지로 fallback한다. 아이템 description은 전달하거나 렌더하지 않는다.
- 검색 패널은 상세에서 teamId 100 블루팀을 항상 위, 200 레드팀을 그 아래에 두고 나머지 teamId는 중립 라벨로 뒤에 표시한다. 각 팀은 참가자 한 명당 한 행인 표로 챔피언/소환사, K/D/A, 챔피언 대상 피해, 시야, CS, 아이템 7칸을 열 정렬한다. 모바일은 챔피언/소환사와 KDA를 첫 줄에, 이름 붙인 나머지 지표와 아이템을 보조 줄에 표시한다. 팀 배경/테두리/배지는 진영과 독립적으로 승리 blue·패배 red로 구분한다. LoL 검색 패널의 본문 폭만 `max-w-6xl`로 넓혔다. 누락된 수치는 `미제공`으로 표시한다.
- 경기 카드 우측 가장자리에 세로 영역을 차지하는 아래/위 chevron 토글을 둔다. 44px 이상 터치 너비, `aria-expanded`, 항상 존재하는 `aria-controls` 대상과 열림 상태별 `aria-label`을 유지한다.
- 상세 참가자 Riot ID를 누르면 같은 `/admin/lol` 검색 패널의 입력값과 검색 대상을 해당 전체 Riot ID로 바꾼다. Riot ID가 없는 참가자는 텍스트로만 표시한다. 검색 중 새 검색 대상 입력과 제출을 허용하고 같은 진행 대상의 중복 요청은 생략하며, 요청 ID로 늦은 검색·상세 응답을 차단한다. 새 검색은 기존 상세 상태를 초기화하고 LoL 패널 자체의 스크롤을 맨 위로 옮긴다.

## 검증 계획

- `npx vitest run tests/lol-riot-search.test.ts tests/lol-dev-page.test.ts tests/lol-dev-access.test.ts tests/lol-dev-status.test.ts tests/lol-dev-browser.test.ts`
- `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-dev-browser.test.ts`: 가상 검색→상세, 양팀 및 지표, 필터, 375×667·390×844·430×932·1440×900.
- `npm run verify:core`
- 실 API 계획은 제품 클라이언트 검색 1회(최대 9 Riot 요청) 후 같은 경기 상세의 cache hit과 추가 Riot 요청 0회를 확인하는 것이다. 실제 수행 결과는 계획과 분리해 `.superpowers/sdd/2026-10-22-lol-detail-orca-report.md`에 기록한다. 키·사용자 ID·응답 본문은 로그/보고서에 남기지 않는다.

## 기존 상세 기능 검증 결과

- 최신 상하 표 레이아웃과 승리 blue/패배 red 적용 후 최종 실행 결과는 브라우저 5/5, 페이지 10/10, `verify:core` 통과(ESLint 오류 0, TypeScript 오류 0, 기존 ESLint 경고 47개)다. 375×667·390×844·430×932·1440×900에서 teamId 순서/bbox, 계산된 승패 배경, 팀별 5행, 표 열 정렬, 모바일 보조지표, overflow, 검색 1회 및 경합/ID 불일치 차단을 확인했다. 최신 스크린샷과 이전 실행 기록을 보존한 보고서는 `tmp/lol-dev-search/team-layout-report.md`에 있다.

서버 메모리 캐시와 Riot API 호출 제한은 한 프로세스에만 적용된다(persistence off 경로; on이면 DB 중앙 캐시·예산·lease를 쓴다 — [영속 저장 기반](2026-10-22-lol-persistence-foundation.md)). 브라우저 확인은 Puppeteer 격리 fixture의 뷰포트 렌더링 결과이며 실제 모바일 기기/Safari 검증은 아니다. 이 변경 당시는 PUBG/Auth/DB/R2, 의존성, 운영 설정, 배포를 다루지 않았다.

## 2026-10-22 관리자 검색 이동 UI 검증

- 변경 파일: `components/lol/LolSearchPanel.tsx`, `tests/lol-dev-browser.test.ts`, 이 문서. `tests/lol-dev-page.test.ts`의 페이지/권한 테스트는 변경하지 않았다. `tmp/lol-ui-navigation/report.md`는 실행 내역과 캡처 목록이다.
- 실제 컴포넌트 브라우저 fixture 및 페이지 테스트: `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-dev-page.test.ts tests/lol-dev-browser.test.ts --testTimeout=30000 --hookTimeout=30000` — 2개 파일, 16/16 통과. 우측 정렬과 터치 영역/ARIA, 열기·닫기, Riot ID 전체값 요청, 상세 초기화, 미제공 이름 비활성 표시, 검색 중 중복 방지와 늦은 이전 결과 무시, 외부 `<main>`과 실제 스크롤 부모를 확인했다.
- 공통 검사: `npm run verify:core` — ESLint 오류 0, TypeScript 오류 0, 저장소 기존 lint warning 47개.
- 375×667, 390×844, 430×932, 1440×900 캡처: `tmp/lol-dev-search/{375x667,390x844,430x932,1440x900}.png`; 검색 응답 경합 화면: `tmp/lol-dev-search/search-race.png`. 네 뷰포트에서 가로 넘침, 상하 팀 표와 승리 파랑/패배 빨강을 확인했다.
- React TSX 점검: hook/ref는 이벤트 기반 스크롤과 요청 상태에만 쓰고, 네이티브 버튼 키보드 동작과 접근성 이름을 유지하며, 아이콘을 장식용으로 숨겼다. 새 추상화·의존성은 없다.
- 격리된 Puppeteer fixture만 사용했다. 개인 Chrome 세션, 실제 Riot 호출, 실제 모바일 기기/Safari, 운영 서버/DB/R2 검증은 실행하지 않았다.
