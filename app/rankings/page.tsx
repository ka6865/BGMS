import { Metadata } from 'next';
import RankingsClient from './RankingsClient';

// Render the controls without waiting for database queries; the client reads
// only the selected ranking through the uncached API.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '배그 주간 랭킹 - 지난주 딜량·킬·BGMS 티어',
  description: 'BGMS에서 전적을 조회한 이력이 있는 계정의 지난주(월~일) 경기 기준 최고 딜량, 최고 킬, BGMS 티어 상위 플레이어 주간 랭킹. 매주 월요일 공개, 화요일 오전 9시 확정',
  alternates: { canonical: '/rankings' },
  openGraph: {
    title: 'BGMS 랭킹',
    description: '지난주 최고 딜량 · 최고 킬 · BGMS 티어 TOP 30',
  },
};

export default function RankingsPage() {
  return <RankingsClient updatedAt={new Date().toISOString()} />;
}
