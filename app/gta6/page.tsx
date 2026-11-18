import GtaExplorer from "@/components/gta6/GtaExplorer";
import JsonLd from "@/components/seo/JsonLd";
import { getBreadcrumbJsonLd } from "@/lib/seo-config";

export default function Gta6Page() {
  return <>
    <JsonLd data={[{
      "@context": "https://schema.org", "@type": "WebPage", name: "GTA6 지도", inLanguage: "ko-KR",
      description: "레오니다와 바이스 시티를 한국어로 검색하는 GTA6 커뮤니티 지도",
      about: { "@type": "VideoGame", name: "Grand Theft Auto VI", alternateName: "GTA6" },
    }, getBreadcrumbJsonLd([{ name: "BGMS", item: "/" }, { name: "GTA6 지도", item: "/gta6" }])]} />
    <GtaExplorer />
  </>;
}
