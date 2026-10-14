"use client";

import { ADSENSE_SLOTS } from "@/lib/ads/adsenseUnits";
import { ManualAdRail } from "./ManualAdRail";

/** 전적 결과 화면의 좌우 수동 레일을 한 곳에서 소유한다. */
export function StatsManualAdRails() {
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
