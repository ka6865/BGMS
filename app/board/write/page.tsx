import { Metadata } from 'next';
import { getTabSeo } from '@/lib/seo-config';
import BoardWriteClient from '@/components/board/BoardWriteClient';

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getTabSeo("Board");
  return {
    ...seo,
    title: "글쓰기",
    robots: { index: false } // 글쓰기 페이지는 수집되지 않도록 방지
  };
}

export default function BoardWritePage() {
  return <BoardWriteClient />;
}
