// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MatchPerformancePanel } from '../components/stat/matches/MatchPerformancePanel';
import type { MatchData } from '@/types/stat';
import detailReady from './fixtures/stats/match-detail-ready.json';
import { MatchDetailExpiredNotice } from '@/components/stat/matches/MatchDetailExpiredNotice';
import type { MatchSummaryData } from '@/lib/pubg-analysis/matchSummary';

afterEach(cleanup);
const evidence = (latencySumMs: number, within3sCount = 1) => ({
  version: 1, eligibleCount: 1, alreadyFiringCount: 0, unknownCount: 0,
  within3sCount, latencySumMs, noReplyCount: 1 - within3sCount,
});

describe('성과 근거의 결측과 실제 0', () => {
  it.each([null, 0])('만료 후 기본 요약의 생존 관측값 %s를 호환용 0과 구분한다', (timeSurvived) => {
    const summary = structuredClone(detailReady) as unknown as MatchSummaryData;
    Object.assign(summary, { summarySource: 'pubg_player_matches', isSummary: true,
      basicStats: { DBNOs: null, timeSurvived } });
    summary.stats.timeSurvived = 0;
    render(createElement(MatchDetailExpiredNotice, { summary, expiresAt: null }));
    const rule = screen.getByText('5분 미만 0점 룰').parentElement!;
    expect(rule).toHaveTextContent(timeSurvived === null ? '기록 없음' : '적용0분 생존');
    if (timeSurvived === null) expect(rule).not.toHaveTextContent('0분 생존');
  });

  it.each([undefined, null, NaN, 0, 900])('생존시간 %s를 관측 여부에 따라 표시한다', (timeSurvived) => {
    const matchData = structuredClone(detailReady) as unknown as MatchData;
    Object.assign(matchData.stats, { timeSurvived, deathType: 'alive' });
    render(createElement(MatchPerformancePanel, {
      matchData, isMobile: false, showTierDetails: true, onToggleTierDetails: () => {},
    }));
    const missing = timeSurvived == null || Number.isNaN(timeSurvived);
    const hardRule = screen.getByText('5분 미만 0점 룰').parentElement!;
    const earlyRule = screen.getByText('조기 탈락 보정').parentElement!;
    expect(hardRule).toHaveTextContent(missing ? '기록 없음' : timeSurvived === 0 ? '적용0분 생존' : '미적용15분 생존');
    expect(earlyRule).toHaveTextContent(missing ? '기록 없음' : timeSurvived === 0 ? '적용' : '미적용');
    if (missing) {
      expect(hardRule).not.toHaveTextContent('0분 생존');
      expect(earlyRule).not.toHaveTextContent('정상 생존 구간');
      expect(screen.getByText('생존', { selector: 'span.w-8' }).parentElement).toHaveTextContent('기록 없음');
    }
  });

  it.each([undefined, null, NaN, 0, 3.5])('고립 지수 %s를 미적용과 구분한다', (isolationIndex) => {
    const matchData = structuredClone(detailReady) as unknown as MatchData;
    Object.assign(matchData.isolationData!, { isolationIndex });
    render(createElement(MatchPerformancePanel, {
      matchData, isMobile: false, showTierDetails: true, onToggleTierDetails: () => {},
    }));
    const row = screen.getByText('고립 페널티').parentElement!;
    expect(row).toHaveTextContent(isolationIndex == null || Number.isNaN(isolationIndex)
      ? '기록 없음' : isolationIndex === 0 ? '미적용고립 지수 0.0' : '적용 가능고립 지수 3.5');
  });
});

describe('single-match qualified reply evidence', () => {
  it.each([
    ['raw-only', undefined, '측정 불가'],
    ['qualified', evidence(903), '0.90초'],
    ['no reply', evidence(0, 0), '측정 불가'],
    ['observed zero', evidence(0), '0.00초'],
    ['malformed', { ...evidence(903), eligibleCount: 0 }, '측정 불가'],
  ])('%s never uses the raw score latency as a measured reply', (_name, firstReplyEvidence, expected) => {
    render(createElement(MatchPerformancePanel, {
      matchData: { stats: { timeSurvived: 1200, winPlace: 5, deathType: 'alive' }, gameMode: 'squad', totalTeams: 25,
        tradeStats: { reactionLatencyMs: 3 }, duelStats: { firstReplyEvidence },
        benchmark: { score: 80, tier: 'A', breakdown: { combat: 30, tactical: 30, survival: 20 } } } as any,
      isMobile: false, showTierDetails: true, onToggleTierDetails: () => {},
    }));
    expect(screen.getByText('반격 소요 시간').parentElement).toHaveTextContent(expected);
    expect(screen.getAllByRole('progressbar', { name: '전투 점수' })[0]).toHaveAttribute('aria-valuenow', '30');
  });
});
