"use client";

import AdSenseBanner from "./AdSenseBanner";

export type ManualAdRailProps = {
  side: "left" | "right";
  placementId: string;
  slot: string;
  className?: string;
};

/**
 * Fixed-size manual display rail. The parent controls the breakpoint and
 * positioning; this component keeps the creative dimensions and provider
 * ownership consistent across long-form pages.
 */
export function ManualAdRail(props: ManualAdRailProps) {
  const { side, placementId, slot, className = "" } = props;

  return (
    <aside
      aria-label={`${side === "left" ? "왼쪽" : "오른쪽"} 광고`}
      data-ad-rail="manual"
      data-ad-rail-side={side}
      className={`manual-ad-rail manual-ad-rail--${side} ${className}`.trim()}
    >
      <div className="manual-ad-rail__inner">
        <AdSenseBanner placementId={placementId} slot={slot} />
      </div>
    </aside>
  );
}
