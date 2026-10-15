# 스쿼드 분석 최근 경기 반영과 성과 작업 처리량 (2026-10-16)

## 배경

스쿼드 분석은 상세 분석 결과(`processed_match_telemetry`)만 읽는다. 상세 분석은 경기 카드를 펼치거나 AI 요약이 대체 경로로 요청할 때만 만들어진다. 따라서 최근 팀 경기를 펼쳐 보지 않은 사용자는 오래된 경기로만 스쿼드 그룹이 만들어지고, 그 경기들의 상세가 만료(14일)되면 AI 분석이 `detail_expired`로 실패했다.

성과 작업은 하루 약 20건만 처리했고, 들어오는 양은 하루 15~149건이었다. 예약 순서대로 처리했기 때문에 최근 경기의 점수가 늦게 채워지고 오래된 작업은 7일이 지나 버려졌다.

## 변경

1. `GET /api/pubg/squad-analyze`(그룹 지정 없음, 로그인 사용자만): 최근 13일의 듀오·스쿼드 경기 중 상세 분석이 없는 것을 최신순으로 최대 4건, 동시 2건, 전체 16초·경기당 8초 안에서 `/api/pubg/match`로 분석한다. 같은 플랫폼·플레이어는 인스턴스당 10분간 다시 하지 않는다. 실패는 목록 응답을 막지 않는다. 구현: `lib/pubg-analysis/squadDetailPrefetch.server.ts`, 로그 `[SQUAD-DETAIL-PREFETCH]`.
2. 스쿼드 AI 후보 선택(`selectSquadAnalysisCandidates`): 상세 보관 기간이 지난 경기를 먼저 제외하고, 남은 경기 중 관측 가능한 경기를 우선한다. 모두 만료됐으면 기존 후보를 그대로 쓴다.
3. 성과 작업: `scripts/refresh_pubg_performance.ts` 실행당 30건, 하루 150건 요청. `claim_pubg_performance_job`의 상한을 100에서 300으로 올리고, 경기의 최신 `played_at` 내림차순으로 고른다. 동시 1건 처리, lease, 예산 차감 계약은 그대로다.

## 부담

- 자동 상세 분석은 스쿼드 패널을 연 로그인 사용자당 최대 4번의 텔레메트리 다운로드와 R2 저장을 더한다. 비로그인 요청과 특정 그룹 조회는 실행하지 않는다.
- 성과 작업은 GitHub Actions 실행 시간과 텔레메트리 다운로드를 늘린다. 실행 시간 상한(4분, 워크플로 7분)은 그대로다.

## 배포 순서

1. migration `20261016010000_performance_jobs_newest_first.sql`을 운영에 개별 적용한다(`docs/operations/2026-10-10-remaining-review-fixes.md`의 절차). 적용 전에는 스크립트가 150을 요청해도 DB 상한 100이 적용된다.
2. 앱을 배포한다. 순서가 바뀌어도 동작은 깨지지 않는다.

## 검증

`npm run verify:migrations`(최신순 선택, 상한 300, 권한 시나리오 `performance-jobs-newest-first-checks.sql`), `npm run verify:core`, `tests/squad-ai-candidate-selection.test.ts`.
