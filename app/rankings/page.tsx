import { Metadata } from 'next';
import { getWeeklyTopDamage, getWeeklyTopKills, getTopTierRanking } from '@/actions/rankings';
import RankingsClient from './RankingsClient';

// Privacy registrations can happen from the support center at any time. Keep
// this SSR page uncached so a newly-private account is absent immediately.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '랭킹 | BGMS — PUBG 전술 지도 & AI 전적 분석',
  description: 'BGMS에 수집된 최근 7일 경기 기준 최근 7일 최고 딜량, 최고 킬, BGMS 티어 상위 플레이어 랭킹',
  openGraph: {
    title: 'BGMS 랭킹',
    description: '최근 7일 최고 딜량 · 최고 킬 · BGMS 티어 TOP 30',
  },
};

export default async function RankingsPage() {
  const [damage, kills, tier] = await Promise.all([
    getWeeklyTopDamage('all'),
    getWeeklyTopKills('all'),
    getTopTierRanking('all'),
  ]);
  const updatedAt = new Date().toISOString();

  return (
    <RankingsClient
      initialDamage={damage.data}
      initialKills={kills.data}
      initialTier={tier.data}
      updatedAt={updatedAt}
      initialDamageHasError={damage.hasError}
      initialKillsHasError={kills.hasError}
      initialTierHasError={tier.hasError}
    />
  );
}
