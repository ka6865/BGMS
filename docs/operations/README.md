# 운영 문서 색인

`docs/operations/`의 문서를 지금도 따르는 계약·절차와 당시 작업 기록으로 나눈다. 분류는 문서 성격 기준이며 운영 적용 상태를 다시 확인한 결과가 아니다. 현재 동작은 구현, 워크플로, 운영 조회로 확인한다. 날짜형 문서는 서로와 `docs/project-map.md`, `CLAUDE.md`에서 상대 경로로 참조하므로 옮기지 않고 이 색인에서 상태를 표시한다.

새 문서를 추가하거나 기록 문서의 후속 작업이 끝나면 이 표를 함께 갱신한다.

## 현재 계약·절차

관련 코드를 바꿀 때 함께 확인하고 갱신한다.

| 문서 | 내용 |
| --- | --- |
| [service-role-only-tables.md](service-role-only-tables.md) | RLS 정책 없이 service role로만 접근하는 테이블 목록과 변경 규칙 |
| [pubg-tracking.md](pubg-tracking.md) | 매치 수집 worker, 개인 제재 추적, 조회 실패 진단과 canary 절차 |
| [pubg-ranking-encounters.md](pubg-ranking-encounters.md) | 랭킹·조우 기능의 구성과 최초 적용 순서 |
| [2026-10-05-collection-clock.md](2026-10-05-collection-clock.md) | `pg_cron`/`pg_net` 5분 주기 수집 호출과 서명 요청 |
| [2026-10-05-historical-shared-telemetry.md](2026-10-05-historical-shared-telemetry.md) | 경기별 공통 이벤트 저장(`telemetry-source/v1`)과 과거 경기 지도 조회 |
| [2026-10-05-archived-match-copy-comparison.md](2026-10-05-archived-match-copy-comparison.md) | R2 경기 사본 오프라인 비교 CLI 사용법과 입력 제한 |
| [2026-10-05-maintenance-archive-verification.md](2026-10-05-maintenance-archive-verification.md) | Bluezone 수집 원본 우선순위, 수집 관측, Archive Verification 워크플로 |
| [2026-10-06-match-detail-retention.md](2026-10-06-match-detail-retention.md) | 경기 상세 14일 보관, 410·404·503 응답 구분과 장기 성과 보존 |
| [2026-10-08-discovery-expiry-audit.md](2026-10-08-discovery-expiry-audit.md) | 수집 불가 전적의 만료 사유 코드(`discovery_window_elapsed` 등) |
| [2026-10-09-participant-history-collection.md](2026-10-09-participant-history-collection.md) | 같은 경기 참가자 기본 전적 저장과 `retention_scope` 의미. 2026-10-16부터 참가자 저장 중단, 대상 플레이어만 저장 |
| [2026-10-10-calculation-coexistence-results.md](2026-10-10-calculation-coexistence-results.md) | 계산 2 보존·신규 계산 3 저장의 공존 계약과 운영 검증 |
| [2026-10-10-remaining-review-fixes.md](2026-10-10-remaining-review-fixes.md) | 운영 migration을 파일 하나씩 적용하는 절차("준비 migration 적용 실적") |
| [2026-10-14-telemetry-lease-sqlstate.md](2026-10-14-telemetry-lease-sqlstate.md) | RPC에서 SQLSTATE `40001`을 던지지 않는 규칙(PostgREST 14 재시도) |
| [2026-10-14-audit-fixes.md](2026-10-14-audit-fixes.md) | 2026-10-14 점검 후속 조치. 남은 확인 항목이 있어 진행 중 |
| [2026-10-15-discord-command-improvements.md](2026-10-15-discord-command-improvements.md) | Discord 전적 명령의 응답·공개 범위 계약 |

## 작업 기록

당시 판단과 검증 근거다. 배포·적용 상태를 현재 상태로 단정하지 않는다.

| 문서 | 내용 | 후속 문서 |
| --- | --- | --- |
| [2026-09-13-ranking-refresh-audit.md](2026-09-13-ranking-refresh-audit.md) | 성과 등급과 랭킹 갱신 경로 조사 | |
| [2026-09-15-main-local-code-review.md](2026-09-15-main-local-code-review.md) | 메인 배포본 대비 로컬 코드 리뷰 | |
| [2026-10-04-actions-safety-review.md](2026-10-04-actions-safety-review.md) | Actions·Discord 알림 점검과 R2 절감 검토 | |
| [2026-10-04-discovery-r2-maintenance.md](2026-10-04-discovery-r2-maintenance.md) | 전적 대기열 점검·추가 수집과 R2 재압축 | |
| [2026-10-04-mobile-web-integration-review.md](2026-10-04-mobile-web-integration-review.md) | 모바일 공유 서버 변경 통합 검토 | |
| [2026-10-05-legacy-account-bindings.md](2026-10-05-legacy-account-bindings.md) | 과거 전적 20쌍의 누락 계정 연결 복구 | |
| [2026-10-05-verified-copy-cleanup.md](2026-10-05-verified-copy-cleanup.md) | 수집 진행과 과거 R2 사본의 현재 증거 검증 | |
| [2026-10-10-audit-fixes-1-3.md](2026-10-10-audit-fixes-1-3.md) | 승인 중복 실행·플레이어 캐시·관리자 인증 수정 | [audit-followup](2026-10-10-audit-followup.md) |
| [2026-10-10-audit-followup.md](2026-10-10-audit-followup.md) | 1~3번 후속 보안 패치와 운영 반영 준비 | [audit-fixes-4-8](2026-10-10-audit-fixes-4-8.md) |
| [2026-10-10-audit-fixes-4-8.md](2026-10-10-audit-fixes-4-8.md) | 점검 4~8번 수정 | [audit-final-release-review](2026-10-10-audit-final-release-review.md) |
| [2026-10-10-audit-final-release-review.md](2026-10-10-audit-final-release-review.md) | 1~8번 최종 배포 검토(당시 배포 보류) | [calculation-coexistence-results](2026-10-10-calculation-coexistence-results.md) |
| [2026-10-10-calculation-coexistence-plan.md](2026-10-10-calculation-coexistence-plan.md) | 계산 공존 계획 | [calculation-coexistence-results](2026-10-10-calculation-coexistence-results.md) |
