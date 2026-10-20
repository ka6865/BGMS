# 전적 분석 리포트 방향성 요청 참고

## 전적 분석 리포트 고도화 방향성 요청 시 우선 읽을 파일

- `components/stat/StatSearch.tsx`
- `hooks/useStatsPageController.ts`
- `lib/stats/statsPageModel.ts`
- 관련 `components/stat/overview/`, `components/stat/profile/`, `components/stat/matches/` 컴포넌트
- `components/stat/MatchCard.tsx`
- `components/stat/RecentAISummary.tsx`
- `components/stat/SquadAnalysisPanel.tsx`
- `components/stat/SquadCauseScenes.tsx`
- `app/api/pubg/match/route.ts`
- `app/api/pubg/ai-analyze/route.ts`
- `app/api/pubg/ai-summary/route.ts`
- `app/api/pubg/ai-squad/route.ts`
- `lib/pubg-analysis/AnalysisEngine.ts`
- `lib/pubg-analysis/benchmarkScore.ts`
- `lib/pubg-analysis/cacheIdentity.ts`
- `lib/pubg-analysis/squadAnalysis.ts`
- `lib/pubg-analysis/squadCauseScenes.ts`
- `tests/analysis-engine.test.ts`
- `tests/pubg-analysis-stability.test.ts`
- `tests/ai-cache-routes.test.ts`
- `tests/squad-cause-scenes.test.ts`
- `tests/squad-recovery-stats.test.ts`

전적 분석 리포트 방향성 요청에서는 단일 매치, 최근 요약, 스쿼드, 원인 장면, 티어 점수를 분리해 설명한다. 라인 번호는 실제 `nl -ba`로 확인한 경우에만 쓰고, 방향성 답변에서는 파일 역할 중심으로 말한다. "최근 N개", "상위 M개" 같은 구현 세부는 파일에서 직접 확인한 경우에만 단정한다.

## 방향성 답변 구조

- 현재 구조
- 먼저 읽을 파일
- 단일 매치 / 최근 요약 / 스쿼드 / 원인 장면 / 티어 점수별 개선 방향
- 사용자 / 개발자 / 서버 / Supabase / R2 / Gemini 비용 영향
- 얻는 점 / 잃는 점 / 위험 요소
- AI 단정 방지 기준
- 단계별 구현 계획
- 테스트 방법과 우선순위
