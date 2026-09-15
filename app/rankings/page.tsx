import { Metadata } from 'next';
import { unstable_cache } from 'next/cache';
import { getWeeklyTopDamage, getWeeklyTopKills, getTopTierRanking } from '@/actions/rankings';
import RankingsClient from './RankingsClient';

export const metadata: Metadata = {
  title: '랭킹 | BGMS — PUBG 전술 지도 & AI 전적 분석',
  description: 'BGMS에 수집된 최근 7일 경기 기준 최근 7일 최고 딜량, 최고 킬, BGMS 티어 상위 플레이어 랭킹',
  openGraph: {
    title: 'BGMS 랭킹',
    description: '최근 7일 최고 딜량 · 최고 킬 · BGMS 티어 TOP 30',
  },
};

// 5분마다 ISR 재검증
const getCachedRankings = unstable_cache(
  async () => {
    const [damage, kills, tier] = await Promise.all([
      getWeeklyTopDamage('all'),
      getWeeklyTopKills('all'),
      getTopTierRanking('all'),
    ]);
    return { damage, kills, tier, updatedAt: new Date().toISOString() };
  },
  ['rankings-basic-performance-v3'],
  { revalidate: 300, tags: ['rankings'] }
);

export default async function RankingsPage() {
  const { damage, kills, tier, updatedAt } = await getCachedRankings();

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
