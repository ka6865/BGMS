import type { Metadata } from "next"; // Next.js 메타데이터 타입
import "./globals.css"; // 전역 스타일시트
import { AuthProvider } from "@/components/AuthProvider";
import { Toaster } from "sonner";
import GlobalHeader from "@/components/common/GlobalHeader";
import BottomNav from "@/components/common/BottomNav";
import { Suspense } from "react";
import JsonLd from "@/components/seo/JsonLd";
import { GoogleAnalytics } from '@next/third-parties/google';
import SidebarFooterWrapper from "@/components/layout/SidebarFooterWrapper";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import PageViewTracker from "@/components/analytics/PageViewTracker";
import Script from "next/script";
import { isVercelSpeedInsightsEnabled } from "@/lib/vercel-usage-controls";

// 브라우저 탭 제목, 설명, 파비콘 메타데이터 정의
const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://bgms.kr";

export const metadata: Metadata = {
  metadataBase: new URL(baseUrl), // 도메인 유연성 확보
  title: {
    default: "BGMS | 배그 고젠 및 고정 차량 위치 - 배틀그라운드 통합 지도",
    template: "%s | BGMS 배그 고젠"
  },
  description: "배틀그라운드 전문 전술 플랫폼 BGMS. 에란겔, 론도 등 모든 맵의 고젠 차량 및 비밀방 위치 지도와 AI 전적 분석, 전적 비교, 가방 계산기, 2D 리플레이, 자기장 시뮬레이션 및 패치노트 정보를 제공합니다.",
  keywords: ["전적 검색", "배그 전적 검색", "배틀그라운드", "배그 지도", "BGMS", "배그 전적", "AI 전적분석", "전적 비교", "가방계산기", "가방시뮬레이션", "2D리플레이", "자기장 시뮬레이션", "배그 패치노트", "배그 고젠", "배그 고정 젠", "에란겔 고젠", "미라마 고젠", "테이고 고젠", "론도 고젠", "PUBG Map", "배그 차량 위치", "비밀의 열쇠", "에란겔 비밀의 열쇠", "미라마 비밀의 열쇠", "테이고 비밀의 열쇠", "론도 비밀의 열쇠", "배그 비밀방 위치", "에란겔 비밀방", "미라마 비밀방", "론도 비밀방", "테이고 비밀방"],
  authors: [{ name: "BGMS Team" }],
  alternates: {
    languages: {
      "ko-KR": "/",
    },
  },
  icons: {
    icon: "/icon.png",
    apple: "/icon.png",
  },
  openGraph: {
    title: "BGMS - 배틀그라운드 모든 맵 차량 위치 및 전술 정보",
    description: "에란겔부터 테이고, 론도까지! 고젠 차량 위치, AI 전적 분석, 가방 계산기, 2D 리플레이 등 배틀그라운드 전장의 모든 전술 정보를 BGMS에서 확인하세요.",
    url: "/",
    siteName: "BGMS",
    images: [
      {
        url: "/logo.png", // 새로 생성한 미니멀 로고 적용
        width: 1200,
        height: 630,
        alt: "BGMS 로고",
      },
    ],
    locale: "ko_KR",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "BGMS - 배틀그라운드 전술 지도 및 전적 서비스",
    description: "에란겔, 테이고, 론도 등 배틀그라운드 비밀의 열쇠 및 차량 위치 정보를 한눈에!",
    images: ["/logo.png"],
  },
  other: {
    "google-adsense-account": "ca-pub-3993032200487955",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#121212",
  appleMobileWebAppCapable: "yes",
  appleMobileWebAppStatusBarStyle: "black-translucent",
};

//  사이트 전체 구조화 데이터 (브랜드 및 검색창 지원)
const siteJsonLd = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "BGMS",
    "url": baseUrl,
    "logo": `${baseUrl}/logo.png`,
    "sameAs": [
      "https://github.com/ka6865/pubg-map-app"
    ]
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "url": baseUrl,
    "potentialAction": {
      "@type": "SearchAction",
      "target": `${baseUrl}/board?search={search_term_string}`,
      "query-input": "required name=search_term_string"
    }
  }
];

// 최상위 HTML 뼈대 렌더링 컴포넌트
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <head>
        <meta name="naver-site-verification" content="7f13af8906644439c3d292d41b1e48a6e85d3f4a8" />
        <JsonLd data={siteJsonLd as any} />
      </head>
      <body className="antialiased bg-[#0d0d0d] text-white">
        <GoogleAnalytics gaId={process.env.NEXT_PUBLIC_GA_ID!} />
        <AuthProvider>
          <PageViewTracker />

          <div className="flex flex-col min-h-dvh">
            <GlobalHeader />
            <SidebarFooterWrapper>
              {children}
            </SidebarFooterWrapper>
            <Suspense fallback={<div className="h-14 bg-[#121212]"></div>}>
              <BottomNav />
            </Suspense>
          </div>
          <Toaster theme="dark" position="top-center" richColors />
          <Analytics />
          {isVercelSpeedInsightsEnabled() && <SpeedInsights />}
        </AuthProvider>
        {/* 카카오 애드핏 전역 스크립트 — 페이지 로드 후 비동기 초기화 */}
        <Script
          src="//t1.kakaocdn.net/kas/static/ba.min.js"
          strategy="afterInteractive"
        />
        {/* 구글 애드센스 전역 스크립트 — 소유권 확인 및 자동 광고 활성화 */}
        <Script
          async
          src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3993032200487955"
          crossOrigin="anonymous"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
