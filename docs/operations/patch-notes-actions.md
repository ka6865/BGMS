# 관리자 패치노트 Actions 실행

관리자 → 데이터 관리 → 시스템 설정 → 패치노트 데이터 수동 동기화에서
`GitHub Actions로 동기화`를 누르고 확인하면 `patch-notes-sync.yml`의 `main` 실행을 요청한다.
URL 입력란과 기존 `데이터 동기화 실행` 버튼은 특정 원문을 직접 동기화하는 기존 경로다.

## 설정

- 앱 서버 환경 변수 `GITHUB_ACTIONS_TOKEN`에 `ka6865/BGMS` 저장소의 Actions 실행 토큰을 설정한다.
  Fine-grained PAT는 해당 저장소만 선택하고 `Actions: Read and write` 권한을 부여한다.
  토큰 값은 서버 환경 변수에만 저장하며 `NEXT_PUBLIC_` 접두사를 사용하지 않는다.
- `.github/workflows/patch-notes-sync.yml`이 기본 브랜치 `main`에 반영되어 있어야 한다.
- GitHub Secrets는 기존 일일 동기화와 같은 `NEXT_PUBLIC_SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_GEMINI_API_KEY`, `DISCORD_WEBHOOK_URL`,
  `NEXT_PUBLIC_SITE_URL`을 사용한다. Discord 웹훅은 기존 스크립트와 같이 선택사항이다.

## 실행 범위와 결과

`POST /api/admin/patch-notes/run`은 기존 `requireAdmin`으로 인증·관리자 권한을 검증한 뒤,
고정된 저장소·workflow·`main`에만 실행을 요청한다. 클라이언트가 실행 대상을 지정할 수 없다.
토큰 미설정은 503, GitHub 요청 실패 또는 응답 확인 실패는 502다.
GitHub 오류 본문과 토큰은 클라이언트에 전달하지 않는다.

202 응답은 **실행 요청 접수**이며 동기화 완료를 뜻하지 않는다.
화면의 `Actions 실행 내역 (새 탭)`에서 대기·진행·성공·실패 로그를 확인한다.
통신 오류가 나면 실행 내역을 먼저 확인한 뒤 재시도한다.

전용 workflow는 `scripts/sync_patch_notes.ts`만 실행한다.
공식 PUBG 뉴스 목록의 최신 글 1건을 확인하고 `sync_history`에 같은 URL이 있으면 건너뛴다.
기존 스크립트대로 AI 요약, 신규 게시글 초안 저장, 기존 글 갱신, 무기 변경 제안 생성,
설정된 Discord 알림을 처리한다. 게임 데이터에 제안을 적용하는 검토 절차는 별도다.

일일 유지보수와 `daily-bgms-maintenance` concurrency 그룹을 공유해 중복 저장을 피한다.
일일 작업이 진행 중이면 수동 실행은 대기하고, 수동 실행 중에는 일일 작업이 대기할 수 있다.
GitHub concurrency 정책에 따라 대기 요청이 여러 개면 기존 대기 요청이 새 요청으로 교체될 수 있다.
수동 버튼은 기존 정리·삭제·매치 수집 등 일일 유지보수 작업을 실행하지 않는다.

GitHub API 계약: [Create a workflow dispatch event](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).
