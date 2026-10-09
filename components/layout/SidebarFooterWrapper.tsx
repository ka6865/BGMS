'use client';

import { usePathname } from 'next/navigation';
import Script from 'next/script';
import Footer from '../common/Footer';
import { shouldLoadExternalAdScripts } from '@/lib/ads/statsAdPlacements';

/**
 * 지도 페이지와 일반 페이지의 레이아웃(푸터 노출 여부 등)을 
 * 현재 경로에 따라 동적으로 처리하는 래퍼 컴포넌트입니다.
 */
export default function SidebarFooterWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  
  // 메인 홈(/) 또는 상세 지도(/maps/...) 경로인 경우 지도 레이아웃으로 간주
  const isMapPage = pathname === '/' || pathname.startsWith('/maps/');
  // 3D 리플레이 경로인 경우 (헤더/하단바가 없으므로 전체화면 레이아웃)
  const isReplayPage = pathname.startsWith('/replay/');
  // 어드민 도구는 앱 화면처럼 동작하므로 공용 푸터를 붙이지 않는다.
  const isAdminToolPage = pathname.startsWith('/admin/');
  const isSupportPage = pathname === '/support' || pathname.startsWith('/support/');
  const isAdminSupportPage = pathname === '/admin/support' || pathname.startsWith('/admin/support/');
  const isAdFreePage = isAdminToolPage || isSupportPage;

  return (
    <>
      <main data-ad-free={isAdFreePage || undefined} className={`flex-grow relative flex flex-col ${
        isReplayPage 
          ? 'overflow-hidden h-dvh' 
          : isMapPage || (isAdminToolPage && !isAdminSupportPage)
            ? 'overflow-hidden h-[calc(100dvh-56px)]' 
            : 'overflow-visible'
      }`}>
        {children}
      </main>
      {/* 지도, 리플레이, 어드민 도구 페이지가 아닐 때만 하단 글로벌 푸터를 노출하여 스크롤 트랩 방지 */}
      {!isMapPage && !isReplayPage && !isAdminToolPage && <Footer />}
      {!isAdFreePage && shouldLoadExternalAdScripts(process.env.NODE_ENV) && (
        <Script
          id="adsbygoogle-main-js"
          async
          src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3993032200487955"
          crossOrigin="anonymous"
          strategy="afterInteractive"
        />
      )}
    </>
  );
}
