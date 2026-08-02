import HomeClient from '@/app/HomeClient';
import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { getTabSeo, getBreadcrumbJsonLd } from '@/lib/seo-config';
import { JsonLdProps } from '@/types/seo';
import { resolveMapIdFromSlug } from '@/lib/map-ids';
import MapLoadingSkeleton from './MapLoadingSkeleton';

const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://bgms.kr";

export async function generateMetadata({ params }: { params: Promise<{ mapId: string }> }): Promise<Metadata> {
  const { mapId } = await params;
  // 지원 목록에 있는 지도만 SEO 메타데이터를 노출한다.
  const resolvedMapId = resolveMapIdFromSlug(mapId);
  if (!resolvedMapId) {
    return { title: '지도를 찾을 수 없습니다 | BGMS', robots: { index: false, follow: false } };
  }
  return getTabSeo(resolvedMapId);
}

export default async function MapPage({ params }: { params: Promise<{ mapId: string }> }) {
  const { mapId } = await params;
  // 지원하지 않는 지도 주소는 빈 타일 지도 대신 404로 처리한다.
  const formattedId = resolveMapIdFromSlug(mapId);
  if (!formattedId) notFound();

  const jsonLd: JsonLdProps[] = [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "BGMS",
      "url": baseUrl,
    },
    getBreadcrumbJsonLd([
      { name: "지도", item: "/" },
      { name: formattedId, item: `/maps/${formattedId.toLowerCase()}` }
    ]) as JsonLdProps
  ];

  // 라우트 단위 loading.tsx 는 응답을 즉시 스트리밍해 notFound() 의 404 상태 코드를
  // 잃게 만든다. 스켈레톤을 Suspense fallback 으로 직접 감싸 로딩 UX와 404 상태를 함께 유지한다.
  return (
    <Suspense fallback={<MapLoadingSkeleton />}>
      <HomeClient jsonLd={jsonLd} initialMapId={formattedId} />
    </Suspense>
  );
}
