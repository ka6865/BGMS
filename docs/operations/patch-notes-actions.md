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

## 공식 무기·차량 도감

관리자 패치 제안 화면의 **공식 도감 불러오기**는 PUBG 공식 무기·차량 원본을 읽고 BGMS 항목과 이름이 정확히 일치하는 경우 기존 값을 나란히 표시한다. 공식 수치의 단위는 BGMS 계산값과 다를 수 있으므로 자동으로 변환하거나 기존 데이터를 덮어쓰지 않는다. 공식 페이지가 일부 항목만 갱신할 수 있으므로 각 항목의 갱신일을 확인한다.

**확인한 공식 정보 공개**는 미리 본 내용의 해시를 재확인한 뒤 `official_game_catalog`의 두 분류를 저장한다. 원본이 달라졌으면 다시 불러와 검토해야 한다. 저장된 원본은 무기 정보와 인벤토리 화면에서 각각 확인할 수 있으며 공식 사이트 구조가 바뀌어 해석에 실패하면 저장하지 않는다. 사용 전 해당 migration을 대상 환경에 적용해야 한다. 수집·공개는 관리자가 직접 실행하며 자동 실행되지 않는다.

차량 트렁크 용량 제안은 근거에 트렁크 용량과 변경 후 수치가 명시된 경우에만 승인·반영한다. 저장된 이전 제안도 관리자 API의 승인·반영 시 재검사한다. 다른 컬럼의 인용문 의미와 대상 일치까지 자동 검증하는 것은 아니므로 관리자 검토가 필요하다.

무기 메타 보고서는 원본 표본을 변경하지 않고 조회 시 `FamasG2`를 `파마스`, `DuncansHK416`을 `M416`, `LunchmeatsAK47`을 `AKM`으로 통합한다. 같은 플레이어·경기에 별칭이 여러 개 있으면 채용은 한 경기로 세고 해당 피해·킬·기절을 합산한다. 연사 데이터가 일부 누락된 경우 해당 경기의 연사 지표는 미수집으로 유지한다. `20261104210948_weapon_meta_aliases` migration 적용 후 보고서에 반영된다.

M16A4·QBZ95·Mk47 뮤턴트와 일부 기존 무기 ID의 메타 분류 누락도 수정했다. 이는 새로운 표본 수집에 적용되며, 이전에 제외되어 저장되지 않은 표본을 자동 복구하지 않는다. 이 migration 번호는 기존 `20261105010000`보다 이전이므로 운영 적용 전 migration 이력을 확인하고 대상 배포 절차에서 누락된 migration 처리 방식을 확인한다.
