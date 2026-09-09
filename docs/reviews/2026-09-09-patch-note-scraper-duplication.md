# 패치노트 수집 중복 점검 — 2026-09-09

범위: develop 작업 폴더의 구현·호출 경로, GitHub Actions 현재 활성 상태와 최근 실행 단계, 연결 DB의 인덱스·공식 원문 URL 중복 여부. 실제 스크래퍼 실행, Gemini 호출, 웹훅 전송, 게시글 수정·삭제는 수행하지 않았다. 이 문서 작성 외 패치노트 코드는 수정하지 않았다.

## 결론과 현재 실행 경로

패치노트 본문 수집·AI 요약·HTML 생성·게시글 저장 구현은 세 군데에 남아 있다. 카테고리 판정과 무기도감 제안 생성은 이미 공유하지만, 수집 파이프라인 자체는 통합되지 않았다. 과거 설계 문서의 P5에도 ‘categorize.ts 분리만 완료’라고 기록되어 있다.

| 진입점 | 실제 호출 관계 | 주요 차이 |
| --- | --- | --- |
| scripts/sync_patch_notes.ts | .github/workflows/daily-tasks.yml:221–229, 매일 03:00 KST 예약 및 workflow_dispatch | 전체 뉴스 목록의 첫 글, 요약 입력 15,000자, 독자 DOM 선택자 |
| app/api/admin/patch-notes/sync/route.ts | components/admin/GameDataEditor.tsx:651의 수동 동기화 | 기본은 패치노트 목록, 공식/카카오 URL 수동 지정, 요약 입력 8,000자 |
| app/api/cron/patch-notes/route.ts | 인증된 호출이 가능한 별도 API | 전체 뉴스 목록 파싱 및 Nuxt fallback, 요약 입력 5,000자 |

GitHub에서 `Daily BGMS Maintenance`가 active이며 최근 5회 예약 실행이 완료된 것을 확인했다. 최근 실행 34277742253에서 `Sync Patch Notes` 단계가 success로 끝났다. 저장소에서 cron API를 예약 호출하는 설정은 찾지 못했고 vercel.json도 없다. 따라서 현재 확인되는 자동 수집 경로는 GitHub 1개이며, 세 경로가 모두 자동으로 실행된다고 단정할 수 없다. 외부 콘솔에 별도로 등록된 예약은 조회하지 않았다.

참고: lib/patch-notes/patchNoteSourceFetch.ts에도 원문 파서가 있지만 기존 글의 무기도감 제안을 소급 생성하는 목적이다. 자동 게시 스케줄이 하나 더 있다는 뜻은 아니다. 새 커뮤니티 비서는 DC/네이버/YouTube를 수집하며, loadOfficialEvidence는 현재 빈 배열을 반환하므로 이 공식 웹사이트 수집기를 추가 실행하지 않는다.

## 발견 사항

### P1 — 재수집이 이미 공개된 글을 승인 없이 덮어쓸 수 있음

세 경로 모두 제목만으로 posts를 찾고 status/category/author/parent_id를 확인하지 않은 채 content를 update한다. 새 글만 draft로 생성하고 기존 글의 published 상태는 유지하므로, 이전에 검토해 발행한 본문이 새 AI 결과로 즉시 바뀔 수 있다. 사용자 수동 편집도 보존되지 않는다.

근거: scripts/sync_patch_notes.ts:326–354, app/api/admin/patch-notes/sync/route.ts:295–319, app/api/cron/patch-notes/route.ts:399–429. 기존 공개 글에 대한 재생성은 수정 초안으로 분리하거나 명시적인 승인 적용 경로를 사용해야 한다.

### P2 — 제목 조회 후 insert 방식은 동시 실행과 제목 변경을 막지 못함

각 경로가 따로 기존 제목을 조회한 후 insert한다. 두 경로가 동시에 ‘없음’을 읽으면 같은 원문의 draft를 각각 만들 수 있다. 실 DB에는 published 상태의 제목에만 고유 인덱스가 있고, draft 또는 원문 식별자에 대한 고유 제약은 없다. 제목이 달라지는 경우에도 동일 기사 여부를 알 수 없다. 또한 maybeSingle의 error를 검사하지 않아 동일 제목이 이미 여러 개이면 오류를 ‘없음’으로 취급하고 또 insert할 수 있다.

현재 DB의 배그 소식 중 공식 PUBG /ko/news/{id} 링크가 있는 19개 글을 원문 기사 ID로 묶어 검사했으며 중복 그룹은 0개였다. 이는 현재 중복 저장이 발생했다는 증거가 아니라, 중복 방지 구조에 빈틈이 있다는 발견이다. 카카오·외부 링크가 없는 글은 이 집계에 포함하지 않았다.

### P2 — 최신 URL 하나를 공유해 이미 처리한 기사를 다시 요약할 수 있음

CLI는 전체 뉴스 목록을, 관리자 기본 수집은 패치노트 목록을 읽는데 둘 다 sync_history.type=patch_notes의 last_url 하나를 공유한다. 예를 들어 최신 전체 뉴스 B를 처리한 뒤 수동 경로가 패치노트 A를 처리하면, 다음 자동 실행은 B를 다시 미처리로 판단한다. 모든 기사별 처리 이력이 아니므로 중복 AI 호출과 기존 글 덮어쓰기로 이어진다.

근거: scripts/sync_patch_notes.ts:263,303–319,364–368 및 app/api/admin/patch-notes/sync/route.ts:125,144–146,323–324.

### P2 — 분산된 파서와 본문 길이 때문에 같은 원문도 결과가 달라짐

CLI는 content-template__inner/#contentElement/article, 관리자 경로는 post-detail__content/news-detail__content/article, cron은 추가 선택자와 Nuxt fallback을 사용한다. 요약 길이도 15,000/8,000/5,000자로 다르다. 한 경로에서 성공하는 원문이 다른 경로에서 비거나 잘릴 수 있다.

무기도감 제안은 source_text_hash 고유 제약으로 같은 본문을 중복 저장하지 않지만, CLI는 잘라낸 텍스트를 넘기고 관리자/cron은 원문을 넘기므로 해시가 달라질 수 있다. 본문 해시 중복 검사도 동시 AI 호출 전에 작업을 선점하지는 않는다. 제안 저장 중복 보호와 수집/AI 호출 중복 방지는 별개다.

근거: scripts/sync_patch_notes.ts:35–45,168; app/api/admin/patch-notes/sync/route.ts:36,158–163; app/api/cron/patch-notes/route.ts:279–316; lib/patch-notes/weaponProposalService.ts:117–147.

## 권장 정리 범위

1. 공식/카카오 원문 파싱, 정규화, 요약, HTML 생성, 저장을 lib/patch-notes의 공통 서비스로 모은다. CLI와 관리자 API는 인증·입력만 처리한다. 별도 cron API는 외부 사용 여부를 확인한 후 같은 서비스를 호출하거나 제거한다.
2. 원문 제공자+기사 ID를 기준으로 기사 처리 이력을 남기고, DB 고유 제약과 작업 선점을 둬 중복 AI 호출 및 draft 생성을 막는다. 기사 본문이 실제로 바뀐 경우만 새 버전으로 처리한다.
3. 이미 공개된 글은 자동 덮어쓰기 대신 검토할 수정 초안으로 저장한다.
4. 회귀 검증에는 같은 기사 동시 호출, 제목 변경, 발행 후 재수집, 동일 제목 draft 여러 개, 일반 뉴스/패치노트 목록 교차 실행을 포함한다.
