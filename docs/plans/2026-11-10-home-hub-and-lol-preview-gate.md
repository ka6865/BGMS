# 홈 허브와 LoL 심사용 미리보기 게이트 설계

작성일: 2026-11-10
상태: PR 1(LoL 게이트)과 PR 2(홈 허브) 구현

## 목표

1. `bgms.kr` 첫 화면을 에란겔 지도가 아닌 게임 선택 허브로 바꾼다. 배틀그라운드와 리그 오브 레전드로 들어가는 구역을 둔다.
2. Riot 운영 키 승인 전까지 Riot API로 얻은 데이터를 쓰는 LoL 화면은 "개발 중" 화면으로 대신 보여 준다.
3. "테스트하기" 버튼에서 운영자가 정한 비밀번호를 입력하면 잠긴 화면을 그대로 쓸 수 있게 한다. Riot 신청서에는 테스트 URL과 비밀번호를 적어 심사를 받는다.
4. 작업은 PR 두 개로 나눈다. PR 1은 LoL 게이트, PR 2는 홈 허브다. 홈의 LoL 카드가 게이트 화면을 가리키므로 PR 1을 먼저 배포한다.

## 현재 상태

- `app/page.tsx`는 루트 접속을 `/maps/erangel`로 308 영구 리다이렉트한다. `?tab=` 레거시 주소도 이곳에서 처리한다.
- `GlobalHeader` 로고는 `/`, 지도 메뉴는 `/?tab=Erangel` 형태로 연결되어 루트 리다이렉트에 기대고 있다.
- `/lol` 전체는 `LOL_PUBLIC_ENABLED=true`로 누구나 URL로 열 수 있다. BGMS 메뉴에는 링크가 없고 `app/lol/layout.tsx`가 noindex를 건다.
- 운영 환경의 `RIOT_API_KEY`는 개발 키다. 개발 키 데이터를 일반 공개 화면에 쓰는 상태를 이번 작업으로 정리한다.

## 공개·잠금 구분

기준은 "Riot API(개발 키)로 얻은 데이터인가"이다. Riot이 공개 배포하는 Data Dragon·CommunityDragon 정적 자료(챔피언 이름·이미지·아이템 정보)는 API 키가 필요 없어 공개 쪽으로 본다.

| 경로 | 데이터 출처 | 처리 |
| --- | --- | --- |
| `/lol/kr` 전적 검색, `/lol/kr/[riotId]`, `/lol/kr/[riotId]/live`, `/lol/kr/by-ref/[ref]` | Riot API | 잠금 |
| `/lol/kr/champions`, `/lol/kr/champions/[champion]` | Riot 경기 수집 통계(`lol_stat_*`) | 잠금 |
| `/lol/kr/ladder`, `/lol/kr/masters` | Riot API·수집 데이터 | 잠금 |
| `/lol/kr/status`, 헤더 아래 `LolStatusBanner` | Riot status API | 잠금 |
| `/api/lol/search`, `suggest`, `matches/**`, `live` | Riot API | 잠금(인증 없으면 401) |
| `/lol/kr/aram-mayhem` 전체 탭 | 증강 도감(CommunityDragon), 외부 공개 자료, Data Dragon | 공개 |
| `/api/lol/mayhem/**`, `/api/lol/augment-icons/**` | 위와 같음 | 공개 |

증바람 화면은 현재 코드 기준으로 Riot API 키를 쓰지 않는다. 앞으로 증바람에 Riot 수집 통계를 섞으면 그 부분은 잠금 대상으로 옮긴다.

## PR 1: LoL 미리보기 게이트

### 환경 변수

| 이름 | 의미 |
| --- | --- |
| `LOL_RIOT_DATA_PUBLIC` | `true`일 때만 잠금 대상을 비밀번호 없이 공개한다. 운영 키 승인 후 켠다. 값이 없으면 잠금(안전한 기본값). |
| `LOL_PREVIEW_PASSWORD` | 테스트하기 비밀번호. 비어 있으면 잠금 화면에 입력창을 보이지 않는다. |

