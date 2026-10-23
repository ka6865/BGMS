# LoL 5장: 심사용 공개 경로

## 구현 계획과 범위

1. 전적 패널에서 운영 패널 import를 제거하고 관리자 페이지가 슬롯으로 전달한다.
2. 기존 API 검증·오류 처리·DTO를 서버 핸들러로 공유하고 공개 경로에 별도 가드를 둔다.
3. 법적 고지·광고 제외·보관 정책을 반영하고 단위·보안·브라우저 fixture 검증을 수행한다.

## 플래그와 공개 경로

- `LOL_PUBLIC_ENABLED=true`일 때만 `/lol/kr`, `/lol/kr/[riotId]`, `/lol/kr/by-ref/[ref]`, `/api/lol/*`를 연다.
- 값이 없거나 정확히 `true`가 아니면 404. 페이지 직접 실행·metadata도 검사한다.
- `/api/lol/search` POST: 검색, `{ refresh: true }`로 갱신.
- `/api/lol/matches/more` POST: 더보기·실패 경기 재시도.
- `/api/lol/matches/[matchId]` GET: 상세 조회.
- 참가자 ref는 현재 Riot ID를 확인한 뒤 `/lol/kr/<이름>-<태그>`로 307 이동한다.
- 관리자 API의 기존 관리자 가드와 `LOL_DEV_ENABLED`는 그대로 유지한다.
- metadata는 noindex/nofollow. sitemap·robots·메뉴·홈에 추가하지 않는다. 기존 PUBG 경로는 유지한다.

## 호출 제한과 보안

| 범위 | IP당 제한 |
| --- | --- |
| 검색·갱신 | 1분 10회 |
| 더보기·상세·참가자 이동 | 1분 30회 공유 버킷 |

- 초과 시 429, 한국어 안내와 `Retry-After`를 반환한다.
- 서버 인스턴스별 메모리 고정 윈도이며 만료 버킷을 정리하고 최대 10,000개로 제한한다. 다중 인스턴스 합산 제한은 보장하지 않는다.
- 기존 IP 추출 유틸을 재사용하며 무작위 서버 salt로 HMAC 처리한 키만 메모리에 보관한다. IP 원문은 로그에 기록하지 않는다.
- 배포 프록시가 `x-forwarded-for`/`x-real-ip`를 신뢰 가능한 값으로 덮어쓰는지 운영 환경에서 확인한다.
- API 출처는 `isSameOriginLolRequest`로 검사한다. GET의 Origin 생략은 `Sec-Fetch-Site: same-origin`일 때만 보완한다.
- 참가자 이동은 일반 문서 navigation을 허용하고 플래그·IP 제한을 적용한다.
- 갱신 쿨다운 120초·전역 Riot 가드·PUUID 제외 DTO·봉인 ref 계약을 재사용한다.
- 공개 패널 import 그래프에는 운영·수집·계정 삭제·운영 지표 컴포넌트가 없다.

## 법적 고지와 광고

- 제품명은 BGMS. Riot 공식 영문 고지와 한국어 번역을 공통 컴포넌트로 표시한다.
- `/lol`과 하위 경로에서 공통 AdSense 스크립트를 로드하지 않으며 광고 슬롯을 두지 않는다.
- 그 외 경로의 기존 광고 조건을 유지한다.

## 개인정보처리방침·약관

- Riot Games API 출처, Riot ID·PUUID·레벨·아이콘·랭크·경기 기록을 명시한다.
- 검색 계정·본인 경기 요약·랭크는 삭제 요청 전까지, 다른 참가자를 포함한 원문은 7일 TTL, 응답 캐시는 짧은 TTL, 익명 통계는 식별자 없이 보관한다.
- TTL 만료와 실제 정리 실행을 구분한다. 자동 정리 스케줄을 추가하지 않는다.
- 고객센터 1:1 문의로 삭제 요청을 받고 확인 후 계정 데이터를 삭제한다. 커스텀 게임은 수집·표시하지 않는다.
- PUBG 관련 문구는 유지하고 이용약관에 LoL 조회와 Riot 비보증 고지를 추가한다.

## 롤백과 운영자 확인

