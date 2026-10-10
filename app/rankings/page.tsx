import { Metadata } from 'next';
import RankingsClient from './RankingsClient';

// Render the controls without waiting for database queries; the client reads
// only the selected ranking through the uncached API.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '랭킹 | BGMS — PUBG 전술 지도 & AI 전적 분석',
  description: 'BGMS에 수집된 최근 7일 경기 기준 최근 7일 최고 딜량, 최고 킬, BGMS 티어 상위 플레이어 랭킹',
  openGraph: {
    title: 'BGMS 랭킹',
    description: '최근 7일 최고 딜량 · 최고 킬 · BGMS 티어 TOP 30',
  },
};

export default function RankingsPage() {
  return <RankingsClient updatedAt={new Date().toISOString()} />;
}
