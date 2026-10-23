# LoL 관리자 전용 검색 MVP

2026-10-22 기준. `/admin/lol` 안에서 관리자만 한국 서버 Riot ID를 검색한다. 신규 DB/R2/작업 큐, 공개 라우트, AI, 타임라인, RSO, 의존성 추가는 이 초기 MVP 작업의 범위 밖이었다.

> **현재 상태(2026-10-23):** 이 문서의 무저장·메모리 전용 설명은 위 기준일의 초기 기록이며, `LOL_PERSISTENCE_ENABLED`가 off인 메모리 경로에만 그대로 적용된다. 같은 플래그가 on이면 계정·랭크·경기·참가자와 검색/상세 DTO를 서버 DB에 영속 저장한다(R2/작업 큐/공개 라우트/AI는 여전히 미구현). 현재 저장 계약은 [영속 저장 기반](2026-10-22-lol-persistence-foundation.md), [운영 적용 준비](2026-10-22-lol-production-persistence.md)를 본다.

## 실제 계약

- 페이지: `app/admin/lol/page.tsx`는 기존 페이지 가드 뒤 `components/lol/LolSearchPanel.tsx`를 렌더링한다. 내부 세로 스크롤을 사용한다.
- API: 관리자 POST `/api/admin/lol/search`만 검색을 시작한다. 매 요청 현재 관리자 역할과 같은 출처를 확인하고, 입력은 JSON `riotId: "게임이름#태그"` 하나다. Next가 내부 `request.url` host를 정규화할 수 있어 출처의 host·포트는 실제 `Host` 헤더와 비교하고 protocol은 URL에서 확인한다. `x-forwarded-host`는 신뢰하지 않는다.
- Riot 클라이언트: `lib/lol/riotSearch.server.ts`가 고정 host map만 사용하고 `RIOT_API_KEY`를 `X-Riot-Token` 서버 헤더에 전달한다. 리다이렉트 금지, 8초 개별 timeout, 응답 최대 1 MiB, 사용자 ID 길이 검사, 에러 본문/키/PUUID 비노출을 적용한다.
- 요청 흐름: Account-V1 `asia` 1회 → Summoner-V4 `kr` 1회 + League-V4 `kr` 1회 + Match-V5 ID 목록 `asia` 1회 → 경기 상세 `asia` 최대 5회. 초기 검색은 Riot API 최대 9회다. Data Dragon 정적 이미지는 별도 자산 요청이다.
- 식별: 참가자 검색과 경기 참가자 선택은 PUUID로 처리한다. PUUID는 Riot 서버 호출·프로세스 메모리에서만 쓰고 클라이언트 DTO, 경로, 응답, 로그, 문서에 내보내지 않는다. 이 문장은 persistence off 경로의 기록이다. persistence on이면 PUUID는 계정 PK로 DB에도 저장되지만 브라우저 DTO·응답·로그·문서 비노출 계약은 그대로 유지한다.
- 표시: 프로필 아이콘·레벨, 솔로/자유 랭크, 최근 경기 승패·챔피언·KDA·CS·시간·큐 유형. 솔로(420), 자유(440), 무작위 총력전(450) 등을 표시하며 부분 실패·전체 실패·빈 경기 목록을 구분한다.

## 호출 제한과 캐시

