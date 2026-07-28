# UI 이모지 대체 설계

## 목표

프로젝트 전반의 화면 노출 이모지를 SVG 기반 아이콘과 React 아이콘 컴포넌트로 교체한다. 사용자가 보는 버튼, 탭, 카드 제목, 상태 배지, 토스트, 관리자 화면, Open Graph 이미지에서 텍스트 이모지 사용을 줄여 BGMS UI가 더 제품답고 일관되게 보이도록 한다.

## 범위

대상은 `app/**/*.tsx`, `components/**/*.tsx`의 사용자 화면, 관리자 화면, 토스트, 동적 HTML 문자열, Open Graph 이미지이다. 서버 로그, 개발 스크립트 로그, 주석처럼 사용자 화면에 직접 노출되지 않는 이모지는 이번 작업의 필수 범위에서 제외한다.

## 교체 원칙

텍스트 앞에 붙은 장식 이모지는 `lucide-react` 아이콘으로 교체한다. 상태 의미가 있는 `성공`, `오류`, `경고`, `로딩`, `삭제`, `저장`은 `CheckCircle2`, `XCircle`, `AlertTriangle`, `Loader2`, `Trash2`, `Save` 계열로 통일한다.

PUBG 도메인 아이콘은 lucide 아이콘을 우선 사용한다. `차량`, `지도`, `전투`, `무기`, `팀`, `랭킹`, `상자`, `배낭`은 각각 `Car`, `Map`, `Swords` 또는 `Skull`, `Crosshair`, `Users`, `Trophy`, `Package`, `Briefcase` 계열로 매핑한다. lucide 표현이 부족한 지도 마커나 Leaflet 마커는 기존 `ICON_LIBRARY`와 인라인 SVG를 사용한다.

표정 이모지처럼 감정 톤이 강한 요소는 텍스트 라벨과 중립적인 아이콘으로 바꾼다. 예를 들어 `😊 다정한 맛`은 `ShieldCheck` 또는 `HeartHandshake`와 함께 `다정한 맛`으로, `🔥 매운맛`은 `Flame` 아이콘과 함께 `매운맛`으로 표시한다.

## 공통 컴포넌트

`components/common/BgmsIcon.tsx`를 추가한다. 이 컴포넌트는 아이콘 이름, 크기, 클래스명을 받아 lucide 아이콘을 렌더링한다. 화면마다 직접 lucide import를 늘리는 대신 자주 쓰는 의미 아이콘을 한 곳에서 매핑한다.

`components/common/InlineIconLabel.tsx`를 추가한다. 문자열 안에 이모지를 넣던 패턴을 `InlineIconLabel`로 바꿔 아이콘과 텍스트 정렬, 간격, 줄바꿈을 일관되게 만든다.

## 파일별 변경 방향

`components/common`, `components/Sidebar.tsx`, `components/ads/AdSenseBanner.tsx`에서는 공통 네비게이션, 토스트, 광고 대체 상태에 보이는 이모지를 아이콘 컴포넌트로 바꾼다.

`components/board`, `components/BoardWrite.tsx`에서는 공지, 이미지, 디스코드, 클랜 정보, AI 요약 HTML에서 보이는 이모지를 제거한다. 동적 HTML은 React 컴포넌트를 직접 넣기 어렵기 때문에 텍스트 이모지 대신 작은 인라인 SVG 문자열 또는 이모지 없는 구조로 정리한다.

`components/stat`에서는 전적 검색, AI 요약, 매치 카드, 스쿼드 분석, 지도 정체성 카드, 타임라인, 스파이더 차트의 이모지를 아이콘 컴포넌트로 바꾼다. 뱃지와 티어 표현은 의미가 유지되도록 `Trophy`, `Shield`, `Flame`, `Target`, `Zap` 등으로 매핑한다.

`components/map`에서는 지도 안내문, 리포트 폼, 킬피드, 텔레메트리 플레이어, Leaflet 마커 HTML의 이모지를 SVG 또는 lucide 기반 마커로 바꾼다. Leaflet `divIcon` 문자열은 React 컴포넌트가 들어가지 않으므로 SVG 문자열을 사용한다.

`components/admin`과 `app/admin`에서는 관리자 탭, 대시보드 카드, 위험 버튼, 상태 배지, 저장/동기화 버튼의 이모지를 아이콘 컴포넌트로 바꾼다. 위험 동작은 아이콘만 남기지 않고 기존 텍스트 설명을 유지한다.

`app/rankings`, `app/weapons`, `app/crates`, `app/backpack`, `app/stats/battle`에서는 화면 제목, 빈 상태, CTA, 카드 라벨, 버튼의 이모지를 아이콘 컴포넌트로 교체한다.

`app/**/opengraph-image.tsx`와 `app/api/og/**/*.tsx`에서는 이미지 생성 런타임 호환성을 확인한 뒤 텍스트 이모지 대신 단순한 벡터 도형 또는 이모지 없는 라벨 조합으로 바꾼다.

## 검증

정적 검색으로 `app`, `components` 내 `.tsx` 화면 노출 이모지 잔존 여부를 확인한다. 이후 `npm run verify:core`를 실행한다.

UI 변경 범위가 넓으므로 모바일 QA는 최소 `/stats`, `/maps/erangel`, `/stats/battle`, `/rankings`, `/admin` 후보를 확인한다. 모바일 기준은 `375x667`, `390x844`, `430x932`이며 텍스트 겹침, 버튼 줄바꿈, 하단 내비게이션 간섭을 확인한다.
