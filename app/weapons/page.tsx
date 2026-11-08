import CatalogTabs from "./CatalogTabs";
import { getBreadcrumbJsonLd } from '@/lib/seo-config';
import JsonLd from '@/components/seo/JsonLd';
import { JsonLdProps } from '@/types/seo';

export default async function WeaponsPage() {
  const jsonLd: JsonLdProps[] = [
    getBreadcrumbJsonLd([
      { name: "홈", item: "/" },
      { name: "도감", item: "/weapons" }
    ]) as JsonLdProps
  ];

  return (
    <>
      <JsonLd data={jsonLd} />
      <CatalogTabs />
    </>
  );
}