- 전역 순차 Riot 요청 간격 1.5초, 검색 동시 실행 최대 2개. 429의 `Retry-After` 동안 해당 Node 프로세스의 후속 호출을 차단한다. 실제 Development Key의 현재 포털 한도가 바뀔 수 있으므로 이 코드는 한도 계약을 대체하지 않는다.
- 계정·프로필·랭크·경기 ID와 최종 검색 결과는 메모리에서 120초, 성공한 경기 상세 JSON은 10분 캐시한다. 프로세스 재시작 시 사라진다.
- 캐시는 최대 100개 항목, 항목당 최대 256 KiB(합계 데이터 상한 약 25 MiB), Riot 응답은 항목당 최대 1 MiB다. 초과 경기 상세는 캐시에 넣지 않는다.
- **로컬 단일 프로세스 한계:** 이 제한·캐시는 프로세스 메모리만 사용한다. Vercel 다중 인스턴스/수평 확장 또는 여러 서버에서 전역 Rate Limit을 보장하지 않는다. 공개·다중 인스턴스 운영 전 중앙 제한기와 공유 캐시를 설계한다.
- **모드별 단위 차이(2026-10-23 추가):** 위 1.5초 간격·검색 동시 2개·120초/10분 캐시는 메모리(persistence off) 모드의 단위다. DB(persistence on) 모드는 전역 동시 Riot request lease 최대 2개·최소 간격 1.5초(DB가 공유하는 상태), UTC 하루 40회 중앙 예산(메모리 모드에는 없음), 검색 DTO 2분·상세 DTO/경기 원문 최대 7일 TTL을 쓴다. "동시 2개"는 메모리 모드에선 검색 작업 수, DB 모드에선 Riot request lease로 서로 다른 대상이라 같은 값으로 취급하지 않는다. 자세한 수치는 [영속 저장 기반](2026-10-22-lol-persistence-foundation.md), [호출 용량 조사](../research/2026-10-22-lol-search-capacity.md)를 본다.
- `.env.local`은 Git 무시 파일이며 로컬에서만 `RIOT_API_KEY`를 지정한다. 키 교체 시 기존 행을 보존하며 값만 교체한다. 개발 서버 시작 환경에 이전 `RIOT_API_KEY`가 있으면 Next의 env 재로드보다 우선할 수 있으므로, 상속된 값을 제거하고 서버를 재시작해 파일에서 읽힌다. Riot의 401/403은 키·권한 오류로 분류하되 키 만료로 단정하지 않는다. [실제 401 오류와 실행 환경 복구 기록](./2026-10-22-lol-search-error-review.md)을 참고한다.

## API 상태와 UI 대응

| 상태 | 화면 동작 |
| --- | --- |
| 400 | Riot ID 형식 안내 |
| 403 | Riot API 키 또는 API 권한 확인 안내 |
| 404 | Riot ID 없음 안내 |
| 429 | `Retry-After`와 재시도 안내, 서버 프로세스 호출 차단 |
| 502/503/504 | API 장애·키 설정·timeout 안내 |
| 상세 일부 실패 | 성공한 경기 표시 + 부분 조회 안내 |
| 상세 전부 실패 | 최근 경기 조회 실패 상태 |
| 경기 ID 0개 | 실제 최근 경기 없음 상태 |

브라우저 검색어는 URL에 넣지 않는다. API와 페이지는 `private, no-store`; 이 작업 당시 사용자 검색 데이터는 DB·파일에 저장하지 않았다(persistence off 경로의 현재 계약도 동일). persistence on이면 계정·랭크·경기·참가자와 DTO는 서버 DB에 저장되며, 브라우저 응답이 `private, no-store`인 점만 유지된다. Data Dragon은 2026-10-22 검증된 `16.21.1`을 사용하고 이미지가 깨지면 기본 아이콘 표시로 대체한다. 페이지 하단에는 Riot 정책의 비후원·상표 고지를 한국어로 표시한다.

## 공식 문서 확인

2026-10-22 확인. 공식 LoL 문서는 Riot ID→PUUID에 Account-V1을 안내하고, Summoner 이름 검색 대신 PUUID 경로 사용을 권고한다. 공식 API 상세 페이지 fragment 문서 URL은 메인 세션이 Python urllib GET으로 HTTP 200을 확인했다. Riot REST endpoint 경로는 공식 reference fragment와 개발자 포털 API 상세를 근거로 한다.

