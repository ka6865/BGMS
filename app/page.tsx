import { redirect } from 'next/navigation';

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
        redirect(`/board/${postId}${queryString}`);
      }
      redirect(`/board${queryString}`);
    }
    if (tab === "Stats") {
      redirect(`/stats${queryString}`);
    }
    // 맵 탭인 경우
    const maps = ["Erangel", "Miramar", "Taego", "Rondo", "Vikendi", "Deston"];
    if (maps.includes(tab)) {
      redirect(`/maps/${tab.toLowerCase()}${queryString}`);
    }
  }

  //  [기본 동작] 루트 접속 시 에란겔 맵으로 리다이렉트 (Option 2 전략)
  if (queryString) {
    redirect(`/maps/erangel${queryString}`);
  }
  redirect('/maps/erangel');
}

