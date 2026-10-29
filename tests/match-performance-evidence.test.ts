// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MatchPerformancePanel } from '../components/stat/matches/MatchPerformancePanel';

afterEach(cleanup);
const evidence = (latencySumMs: number, within3sCount = 1) => ({
  version: 1, eligibleCount: 1, alreadyFiringCount: 0, unknownCount: 0,
  within3sCount, latencySumMs, noReplyCount: 1 - within3sCount,
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
