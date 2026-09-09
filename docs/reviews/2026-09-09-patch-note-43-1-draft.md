# 업데이트 43.1 초안 생성 및 cron 제거

2026-09-09 공식 패치노트 https://pubg.com/ko/news/11057 을 확인했다. 전체 뉴스 목록의 최신 항목은 제재 현황 안내이므로 PATCH_NOTES_TARGET_URL로 패치노트 기사만 지정했다. 실행 전 동일 제목/원문 URL/43.1 글 조회 결과는 0건이었다.

실행: PATCH_NOTES_TARGET_URL=https://pubg.com/ko/news/11057 PATCH_NOTES_DRAFT_ONLY=true npx tsx scripts/sync_patch_notes.ts

결과: posts.id=167, 제목 ‘패치 노트 - 업데이트 43.1’, status=draft, category=배그 소식, author=BGMS 시스템. Gemini gemini-3.5-flash-lite 1회로 요약을 생성했다. 무기도감 변경 제안·Discord 알림은 초안 전용 모드에서 건너뛰었다. 게시 승인·발행은 실행하지 않았다. 공식 원문과 비교해 차량 피해 배율을 ‘모두 제거’로 표현한 문장을 M249·RPD 1.0배, MG3 1.1배로 교정했다.

스크립트에 초안 전용 옵션을 추가했다. 발행/수정본 상태의 기존 글은 덮어쓰지 않으며, 기존 draft 갱신도 저장 시 status=draft 조건을 다시 검사한다. 기존 조회 오류를 무시하지 않으며 초안 전용 생성/저장 실패는 실패 종료 코드로 알린다. 기본 예약 동작은 유지한다. 요약 변환기의 굵게 표시 기호가 잘리는 문제와 빈 목록 항목을 수정했고, 생성한 167번 초안에도 내용 일치+draft 조건으로 적용했다. Gemini 재호출은 하지 않았다.

사용하지 않는 app/api/cron/patch-notes/route.ts를 삭제하고 이를 직접 참조하던 보안/무기도감 테스트와 현재 경로 설명을 수정했다. GitHub Actions 스크립트와 관리자 수동 sync API는 유지한다. 로컬 /api/cron/patch-notes 응답은 404다. 운영 배포는 수행하지 않았으므로 배포된 환경의 제거는 다음 배포 시 반영된다.

검증: 초안 전용/포맷 회귀 4개 + 관련 보안/무기도감 54개 = 58 tests passed; Next route typegen 후 TypeScript 통과; 수정 스크립트 및 새 테스트 ESLint 통과; diff check 통과. 실제 저장된 초안 HTML에 로컬 앱 CSS를 적용해 375×667, 390×844, 430×932, 1280×720에서 가로 넘침 없음, 목록 6개, 빈 목록 0개를 확인했다. 전체 로그인된 게시판 UI를 자동 조작하지는 않았다.
