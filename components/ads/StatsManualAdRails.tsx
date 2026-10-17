"use client";

import { useSyncExternalStore } from "react";
import { ADSENSE_SLOTS } from "@/lib/ads/adsenseUnits";
import AdSenseBanner from "./AdSenseBanner";
import { ManualAdRail } from "./ManualAdRail";

/**
 * 전적 결과 화면 좌우 레일의 화면별 구성.
 * - stack: 300x250 위에 300x600을 함께 고정한다(상단 80px + 858px가 화면 높이 안에 들어올 때).
 * - tall: 높이가 부족하면 300x600 하나만 고정한다.
 * - narrow: 1200px 본문 양옆에 160px 레일만 들어가는 폭이다.
 */
export type StatsRailLayout = "none" | "narrow" | "tall" | "stack";

const RAIL_MEDIA_QUERIES = [
  "(min-width: 1600px)",
  "(min-width: 1880px)",
  "(min-height: 940px)",
] as const;

export function resolveStatsRailLayout(snapshot: { min1600: boolean; min1880: boolean; minHeight940: boolean }): StatsRailLayout {
  if (snapshot.min1880) return snapshot.minHeight940 ? "stack" : "tall";
  return snapshot.min1600 ? "narrow" : "none";
}

function readStatsRailLayout(): StatsRailLayout {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "none";
  const [min1600, min1880, minHeight940] = RAIL_MEDIA_QUERIES.map((query) => window.matchMedia(query).matches);
  return resolveStatsRailLayout({ min1600, min1880, minHeight940 });
}

function subscribeToRailMediaQueries(onStoreChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mediaQueries = RAIL_MEDIA_QUERIES.map((query) => window.matchMedia(query));
  for (const mediaQuery of mediaQueries) mediaQuery.addEventListener("change", onStoreChange);
  return () => {
    for (const mediaQuery of mediaQueries) mediaQuery.removeEventListener("change", onStoreChange);
  };
}

function WideAdRail({ side, layout }: { side: "left" | "right"; layout: "tall" | "stack" }) {
  const topSlot = side === "left" ? ADSENSE_SLOTS.statsRailLeftTop : ADSENSE_SLOTS.statsRailRightTop;
  const tallSlot = side === "left" ? ADSENSE_SLOTS.statsRailLeftHalf : ADSENSE_SLOTS.statsRailRightHalf;

  return (
    <aside
      aria-label={`${side === "left" ? "왼쪽" : "오른쪽"} 광고`}
      data-ad-rail="manual"
      data-ad-rail-side={side}
      data-ad-rail-layout={layout}
      className={`manual-ad-rail stats-manual-ad-rail stats-manual-ad-rail--wide stats-manual-ad-rail--${side}`}
    >
      <div className="manual-ad-rail__inner">
        {layout === "stack" && (
          <AdSenseBanner placementId={`stats-rail-${side}-top`} slot={topSlot} width={300} height={250} />
        )}
        <AdSenseBanner placementId={`stats-rail-${side}-tall`} slot={tallSlot} width={300} height={600} />
      </div>
    </aside>
  );
}

/** 전적 결과 화면의 좌우 수동 레일을 한 곳에서 소유한다. 현재 화면에 맞는 구성 하나만 마운트한다. */
export function StatsManualAdRails() {
  const layout = useSyncExternalStore(subscribeToRailMediaQueries, readStatsRailLayout, () => "none" as const);

  if (layout === "none") return null;
  if (layout === "narrow") {
    return (
      <>
        <ManualAdRail
          side="left"
          placementId="stats-rail-left"
          slot={ADSENSE_SLOTS.statsRailLeft}
          className="stats-manual-ad-rail stats-manual-ad-rail--left"
        />
        <ManualAdRail
          side="right"
          placementId="stats-rail-right"
          slot={ADSENSE_SLOTS.statsRailRight}
          className="stats-manual-ad-rail stats-manual-ad-rail--right"
        />
      </>
    );
  }
  return (
    <>
      <WideAdRail side="left" layout={layout} />
      <WideAdRail side="right" layout={layout} />
    </>
  );
}
