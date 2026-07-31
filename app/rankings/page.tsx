import { Metadata } from 'next';
import { unstable_cache } from 'next/cache';
import { getWeeklyTopDamage, getWeeklyTopKills, getTopTierRanking } from '@/actions/rankings';
import RankingsClient from './RankingsClient';

export const metadata: Metadata = {
  title: '랭킹 | BGMS — PUBG 전술 지도 & AI 전적 분석',
  description: '아시아 서버 BGMS 분석 데이터 기준 이번 주 최고 딜량, 최고 킬, BGMS 티어 상위 플레이어 랭킹',
  openGraph: {
    title: 'BGMS 랭킹',
    description: '이번 주 최고 딜량 · 최고 킬 · BGMS 티어 TOP 100',
  },
};

// 30분마다 ISR 재검증
const getCachedRankings = unstable_cache(
  async () => {
    const [damage, kills, tier] = await Promise.all([
      getWeeklyTopDamage('all'),
      getWeeklyTopKills('all'),
      getTopTierRanking('all'),
    ]);
    return { damage, kills, tier };
  },
  ['rankings-all'],
  { revalidate: 1800, tags: ['rankings'] }
);

export default async function RankingsPage() {
  const { damage, kills, tier } = await getCachedRankings();

  return (
    <RankingsClient
      initialDamage={damage.data}
      initialKills={kills.data}
      initialTier={tier.data}
      updatedAt={new Date().toISOString()}
      initialDamageHasError={damage.hasError}
      initialKillsHasError={kills.hasError}
      initialTierHasError={tier.hasError}
    />
  );
}