쿠키 서명 키는 새로 만들지 않고 `LOL_PARTICIPANT_REF_SECRET`에서 HKDF로 용도별 키를 파생한다(`publicAccess.server.ts`의 rate limit 키와 같은 방식).

### 인증 흐름

1. 잠긴 페이지는 404 대신 "개발 중" 화면을 보여 준다. 기능 소개 한 줄, 운영 키 심사 중이라는 안내, "테스트하기" 버튼이 있다.
2. 버튼을 누르면 비밀번호 입력 폼이 열린다. 입력값은 `POST /api/lol/preview`로 보낸다.
3. 서버는 same-origin을 확인하고, `consume_lol_public_rate_limit`에 `preview` 종류(분당 5회)로 시도 횟수를 제한한다. 비밀번호는 HMAC 결과를 `timingSafeEqual`로 비교한다.
4. 맞으면 `bgms_lol_preview` 쿠키를 발급한다. 값은 `만료시각.서명`이고, 서명 입력에 비밀번호 해시를 넣어 비밀번호를 바꾸면 기존 쿠키가 모두 무효가 된다. 속성은 `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, 7일 만료다.
5. 원래 보던 경로로 돌아간다. 돌아갈 경로는 `/lol/`로 시작하는 내부 경로만 허용한다.

### 코드 변경 지점

- 잠금은 `proxy.ts` 한 곳에서 건다. 페이지마다 검사를 넣으면 새 경로를 빠뜨리기 쉬워서, `/lol/kr/**`와 `/api/lol/**`는 공개 목록에 없으면 기본으로 잠근다.
  - 공개 목록: `/lol/kr/aram-mayhem`, `/lol/kr/preview`, `/api/lol/mayhem/**`, `/api/lol/augment-icons/**`, `/api/lol/preview`
  - 잠긴 화면은 `/lol/kr/preview?next=<원래 경로>`로 rewrite한다. 주소창은 원래 경로 그대로다.
  - 잠긴 API는 `401 { reasonCode: "lol_preview_required" }`를 반환한다.
- `lib/lol/previewAccess.ts`: 잠금 경로 판정, 쿠키 발급·검증, 비밀번호 비교, 돌아갈 경로 검증.
- `app/api/lol/preview/route.ts`: 비밀번호 확인과 쿠키 발급. `guardLolPublicRequest`에 `preview` 종류(분당 5회)를 추가했다.
- `app/lol/kr/preview/page.tsx`, `components/lol/LolPreviewGate.tsx`: 개발 중 안내, 증바람 바로가기, 테스트하기 폼. 이미 쿠키가 있으면 원래 경로로 보낸다.
- `components/lol/LolStatusBanner.tsx`: 권한이 없으면 공개 화면에서 렌더링하지 않는다. 관리자 화면은 그대로다.
- `components/lol/LolHeader.tsx`: 운영 키 승인 전에는 증바람을 뺀 메뉴에 "개발 중" 표시를 붙인다. 로고 링크는 `/lol/kr` 그대로 두어 개발 중 화면으로 이어진다.

### 검증

- 단위 테스트: 쿠키 서명·만료·비밀번호 변경 시 무효화, 돌아갈 경로 검증, 잠금 API의 401, 공개 플래그가 켜졌을 때의 통과, 비밀번호 미설정 시 입력창 숨김.
- 기존 `tests/lol-*.test.ts`를 새 게이트에 맞게 고친다. `npm run verify:core`, `npm run verify:lol`, `npm run verify:security`.
- 브라우저: 잠긴 화면, 비밀번호 실패와 성공, 증바람 공개 화면. 375x667, 390x844, 430x932, 데스크톱.

## PR 2: 홈 허브

### 라우팅

- `app/page.tsx`의 `?tab=` 레거시 리다이렉트는 유지한다. 쿼리가 없는 루트 접속만 허브 페이지를 렌더링한다.
- `GlobalHeader` 지도 메뉴의 `/?tab=` 링크를 `/maps/<map>`으로 바로 바꿔, 루트를 거치는 리다이렉트를 없앤다.
- 이미 루트를 방문한 브라우저는 기존 308을 캐시해 한동안 에란겔로 이동할 수 있다. 새 방문자와 검색엔진에는 바로 허브가 보인다.

### 화면 구성 (데스크톱)

```
┌──────────────────────── 공통 헤더 ────────────────────────┐
│ 소식 배너: 최신 소식 2개 (예: 증바람 26.22 자료 갱신, 배그 패치) │
├───────────────────────────────┬──────────────────────────┤
│ [배틀그라운드 카드]             │ 최근 소식                 │
│  지도 · AI 전적 · 랭킹 · 무기    │  공지 게시글              │
│  전적 빠른 검색창               │  배그 공식 패치노트         │
│ [리그 오브 레전드 카드]          │  증바람 데이터 갱신         │
│  증바람 증강(공개)              │                          │
│  전적 검색 · 챔피언 (개발 중)    │                          │
└───────────────────────────────┴──────────────────────────┘
```

- 게임은 두 개라 작은 타일 격자 대신 큰 카드 두 장으로 구성한다. 모바일에서는 배너, 카드, 소식 순서의 한 열이다.
- 게임사 공식 로고나 키아트는 쓰지 않는다. 게임 이름 텍스트와 BGMS 색상(배그는 기존 노랑, LoL은 `/lol` 헤더의 호박색)으로 만든다.
- 홈에는 처음에 광고를 넣지 않는다. 소식·검색 영역이 자리 잡은 뒤 광고 하나부터 검토한다.
- 최근 소식은 기존 데이터만 쓴다. 최근 30일 안의 게시판 공지(`posts.is_notice`, 최대 3개)와 증바람 최근 공개본(`lol_mayhem_dataset_publications.published_at`)을 먼저 담고, 남은 자리를 공지가 아닌 최신 게시글로 채워 최대 6개를 날짜순으로 보여 준다. 게시글 배지는 게시판 분류다. 배그 패치노트는 공지 게시글로 올라오므로 따로 모으지 않는다. 출처별로 조회가 실패하면 그 항목만 빠지고, 모두 실패하면 소식 구역을 숨긴다.
- LoL 카드 하단에 Riot 법적 고지(영문)를 둔다.
- 루트는 지도 레이아웃이 아닌 일반 페이지 레이아웃(공통 푸터 포함)이고, 광고 스크립트를 싣지 않는다.
- 리플레이 닫기와 지도 메뉴처럼 루트를 거쳐 지도로 가던 이동은 `/maps/<map>`으로 바로 보낸다.

### SEO

- 루트에 title·description·canonical을 넣고, sitemap에 `/`를 추가한다. 증바람 색인은 아직 열지 않는다(미결정).
- 잠금 대상 LoL 경로는 계속 noindex다.

### 검증

- `tests/home-hub.test.ts`: 루트 렌더링, 레거시 `?tab=` 이동, 개발 중 표시, 소식 조회 실패.
- `npm run verify:core`, `npm run test:unit`, 브라우저 4개 뷰포트.

## Riot 신청서 문구 (PR 1 배포 후 수정)

신청서 설명에 아래 내용을 추가한다. 비밀번호는 신청서에만 적고 저장소와 문서에는 남기지 않는다.

> Test access: Riot API-based features are hidden from the public while the application is under review. Visit https://bgms.kr/lol/kr, click "테스트하기 (Test)", and enter the password: `<password>`. Access lasts 7 days per browser.

## 결정 사항

- 미리보기 쿠키는 7일 유지한다.
- 모바일 하단 메뉴에는 홈 버튼을 추가하지 않는다. 홈 이동은 로고로 한다.

## 미결정 사항

- 증바람 페이지 색인을 PR 2에서 바로 열지
- 증바람 화면은 외부 공개 자료를 가공해 보여 준다. 메인 메뉴로 노출 범위를 넓히기 전에 각 출처의 이용 조건을 확인할지
