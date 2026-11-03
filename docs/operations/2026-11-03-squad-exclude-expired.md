# 스쿼드 분석에서 상세 보관 기간이 지난 경기 제외 (2026-11-03)

## 배경

스쿼드 분석은 상세 분석 결과(`processed_match_telemetry`)를 읽는다. 상세 보관 기간(14일)이 지난 경기도 그룹 목록, 최근 경기 수, 순위 계산에 섞였고, 모두 만료되면 만료 경기를 그대로 쓰는 예외가 있었다. 뒤쪽에서 `squad-analyze`가 장면만 걷어내고 `ai-squad`가 `detail_expired`로 막았지만, 화면의 경기 수와 점수는 만료 경기를 포함했다.

## 변경

- `getSquadAnalysisData`: 듀오·스쿼드 경기 중 경기 시각이 14일 이상 지난 것(`isSquadDetailAvailable`)을 그룹 만들기 전에 뺀다. 그룹 목록, 최근 10경기, `matchesSummary`, 순위, 점수가 모두 같은 경기 집합을 쓴다. 경기 시각을 알 수 없으면 기존처럼 만료로 보지 않는다.
- `selectSquadAnalysisCandidates`: 모두 만료되면 만료 경기를 쓰던 예외를 없앴다. 후보가 없으면 빈 목록이다.
- 만료 경기로만 이뤄진 그룹은 목록에 나타나지 않는다. 패널의 빈 상태 문구에 14일 기준을 안내한다.
- 유지: `squad-analyze`의 장면 필터와 `ai-squad`의 `detail_expired`는 목록을 본 뒤 분석 요청 사이에 만료되는 경우를 막는 방어선으로 남긴다.

## 영향

- 14일 넘게 팀 경기를 하지 않은 사용자는 스쿼드 그룹이 비어 보인다. 목록을 열 때 최근 13일 경기를 최대 4건 채우는 자동 상세 분석(`squadDetailPrefetch.server.ts`)은 그대로다.
- 승수·순위는 `squadRecordedMatches.ts`가 이미 14일 창을 쓰므로 변하지 않는다.
- 캐시 버전, 계산식, DB는 바뀌지 않는다.

## 검증

`tests/squad-analysis.test.ts`(만료 경기 제외, 전부 만료 시 빈 목록), `tests/squad-ai-candidate-selection.test.ts`, 전체 `vitest run tests`, `npm run verify:core`.
