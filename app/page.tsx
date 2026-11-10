import type { Metadata } from 'next';
import HomeHub from '@/components/home/HomeHub';
import { permanentRedirect } from 'next/navigation';

export const metadata: Metadata = {
  title: { absolute: 'BGMS | 배틀그라운드·리그 오브 레전드 전적과 전술 정보' },
  description: '배틀그라운드 지도·AI 전적 분석·랭킹과 리그 오브 레전드 증바람 증강 정보를 한곳에서 확인하세요.',
  alternates: { canonical: '/' },
};

export default async function Home({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const s = await searchParams;
  const tab = s.tab as string;
  const postId = s.postId as string;

  // 나머지 쿼리를 보존하기 위해 세팅
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(s)) {
    if (key !== 'tab' && key !== 'postId' && value) {
      query.set(key, value.toString());
    }
  }
  const queryString = query.toString() ? `?${query.toString()}` : '';

  //  [레거시 대응] 쿼리 파라미터 주소를 새로운 경로 기반 주소로 리다이렉트
  if (tab) {
    if (tab === "Board") {
      if (postId) {
        permanentRedirect(`/board/${postId}${queryString}`);
      }
      permanentRedirect(`/board${queryString}`);
    }
    if (tab === "Stats") {
      permanentRedirect(`/stats${queryString}`);
    }
    // 맵 탭인 경우
    const maps = ["Erangel", "Miramar", "Taego", "Rondo", "Vikendi", "Deston"];
    if (maps.includes(tab)) {
      permanentRedirect(`/maps/${tab.toLowerCase()}${queryString}`);
    }
  }

  // 쿼리만 있는 루트(광고 추적 값 등)도 홈 허브를 보여 준다.
  return <HomeHub />;
}
