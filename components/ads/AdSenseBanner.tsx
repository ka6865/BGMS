'use client';

import { useEffect, useRef } from 'react';
import { BgmsIcon } from '@/components/common/BgmsIcon';

interface AdSenseBannerProps {
  client: string;
  slot: string;
  className?: string;
  format?: string;       // 기본값 'auto'
  layoutKey?: string;    // 인피드 광고 등에 필요한 layout-key
  responsive?: string;   // 'true' | 'false', 기본값 'true'
}

/**
 * 구글 애드센스 배너 광고 컴포넌트
 * - 개발 환경(localhost)에서는 광고 자리를 시각적 플레이스홀더로 표시합니다.
 * - 프로덕션 환경에서는 실제 ins 태그로 구글 애드센스 광고를 노출합니다.
 * - SPA 전환 시에도 ins 태그를 재마운트하여 광고를 재초기화합니다.
 */
export default function AdSenseBanner({
  client,
  slot,
  className,
  format = 'auto',
  layoutKey,
  responsive = 'true',
}: AdSenseBannerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isDev = process.env.NODE_ENV === 'development';
  const isFluid = format === 'fluid';

  useEffect(() => {
    if (isDev) return; // 개발 환경에서는 placeholder만 사용

    const container = containerRef.current;
    if (!container) return;

    // 기존 태그 제거 후 ins와 script 쌍으로 재마운트 (SPA 동적 로드 완벽 보장)
    container.innerHTML = '';

    // 1. 애드센스 메인 스크립트 로드 확인 및 추가 (없을 때만)
    const scriptId = 'adsbygoogle-main-js';
    let mainScript = document.getElementById(scriptId) as HTMLScriptElement;
    if (!mainScript) {
      mainScript = document.createElement('script');
      mainScript.id = scriptId;
      mainScript.async = true;
      mainScript.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${client}`;
      mainScript.crossOrigin = 'anonymous';
      document.head.appendChild(mainScript);
    }

    // 2. ins 태그 생성
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.style.display = 'block';
    ins.setAttribute('data-ad-client', client);
    ins.setAttribute('data-ad-slot', slot);
    ins.setAttribute('data-ad-format', format);
    
    if (layoutKey) {
      ins.setAttribute('data-ad-layout-key', layoutKey);
    }
    if (!isFluid) {
      ins.setAttribute('data-full-width-responsive', responsive);
    }

    // 3. 광고 실행용 스크립트 생성
    const pushScript = document.createElement('script');
    pushScript.innerHTML = '(window.adsbygoogle = window.adsbygoogle || []).push({});';

    container.appendChild(ins);
    container.appendChild(pushScript);
  }, [client, slot, format, layoutKey, responsive, isDev, isFluid]);

  // 개발 환경: 광고 위치 시각적 플레이스홀더 (네이티브/스켈레톤 테마 적용)
  if (isDev) {
    if (isFluid) {
      return (
        <div
          className={className}
          style={{
            width: '100%',
            height: '130px',
            backgroundColor: '#1a1a1a',
            borderRadius: '24px',
            border: '1px solid rgba(255, 255, 255, 0.05)',
            display: 'flex',
            alignItems: 'center',
            padding: '20px',
            boxSizing: 'border-box',
            gap: '16px',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* 좌측 Ad 마크와 이미지 영역 */}
          <div style={{
            width: '90px',
            height: '90px',
            borderRadius: '16px',
            backgroundColor: 'rgba(255, 255, 255, 0.03)',
            border: '1px dashed rgba(66, 133, 244, 0.3)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            flexShrink: 0
          }}>
            <span style={{
              position: 'absolute',
              top: '4px',
              left: '4px',
              backgroundColor: '#ff9f0a',
              color: 'black',
              fontSize: '8px',
              fontWeight: 900,
              padding: '2px 4px',
              borderRadius: '4px',
              lineHeight: 1
            }}>Ad</span>
            <BgmsIcon name="image" size={20} className="text-blue-300/80" />
          </div>

          {/* 중앙 텍스트 스켈레톤 영역 */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '11px', fontWeight: 900, color: 'rgba(66, 133, 244, 0.9)' }}>
                Google In-feed Ad (Fluid)
              </span>
              <span style={{ fontSize: '9px', color: 'rgba(255, 255, 255, 0.2)' }}>
                Slot: {slot}
              </span>
            </div>
            {/* 가상의 타이틀 바 */}
            <div style={{ width: '60%', height: '14px', backgroundColor: 'rgba(255, 255, 255, 0.08)', borderRadius: '4px' }} />
            {/* 가상의 설명글 바 */}
            <div style={{ width: '85%', height: '10px', backgroundColor: 'rgba(255, 255, 255, 0.04)', borderRadius: '3px' }} />
          </div>

          {/* 우측 액션 버튼 스켈레톤 */}
          <div style={{
            width: '80px',
            height: '32px',
            borderRadius: '12px',
            backgroundColor: 'rgba(66, 133, 244, 0.1)',
            border: '1px solid rgba(66, 133, 244, 0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '9px',
            fontWeight: 900,
            color: 'rgba(66, 133, 244, 0.8)',
            flexShrink: 0
          }}>
            자세히 보기
          </div>
        </div>
      );
    }

    // 디스플레이 배너(세로형 등) 플레이스홀더
    return (
      <div
        className={className}
        style={{
          width: '160px',
          height: '600px',
          maxWidth: '100%',
          margin: '0 auto',
          border: '2px dashed rgba(66, 133, 244, 0.4)',
          borderRadius: 8,
          backgroundColor: 'rgba(66, 133, 244, 0.03)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          boxSizing: 'border-box',
          padding: '16px',
          textAlign: 'center',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 800, color: 'rgba(66, 133, 244, 0.8)', letterSpacing: '0.05em' }}>
          GOOGLE ADSENSE
        </span>
        <span style={{ fontSize: 10, color: 'rgba(255, 255, 255, 0.3)' }}>
          160 × 600
        </span>
        <span style={{ fontSize: 9, color: 'rgba(255, 255, 255, 0.15)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
          Slot: {slot}
        </span>
      </div>
    );
  }

  // 프로덕션 환경: 실제 광고 컨테이너
  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        width: isFluid ? '100%' : '160px',
        maxWidth: '100%',
        margin: '0 auto',
      }}
      aria-label="구글 애드센스 광고"
    />
  );
}
