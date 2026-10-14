import { getBreadcrumbJsonLd } from '@/lib/seo-config';
import JsonLd from '@/components/seo/JsonLd';
import WeaponsClient from './WeaponsClient';
import { JsonLdProps } from '@/types/seo';

const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://bgms.kr";

export default async function WeaponsPage() {
  const jsonLd: JsonLdProps[] = [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "BGMS",
      "url": baseUrl,
    },
    getBreadcrumbJsonLd([
      { name: "홈", item: "/" },
      { name: "무기 정보", item: "/weapons" }
    ]) as JsonLdProps
  ];

  return (
    <>
      <JsonLd data={jsonLd} />
      <WeaponsClient />
    </>
  );
}