- 운영 환경에서 `LOL_PUBLIC_ENABLED`를 제거하거나 `false`로 바꾸고 환경 변경을 반영한다. 페이지·API·참가자 이동 모두 404인지 확인한다.
- DB 변경이나 데이터 삭제가 없는 기능 차단이다. 관리자 비공개 도구와 PUBG 경로는 유지된다.
- 메인 담당: 운영 환경 플래그 설정·심사 기간 활성화와 종료 시 비활성화, Riot 키·참가자 ref secret·보관 정책 적용 상태 확인, 배포 환경 smoke 확인.
- 이 작업에서는 운영 DB·환경 변경, 커밋·push·배포, 기존 개발 서버 재시작을 수행하지 않는다.

## 검증 결과 (2026-10-23)

| 검증 | 결과 |
| --- | --- |
| `npm run verify:core` | 종료 0, 오류 0, 기존 lint 경고 47 |
| `npm run verify:lol` | 267 통과, 41 skip |
| `npm run verify:security` | 91 통과 |
| `npm run test:unit` | 388 파일·5,172 테스트 통과, 12 파일·162 테스트 skip |
| `tests/lol-public-access.test.ts` | 신규 14개 통과: off 페이지·metadata·API·ref, DTO, 출처, IP 제한, redirect, 운영 import 제외, 광고·고지 |
| `RUN_LOL_PUBLIC_BROWSER=true npx vitest run tests/lol-public-browser.test.ts` | 신규 5개 통과 |
| `RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-dev-browser.test.ts` | 기존 관리자 fixture 32개 통과 |
| `git diff --check` | 통과 |

- 공개 브라우저 크기: `375x667`, `390x844`, `430x932`, `1440x900`.
- 검색→공개 전적 URL→경기 상세, 양국어 고지, 관리자 전용 요소 부재, 광고 스크립트·슬롯 부재, 가로 넘침 없음과 모바일 429 안내를 확인했다.
- 브라우저 번들 입력 목록에서 `LolOpsPanel`, `LolCollectionPanel`이 없음을 확인했다. 기존 LoL fixture 데이터는 `tests/fixtures/lol/browserScenario.ts`로 옮겨 공유한다.
- 화면 증거: `tmp/lol-public-review/375x667.png`, `390x844.png`, `430x932.png`, `1440x900.png`. 모바일·데스크톱 이미지를 직접 확인했다.
- 기존 `localhost:3000/lol/kr`는 플래그 off에서 HTTP 404를 확인했다. 이후 실제 `/api/lol/search` HTTP smoke는 15초 응답 시간초과로 완료하지 못했다. API off·출처·제한·응답 계약은 단위 테스트로 검증했다.
- 실제 Riot·운영 DB 쓰기·실기기·배포 환경은 검증하지 않았다. 기존 개발 서버를 재시작하지 않았다.
- `.agents/rules/project_rules.md`와 `docs-private/`는 이 작업 폴더에 없다. 제공된 AGENTS 지침, 추적 중인 스킬·구현·계획 문서·테스트를 사용했다.

## 변경 파일

- 공개: `app/lol/layout.tsx`, `app/lol/kr/page.tsx`, `app/lol/kr/[riotId]/page.tsx`, `app/lol/kr/by-ref/[ref]/route.ts`.
- 공개 API: `app/api/lol/search/route.ts`, `app/api/lol/matches/more/route.ts`, `app/api/lol/matches/[matchId]/route.ts`.
- 서버 공유: `lib/lol/publicAccess.server.ts`, `lib/lol/routes.server.ts`, `lib/lol/riotId.ts`.
- 기존 관리자 API: `app/api/admin/lol/search/route.ts`, `app/api/admin/lol/matches/more/route.ts`, `app/api/admin/lol/matches/[matchId]/route.ts`.
- 기존 관리자 페이지: `app/admin/lol/page.tsx`, `app/admin/lol/kr/[riotId]/page.tsx`, `app/admin/lol/kr/by-ref/[ref]/route.ts`.
- UI: `components/lol/LolSearchPanel.tsx`, `components/lol/LolLegalNotice.tsx`, `components/layout/SidebarFooterWrapper.tsx`.
- 정책: `app/privacy/page.tsx`, `app/terms/page.tsx`.
- 테스트: `tests/lol-public-access.test.ts`, `tests/lol-public-browser.test.ts`, `tests/lol-dev-browser.test.ts`, `tests/fixtures/lol/browserScenario.ts`.
- 문서: 이 문서와 `docs/plans/2026-10-23-lol-production-key-readiness.md`.
