'use client';

import { useEffect, useRef } from 'react';
import { shouldLoadExternalAdScripts } from '@/lib/ads/statsAdPlacements';

interface AdfitBannerProps {
  placementId?: string;
  adUnit: string;
  adWidth: number;
  adHeight: number;
  className?: string;
}

interface AdfitClaim {
  owner: HTMLDivElement | null;
  claimants: Set<HTMLDivElement>;
  adUnit: string;
  adWidth: number;
  adHeight: number;
  placementId: string;
}

const adfitClaims = new Map<string, AdfitClaim>();

function mountAdfitCreative(container: HTMLDivElement, claim: AdfitClaim): void {
  try {
    container.innerHTML = '';
    const ins = document.createElement('ins');
    ins.className = 'kakao_ad_area';
    ins.style.display = 'none';
    ins.setAttribute('data-ad-unit', claim.adUnit);
    ins.setAttribute('data-ad-width', String(claim.adWidth));
    ins.setAttribute('data-ad-height', String(claim.adHeight));
    ins.setAttribute('data-ad-owner-key', `${claim.placementId}:${claim.adUnit}:${claim.adWidth}x${claim.adHeight}`);

    const script = document.createElement('script');
    script.async = true;
    script.type = 'text/javascript';
    script.src = '//t1.kakaocdn.net/kas/static/ba.min.js';
    container.appendChild(ins);
    container.appendChild(script);
  } catch {
    try {
      container.innerHTML = '';
    } catch {
      // provider 초기화 실패는 콘텐츠 상태로 전파하지 않는다.
    }
  }
}

/**
 * 카카오 애드핏 배너 광고 컴포넌트.
 * - 개발 환경(localhost)에서는 광고 자리를 시각적 placeholder로 표시합니다.
 * - 프로덕션 환경에서는 실제 ins 태그로 카카오 애드핏 광고를 노출합니다.
 * - SPA 전환 시에도 ins 태그를 재마운트하여 광고를 재초기화합니다.
 */
export default function AdfitBanner({ placementId, adUnit, adWidth, adHeight, className }: AdfitBannerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const loadExternalAds = shouldLoadExternalAdScripts(process.env.NODE_ENV);
  const resolvedPlacementId = placementId ?? adUnit;
  const creativeSignature = `${resolvedPlacementId}:${adUnit}:${adWidth}x${adHeight}`;

  useEffect(() => {
    if (!loadExternalAds) return;

    const container = containerRef.current;
    if (!container) return;
    let claim = adfitClaims.get(creativeSignature);
    if (!claim) {
      claim = {
        owner: null,
        claimants: new Set(),
        adUnit,
        adWidth,
        adHeight,
        placementId: resolvedPlacementId,
      };
      adfitClaims.set(creativeSignature, claim);
    }
    claim.claimants.add(container);
    if (!claim.owner) {
      claim.owner = container;
      mountAdfitCreative(container, claim);
    }

    return () => {
      const currentClaim = adfitClaims.get(creativeSignature);
      if (!currentClaim) return;
      currentClaim.claimants.delete(container);
      try {
        container.innerHTML = '';
      } catch {
        // cleanup 실패도 provider 경계 내부에서 끝낸다.
      }
      if (currentClaim.owner === container) {
        currentClaim.owner = null;
        const nextOwner = currentClaim.claimants.values().next().value as HTMLDivElement | undefined;
        if (nextOwner) {
          currentClaim.owner = nextOwner;
          mountAdfitCreative(nextOwner, currentClaim);
        }
      }
      if (currentClaim.claimants.size === 0) adfitClaims.delete(creativeSignature);
    };
  }, [adHeight, adUnit, adWidth, creativeSignature, loadExternalAds, resolvedPlacementId]);

  // 개발 환경: 광고 위치 시각적 placeholder
  if (!loadExternalAds) {
    return (
      <div
        className={className}
        data-ad-owner-key={creativeSignature}
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
      data-ad-owner-key={creativeSignature}
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
