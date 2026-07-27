# 🗺️ BGMS (BattleGrounds Management System)

### 배틀그라운드 전술의 시작, BGMS.kr

[![BGMS Website](https://img.shields.io/badge/Website-bgms.kr-F2A900?style=for-the-badge&logo=google-chrome&logoColor=white)](https://bgms.kr)
[![Discord Support](https://img.shields.io/badge/Discord-Join%20Us-7289DA?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/your-link)

---

## 🚀 사이트 바로가기
**서비스 도메인:** [https://bgms.kr](https://bgms.kr)  
*배틀그라운드의 모든 맵 정보와 AI 분석을 한곳에서 확인하세요.*

---

## ✨ 주요 기능 및 사용법

### 1. 필터링된 인터랙티브 전술 지도
*   **차량 및 아이템 스폰 확인**: 사이드바의 체크박스를 통해 **차고지, 고정 차량, 보트, 글라이더, 비밀 열쇠** 등의 위치를 지도에 표시하거나 숨길 수 있습니다.
*   **실시간 제보 시스템**: 지도에서 마우스 우클릭 또는 '차량 제보' 도구를 사용하여 새로운 차량 위치를 커뮤니티에 공유할 수 있습니다.

### 2. 정밀 전술 도구 (Map Tools)
*   **박격포 계산기**: 내 위치와 타겟 지점을 찍으면 정확한 거리와 발사각을 계산해 줍니다. 
*   **비행기 경로 스캔**: 비행기 경로를 그리드에 투사하고, 경로 주변 1km 내의 주요 차량 스폰 지점을 한눈에 확인하여 낙하 지점을 결정하세요.
*   **그리드망**: 1km/100m 단위의 그리드를 활성화하여 정밀한 위치 브리핑이 가능합니다.

### 3. AI 기반 인텔리전스
*   **AI 패치노트 요약**: 복잡한 공식 패치노트를 Google Gemini AI가 핵심만 요약해 드립니다. 바쁜 게이머를 위해 30초 내에 패치 내용을 파악할 수 있게 돕습니다.
*   **전적 분석 및 AI 브리핑**: 플레이어의 매치 데이터를 분석하여 교전 성향과 개선점을 AI가 리포트 형식으로 제공합니다.

### 4. 전적 검색 및 통계
*   **플레이어 검색**: 닉네임 검색을 통해 시즌 스탯 및 최근 매치 결과, 상세 딜량 수치를 확인할 수 있습니다.
*   **사용자 메뉴**: 로그인 후 나만의 즐겨찾기 맵 설정 및 활동 내역을 관리할 수 있습니다.

---

## 📱 모바일 앱 이용 안내
BGMS는 웹브라우저뿐만 아니라 모바일 환경에서도 최적의 경험을 제공합니다.
*   **하이브리드 앱 지원**: iOS 및 Android 앱을 통해 언제 어디서나 전술 지도를 확인하세요.
*   **모바일 최적화 UI**: 모바일에서는 하단 시트와 터치 친화적 필터 UI를 통해 한 손으로 조작이 가능합니다.

---

## 🤝 커뮤니티 및 게시판
*   **자유 게시판**: 다른 유저들과 전술을 공유하고 매치에 대해 토론하세요.
*   **공지사항**: 실시간으로 업데이트되는 패치 소식과 사이트 점검 안내를 확인하세요.

---

## 🛠️ 기술 스택 (Tech Stack)

### Frontend
- **Framework**: Next.js 16 (App Router)
- **Library**: React 19, React-Leaflet, Lucide React
- **Styling**: Tailwind CSS v4, CSS Modules

### Backend & Data
- **Database / Auth**: Supabase (PostgreSQL)
- **AI**: Google Generative AI (Gemini 2.5-Flash & v3.1)
- **Infra**: Vercel (Deployment), GitHub Actions (Cron Jobs)

### Mobile & Tools
- **Mobile**: Capacitor v8 (Hybrid)
- **State Management**: React 19 Hooks & Server Actions

---

## 🧪 개발 및 테스트 기준

- `tests/**/*.test.ts`: Vitest 기반 서버/API/순수 로직 테스트입니다.
- `__tests__/**/*.test.tsx`: Jest/jsdom 기반 UI 테스트입니다.
- 공통 검증은 `npx tsc --noEmit`, `npm run lint`, 관련 Vitest/Jest 테스트 순서로 수행합니다.
- 공유 타입은 `types/`에 두고, `lib`가 `app/actions`나 API route 파일을 직접 참조하지 않는 방향을 기본값으로 둡니다.

---

© 2026 BGMS Team. All rights reserved.
