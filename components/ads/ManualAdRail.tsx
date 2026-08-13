"use client";

import AdfitBanner from "./AdfitBanner";
import AdSenseBanner from "./AdSenseBanner";

type SharedProps = {
  side: "left" | "right";
  placementId: string;
  className?: string;
};

type AdfitRailProps = SharedProps & {
  provider: "adfit";
  adUnit: string;
};

type AdSenseRailProps = SharedProps & {
  provider: "adsense";
  client: string;
  slot: string;
};

export type ManualAdRailProps = AdfitRailProps | AdSenseRailProps;

/**
 * Fixed-size manual display rail. The parent controls the breakpoint and
 * positioning; this component keeps the creative dimensions and provider
 * ownership consistent across long-form pages.
 */
export function ManualAdRail(props: ManualAdRailProps) {
  const { side, placementId, className = "" } = props;

  return (
    <aside
      aria-label={`${side === "left" ? "왼쪽" : "오른쪽"} 광고`}
      data-ad-rail="manual"
      data-ad-rail-side={side}
      className={`manual-ad-rail manual-ad-rail--${side} ${className}`.trim()}
    >
      <div className="manual-ad-rail__inner">
        {props.provider === "adfit" ? (
          <AdfitBanner
            placementId={placementId}
            adUnit={props.adUnit}
            adWidth={160}
            adHeight={600}
          />
        ) : (
          <AdSenseBanner
            placementId={placementId}
            client={props.client}
            slot={props.slot}
          />
        )}
      </div>
    </aside>
  );
}
