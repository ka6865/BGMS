// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from '@testing-library/react';
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

describe('모드별 성과 근거', () => {
  const renderMode = (gameMode: string, teammateKnocks = 2, ...observations: [] | [unknown, unknown]) => {
    const [winPlace, timeSurvived] = observations.length ? observations : [3, 1420];
    const matchData = structuredClone(detailReady) as unknown as MatchData;
    matchData.gameMode = gameMode;
    Object.assign(matchData.stats, { winPlace, timeSurvived });
    Object.assign(matchData.tradeStats!, { teammateKnocks });
    return render(createElement(MatchPerformancePanel, {
      matchData, isMobile: false, showTierDetails: true, onToggleTierDetails: () => {},
    }));
  };

  it.each(['solo', 'solo-fpp', 'SOLO-FPP'])('%s는 개인 점수 근거만 표시한다', (mode) => {
    renderMode(mode);
    for (const label of ['연막 구출률', '소생률', '트레이드 성공률', '견제 지원', '적 팀 전멸 기여', '팀 구출 지표', '팀 구출 기회', '기절 후 생존 관리력', '고립 페널티']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    for (const label of ['딜량 순위', '선제 타격 성공률', '반격 소요 시간', '압박 지수', '역전 승률', '생존 순위', 'Top 10 진입 보너스']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Top 10 진입 보너스').parentElement).toHaveTextContent('+5점');
    expect(screen.getByText('매치 임팩트 고립 감경')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '전투 점수' })).toHaveAttribute('aria-valuemax', '50');
    expect(screen.getByRole('progressbar', { name: '전술 점수' })).toHaveAttribute('aria-valuemax', '15');
    expect(screen.getByRole('progressbar', { name: '생존 점수' })).toHaveAttribute('aria-valuemax', '35');
  });

  it.each(['solo', 'solo-fpp'])('%s의 기회 없음은 팀 보정으로 표시하지 않는다', (mode) => {
    renderMode(mode, 0);
    expect(screen.queryByText(/팀 구출 기회/)).not.toBeInTheDocument();
    expect(screen.getByText('전술', { selector: 'span.w-8' }).parentElement).toHaveTextContent('역전');
  });

  it.each([
    [1, 300, '+5점'], [10, 1420, '+5점'], [11, 1420, '0점'], [3, 299, '미적용'],
    [0, 1420, '기록 없음'], [-1, 1420, '기록 없음'],
    [undefined, 1420, '기록 없음'], [null, 1420, '기록 없음'], [NaN, 1420, '기록 없음'],
    [3, null, '기록 없음'], [3, undefined, '기록 없음'], [3, NaN, '기록 없음'],
  ])('Top 10 순위 %s·생존 %s를 %s로 표시한다', (place, seconds, expected) => {
    renderMode('solo', 0, place, seconds);
    expect(screen.getByText('Top 10 진입 보너스').parentElement).toHaveTextContent(expected);
  });

  it.each([3.5, 4.5])('솔로 고립 %s는 안정도 감점 대신 임팩트 기준으로 표시한다', (isolationIndex) => {
    const matchData = structuredClone(detailReady) as unknown as MatchData;
    matchData.gameMode = 'solo';
    Object.assign(matchData.isolationData!, { isolationIndex });
    render(createElement(MatchPerformancePanel, {
      matchData, isMobile: false, showTierDetails: true, onToggleTierDetails: () => {},
    }));
    const row = screen.getByText('매치 임팩트 고립 감경').parentElement!;
    expect(row).toHaveTextContent(isolationIndex === 3.5 ? '미적용' : '적용 가능');
    expect(row).toHaveTextContent('매치 임팩트에만 반영');
  });

  it.each(['duo', 'duo-fpp', 'squad', 'squad-fpp'])('%s의 기존 팀 항목과 배점을 유지한다', (mode) => {
    renderMode(mode);
    const tactical = within(screen.getByRole('region', { name: '전술 근거' }));
    expect(tactical.getAllByText(/^(압박 지수|연막 구출률|소생률|트레이드 성공률|견제 지원|적 팀 전멸 기여|역전 승률|고립 페널티)$/)).toHaveLength(8);
    expect(screen.getByText('기절 후 생존 관리력')).toBeInTheDocument();
    expect(screen.queryByText('Top 10 진입 보너스')).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '전투 점수' })).toHaveAttribute('aria-valuemax', '40');
    expect(screen.getByRole('progressbar', { name: '전술 점수' })).toHaveAttribute('aria-valuemax', '35');
    expect(screen.getByRole('progressbar', { name: '생존 점수' })).toHaveAttribute('aria-valuemax', '25');
  });
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