- [Riot LoL 개발 문서](https://developer.riotgames.com/docs/lol)
- [Account-V1](https://developer.riotgames.com/api-details/account-v1)
- [Summoner-V4](https://developer.riotgames.com/api-details/summoner-v4)
- [League-V4](https://developer.riotgames.com/api-details/league-v4)
- [Match-V5](https://developer.riotgames.com/api-details/match-v5)
- [Riot General Policies — 법적 고지·API 보안](https://developer.riotgames.com/policies/general)
- [Riot Developer Portal FAQ — 키 유형·RSO·Production 등록](https://developer.riotgames.com/docs/faqs)
- Data Dragon KR realms endpoint는 확인된 `16.21.1`로 고정한다. API 응답 속 버전은 `https://ddragon.leagueoflegends.com/realms/kr.json`에서 2026-10-22 확인했다.

## 검증 결과(기존 MVP)

## 2026-10-22 경기 상세 및 전적 UI 보완

- 관리자 GET `/api/admin/lol/matches/[matchId]`는 요청마다 관리자 역할을 확인하고 `KR_숫자` 경기 ID만 허용한다. 응답은 `private, no-store`이며 PUUID·원본 Match-V5 JSON을 내보내지 않는다.
- 기존 10분 Match-V5 프로세스 캐시를 재사용한다. 최근 검색 결과에서 캐시가 유지되는 경기의 상세는 Riot 추가 호출 없이 응답하고, 캐시 미스는 해당 고정 `asia` host 경기 endpoint 1회만 요청한다. 256 KiB 초과 원본은 기존 캐시 제한에 따라 캐시에 넣지 않으므로 이후 상세는 미스 1회가 발생한다.
- 상세 참가자는 Riot ID를 표시 이름으로 사용하고, 검색 계정과의 연결은 서버에서 PUUID로 처리한다. Riot ID가 Match-V5 응답에 없으면 `Riot ID 미제공`으로 표시한다. queue 0/`gameType: CUSTOM_GAME`은 이번 관리자 전용 MVP의 지원 범위에서 제외하고 상세도 차단한다. Riot Game Policy는 사용자 지정 경기 기록의 공개 표시와 본인 경기 데이터 접근에 조건을 둔다. 여기서는 그 문구를 모든 사용자 지정 경기 접근의 일반 금지로 해석하지 않으며, Tournament API 설명도 제외 사유로 연결하지 않는다. [Riot LoL Developer API Policy](https://developer.riotgames.com/docs/lol)
- 검색 카드 및 상세는 Data Dragon 검증 버전 `16.21.1` 이미지와 한글 챔피언/아이템명을 사용한다. 서버 프로세스에서 한글 champion/item 정적 JSON을 각각 최대 24시간 캐시하고 로드 실패 시 API의 챔피언 이름 및 빈 아이템명으로 대체한다. 프로세스 캐시는 로컬 단일 프로세스 한계다.
- 검색결과의 최근 5경기에서 전체/솔로/자유/ARAM 필터를 제공한다. 승률과 KDA는 현재 필터에 표시된 경기 집계로 명시하고, 사망 0은 퍼펙트로 표시한다. 상세의 빠진 Riot 수치는 `미제공`으로 표시한다.
- `tests/lol-riot-search.test.ts`는 가드·ID검사·PUUID 미노출·캐시 hit 0회/miss 1회·사용자 지정 경기 차단을, `tests/lol-dev-browser.test.ts`는 가상 검색→상세·두 팀·아이템·피해/CS/시야·필터·4개 뷰포트를 검사한다.

## 검증 범위

2026-10-22 로컬 검증 결과:

| 검사 | 결과 |
| --- | --- |
| Riot mock + LoL 접근/API·페이지 + Bearer·SEO 회귀 | 7개 파일, 66개 테스트 통과 |
| `npm run verify:core` | 통과: ESLint 오류 0개(기존 경고 47개), TypeScript 검사 통과 |
| hydration 브라우저 검색 | 가상 fetch 응답으로 입력·제출·랭크·5개 경기 카드·부분 실패·내부 스크롤 확인. 375×667, 390×844, 430×932, 1440×900 모두 통과 |
| 실제 제품 Riot 검색 클라이언트 | 1회 최대 9개 요청: Account·Summoner·League·Match IDs 각 1개, Match 상세 5개 모두 HTTP 200. 응답 요약은 랭크 2개·경기 5개. 원본 본문·ID는 폐기 |
| 실제 로컬 Next HTTP | 비로그인 페이지는 `/login`으로 307, 상태 API는 401. 실제 관리자 로그인 세션은 검증하지 않음 |

브라우저 fixture는 전부 가상 데이터만 사용하며 실제 회원 결과를 저장하거나 캡처하지 않는다. 실제 API 성공은 Development Key로 한 로컬 실행에 한정되고 운영 가용성·Production 승인·실제 인증 브라우저 검증을 의미하지 않는다. 개발 중 별도 단건/endpoint smoke 요청도 수행됐고, 후속 중복 client 재확인은 출력 요약 전에 중단되어 추가 요청 수를 확정할 수 없다. 실기기·Preview/Production 검증, DB/R2/AI는 미실행이다.
