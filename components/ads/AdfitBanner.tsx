'use client';

import { useEffect, useRef } from 'react';

interface AdfitBannerProps {
  adUnit: string;
  adWidth: number;
  adHeight: number;
  className?: string;
}

/**
 * 카카오 애드핏 배너 광고 컴포넌트.
 * - 개발 환경(localhost)에서는 광고 자리를 시각적 placeholder로 표시합니다.
 * - 프로덕션 환경에서는 실제 ins 태그로 카카오 애드핏 광고를 노출합니다.
 * - SPA 전환 시에도 ins 태그를 재마운트하여 광고를 재초기화합니다.
 */
export default function AdfitBanner({ adUnit, adWidth, adHeight, className }: AdfitBannerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isDev = process.env.NODE_ENV === 'development';

  useEffect(() => {
    if (isDev) return; // 개발 환경에서는 placeholder만 사용

    const container = containerRef.current;
    if (!container) return;

    // 기존 태그 제거 후 ins와 script 쌍으로 재마운트 (SPA 동적 로드 완벽 보장)
    container.innerHTML = '';

    const ins = document.createElement('ins');
    ins.className = 'kakao_ad_area';
    // 애드핏 스크립트가 로드 후 표시 상태를 제어하므로 display:none으로 시작한다.
    ins.style.display = 'none';
    ins.setAttribute('data-ad-unit', adUnit);
    ins.setAttribute('data-ad-width', String(adWidth));
    ins.setAttribute('data-ad-height', String(adHeight));

    const script = document.createElement('script');
    script.async = true;
    script.type = 'text/javascript';
    script.src = '//t1.kakaocdn.net/kas/static/ba.min.js';

    container.appendChild(ins);
    container.appendChild(script);
  }, [adUnit, adWidth, adHeight, isDev]);

  // 개발 환경: 광고 위치 시각적 placeholder
  if (isDev) {
    return (
      <div
        className={className}
        style={{
          width: adWidth,
          height: adHeight,
          maxWidth: '100%',
          margin: '0 auto',
          border: '2px dashed rgba(242,169,0,0.5)',
          borderRadius: 6,
          backgroundColor: 'rgba(242,169,0,0.05)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          boxSizing: 'border-box',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(242,169,0,0.7)', letterSpacing: '0.05em' }}>
          AD
        </span>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
          {adWidth} × {adHeight}
        </span>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)', fontFamily: 'monospace' }}>
          {adUnit.slice(0, 16)}…
        </span>
      </div>
    );
  }

  // 프로덕션 환경: 실제 ins 태그 컨테이너
  // 광고 로드 전에도 높이를 예약해 로드 시점에 아래 콘텐츠가 밀리는 현상(CLS)을 방지한다.
  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        width: adWidth,
        height: adHeight,
        maxWidth: '100%',
        margin: '0 auto',
        boxSizing: 'border-box',
      }}
      aria-label="광고"
    />
  );
}
