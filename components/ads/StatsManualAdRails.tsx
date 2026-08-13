"use client";

import { ManualAdRail } from "./ManualAdRail";

const ADSENSE_CLIENT = "ca-pub-3993032200487955";
const ADSENSE_SLOT = "7728921550";
const ADFIT_UNIT = "DAN-RjyosR2uf8eSsVIC";

/** 전적 결과 화면의 좌우 수동 레일을 한 곳에서 소유한다. */
export function StatsManualAdRails() {
  return (
    <>
      <ManualAdRail
        side="left"
        provider="adsense"
        placementId="stats-rail-left"
        client={ADSENSE_CLIENT}
        slot={ADSENSE_SLOT}
        className="stats-manual-ad-rail stats-manual-ad-rail--left"
      />
      <ManualAdRail
        side="right"
        provider="adfit"
        placementId="stats-rail-right"
        adUnit={ADFIT_UNIT}
        className="stats-manual-ad-rail stats-manual-ad-rail--right"
      />
    </>
  );
}
