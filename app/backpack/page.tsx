import { Metadata } from 'next';
import { getBreadcrumbJsonLd } from '@/lib/seo-config';
import JsonLd from '@/components/seo/JsonLd';
import BackpackClient from './BackpackClient';
import { JsonLdProps } from '@/types/seo';

const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://bgms.kr";

export const metadata: Metadata = {
  title: "배그 인벤토리 시뮬레이터 | 아이템 무게 및 배낭 용량 계산",
  description: "배틀그라운드 아이템별 무게와 가방/조끼 레벨에 따른 수납 용량을 실시간으로 계산해보세요. 트렁크 보관 기능도 지원합니다.",
  openGraph: {
    title: "배그 인벤토리 시뮬레이터 - BGMS",
    description: "배그 전술의 핵심, 아이템 무게 계산기를 활용하세요.",
    url: "/backpack",
    images: ["/logo.png"],
  }
};

export default async function BackpackPage() {
  const jsonLd: JsonLdProps[] = [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "BGMS",
      "url": baseUrl,
    },
    getBreadcrumbJsonLd([
      { name: "홈", item: "/" },
      { name: "인벤토리 시뮬레이터", item: "/backpack" }
    ]) as JsonLdProps
  ];

  return (
    <>
      <JsonLd data={jsonLd} />
      <BackpackClient />
    </>
  );
}
