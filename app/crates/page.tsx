import { Metadata } from "next";
import { getActiveCrates } from "@/app/actions/crates";
import { getUSDtoKRWRate } from "@/app/actions/exchange-rate";
import CratesClient from "./CratesClient";

export const metadata: Metadata = {
  title: "배그 상자깡 시뮬레이터 & 배그 현질 시뮬",
  description: "배틀그라운드(PUBG) 할리데이비슨 콜라보 상자 및 성장형 무기 밀수품 상자깡 시뮬레이터입니다. 배그 현질 시뮬을 통해 실시간 환율을 반영한 가상 소모 원화와 공식 획득 확률을 정밀하게 검증해 보세요.",
  keywords: [
    "배그 상자깡 시뮬",
    "배그 현질 시뮬",
    "배그 상자깡",
    "배그 현질",
    "PUBG 상자깡 시뮬레이터",
    "배틀그라운드 상자 시뮬레이션",
    "성장형 무기 시뮬레이터",
    "할리데이비슨 상자깡",
    "배그 가챠 시뮬",
    "밀수품 상자 시뮬",
    "BGMS"
  ],
  openGraph: {
    title: "배그 상자깡 시뮬레이터 & 배그 현질 시뮬 - BGMS",
    description: "배틀그라운드(PUBG) 공식 확률 기반의 이중가챠 및 밀수품 상자깡 시뮬레이터입니다. 가상 현질 가격 및 획득 스킨을 테스트해보세요.",
    type: "website",
  },
};

export default async function CratesPage() {
  // 병렬로 API 및 DB 데이터 조회
  const [crates, rate] = await Promise.all([
    getActiveCrates(),
    getUSDtoKRWRate(),
  ]);

  const fallbackRate = 1500;
  const validRate = (typeof rate === "number" && !isNaN(rate) && rate > 0) ? rate : fallbackRate;

  // 브레드크럼 스키마 데이터 (JSON-LD)
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      {
        "@type": "ListItem",
        "position": 1,
        "name": "홈",
        "item": "https://bgms.kr"
      },
      {
        "@type": "ListItem",
        "position": 2,
        "name": "상자깡 시뮬레이터",
        "item": "https://bgms.kr/crates"
      }
    ]
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <main id="crates-simulator-page" className="w-full">
        <CratesClient initialCrates={crates} exchangeRate={validRate} />
      </main>
    </>
  );
}
