# 관리자 유저 관제 센터 (Admin User Command Center) 스펙

## 1. 개요 (Overview)
관리자 페이지(`GameDataEditor`) 내 기존 '유저 관리' 탭을 200여 명 이상의 전체 회원 이용 현황과 개별 회원의 최근 7일간 서비스 이용 동선을 한눈에 파악하고 즉시 조치할 수 있는 **'유저 관제 센터(User Command Center)'** 화면으로 리모델링합니다.

## 2. 목표 (Goals)
- **전체 회원 관제 한눈에 파악**: 유저 200명의 접속 현황, 7일간 활성율, 주요 이용 메뉴, 헤비 검색 유저를 3초 만에 파악하는 상단 관제 바 구축.
- **다양한 정렬 및 조건 필터링**: `최근 활동순`, `7일 사용량순`, `전적 검색 다빈도순`, `관제 대상 회원` 기준 정렬 및 검색 기능 제공.
- **목록 인라인 요약 뱃지**: 회원을 일일이 클릭하지 않아도 카드/목록상에서 7일간의 주요 액션 요약(예: `검색 18회`, `3D지도 4회`, `AI분석 2회`) 노출.
- **사이드 스플릿 상세 타임라인 (Split View)**: 회원 클릭 시 우측 슬라이드 패널로 최근 7일간의 일시별 행동 타임라인(검색 닉네임, 방문 페이지, 작성 글 등)을 한글 직관 표기로 제공하고 관리 조치 지원.

## 3. 데이터 흐름 및 API 스펙 (Data Flow & API)

### 3.1 `GET /api/admin/users?windowDays=7`
기존 `Auth users` + `profiles` 조회에 더해 최근 7일간의 `analytics_events`를 서버 측에서 단 1회 쿼리하여 회원별로 집계·결합합니다.

#### 데이터 응답 구조
- `accounts`: 전체 회원, 프로필 연결 회원, 관리자 수, 누락/유령 계정 수
- `metrics`: 7일 활성 회원 수, 최다 전적 검색 유저 Top 3, 인기 방문 탭 Top 3
- `users`: 유저 목록 배열
  - `id`: 유저 UUID
  - `nickname`, `email`, `role`, `pubg_nickname`, `pubg_platform`, `provider`, `created_at`, `last_sign_in_at`, `updated_at`
  - `is_missing_profile`, `is_orphan_profile`
  - `activity7d`:
    - `totalEvents`: 7일간 발생시킨 총 이벤트 수
    - `lastEventAt`: 최근 이벤트 발생 시각
    - `statsSearchCount`: 전적 검색 횟수
    - `topPages`: 가장 많이 방문한 페이지 Top 3
    - `summaryBadges`: 주요 요약 뱃지 배열 (예: `["전적 검색 18회", "3D 지도 4회"]`)
    - `events`: 최근 7일간 발생한 주요 이벤트 배열 (날짜, 시각, 이벤트명, 한글설명, 탭경로, 검색대상닉네임 등)

### 3.2 `POST /api/admin/users` & `DELETE /api/admin/users`
- 기존 회원 역할(`role`), PUBG 닉네임/플랫폼 수동 수정, 프로필 일괄 복구(`sync`), 회원 강제 탈퇴 기능 유지.

## 4. UI 컴포넌트 설계 (UI Components Design)

### 4.1 `components/admin/AdminUserCommandCenter.tsx` (신규 전용 관제 컴포넌트)
1. **상단 관제 메트릭스 바 (Header Metrics Bar)**
   - 7일 활성 회원율 (`XX명 / 전체 200명`)
   - 최다 전적 검색 회원 Top 3 (`닉네임 (N회)`)
   - 인기 방문 탭 Top 3 (`전적 검색`, `3D 지도`, `상자깡` 등)
   - 계정 상태 현황 (`카카오 N명 / 스팀 N명 / 이메일 N명 / 점검 대상 N명`)

2. **검색 & 스마트 정렬 탭 (Filter & Sort Bar)**
   - 닉네임 / PUBG 닉네임 / 이메일 / 유저 ID 실시간 검색창
   - 정렬 선택: `최근 활동순` (default), `7일 사용량순`, `검색 다빈도순`, `관제/점검 대상 우선`
   - 빠른 구분 필터: `전체`, `일반 회원`, `관리자`, `프로필 누락/유령`

3. **관제 유저 그리드/목록 카드 (User Grid/List)**
   - 각 회원 카드에 기본 프로필, 가입일, 최근 접속 시각, 소셜 뱃지 표시
   - **7일 주요 행동 요약 뱃지** (예: `검색 18회`, `3D지도 4회`) 직관적 표시

4. **우측 사이드 스플릿 패널 (Side-Split Activity Timeline)**
   - 회원 선택 시 오른쪽에서 400px 레이어 패널 슬라이드 오픈
   - **상세 7일 활동 타임라인**: 날짜별(오늘, 어제, 8/10 등) 그룹화되어 아이콘 + 한글 설명으로 표기 (예: `03:20 · 론도 전적 검색 (kangheesung_)`, `03:22 · 3D 지도 탭 방문`)
   - **회원 관리 컨트롤**: 권한(Admin/User) 토글, PUBG 닉네임 수동 입력, 회원 강제 삭제 버튼 제공

## 5. 성능 및 안전성 (Performance & Security)
- **Fast Server-side Aggregation**: 10,000건의 이벤트 로그도 Node.js Map 집계로 15ms 이내 처리.
- **클라이언트 0초 피드백**: 상세 타임라인 데이터가 첫 로딩 시 함께 내려오므로 회원 클릭 시 네트워크 지연 없이 0초 즉시 슬라이드 패널 오픈.
- **보안 통제**: Supabase Auth Admin Service Role 및 관리자 세션 사전 검증 필수.
