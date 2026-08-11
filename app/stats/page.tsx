import { Metadata } from 'next';
import { getTabSeo } from '@/lib/seo-config';
import StatSearch from '@/components/stat/StatSearch';

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getTabSeo("Stats");
  return {
    ...seo,
    title: "AI 전적 검색 | BGMS",
  };
}

export default function StatsPage() {
  return <StatSearch />;
}
