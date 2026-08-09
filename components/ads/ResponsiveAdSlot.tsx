"use client";

import AdSenseBanner from "@/components/ads/AdSenseBanner";
import AdfitBanner from "@/components/ads/AdfitBanner";
import {
  selectStatsAdCreative,
  statsAdPlacements,
  type AdViewportClass,
  type StatsAdPlacementId,
} from "@/lib/ads/statsAdPlacements";

export interface ResponsiveAdSlotProps {
  placement: StatsAdPlacementId;
  viewportClass: AdViewportClass;
  renderableMatchCount?: number;
  className?: string;
}

export function ResponsiveAdSlot({
  placement,
  viewportClass,
  renderableMatchCount = 0,
  className,
}: ResponsiveAdSlotProps) {
  const registeredPlacement = statsAdPlacements[placement];
  if (!registeredPlacement || renderableMatchCount < registeredPlacement.minRenderableMatches) return null;

  const creative = selectStatsAdCreative({
    placements: statsAdPlacements,
    placement,
    viewportClass,
    renderableMatchCount,
  });
  if (viewportClass !== "unknown" && !creative) return null;

  const classes = [
    "stats-ad-slot",
    `stats-ad-slot--${registeredPlacement.reservation}`,
    `stats-ad-slot--${registeredPlacement.reservationVisibility}`,
    className,
  ].filter(Boolean).join(" ");

  return (
    <div
      aria-label="광고"
      className={classes}
      data-ad-placement={placement}
      data-ad-provider={creative?.provider ?? registeredPlacement.provider}
      data-ad-visibility={registeredPlacement.reservationVisibility}
      data-ad-state={viewportClass === "unknown" ? "reserved" : "mounted"}
    >
      {creative?.provider === "adfit" && (
        <AdfitBanner
          key={`${placement}:${creative.adUnit}:${creative.width}x${creative.height}`}
          placementId={placement}
          adUnit={creative.adUnit}
          adWidth={creative.width}
          adHeight={creative.height}
        />
      )}
      {creative?.provider === "adsense" && (
        <AdSenseBanner
          key={`${placement}:${creative.slot}:${creative.format}`}
          placementId={placement}
          client={creative.client}
          slot={creative.slot}
          format={creative.format}
          layoutKey={creative.layoutKey}
          minHeight={creative.minHeight}
        />
      )}
    </div>
  );
}
