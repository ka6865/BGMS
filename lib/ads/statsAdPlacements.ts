import type { AdViewportClass } from "@/hooks/useAdViewportClass";

export type { AdViewportClass } from "@/hooks/useAdViewportClass";

export type StatsAdPlacementId =
  | "stats-top"
  | "stats-mobile-after-6"
  | "stats-after-5"
  | "stats-after-10"
  | "stats-after-15";

export type AdFitCreative = Readonly<{
  provider: "adfit";
  adUnit: string;
  width: 320 | 728;
  height: 100 | 90;
}>;

export type AdSenseFluidCreative = Readonly<{
  provider: "adsense";
  client: string;
  slot: string;
  format: "fluid";
  layoutKey: string;
  minHeight: 130;
}>;

export type ManualAdCreative = AdFitCreative | AdSenseFluidCreative;
export type AdReservationVisibility = "all" | "mobile-only" | "tablet-up";

export interface StatsAdPlacement {
  id: StatsAdPlacementId;
  provider: "adfit" | "adsense";
  afterMatchCount: 5 | 6 | 10 | 15 | null;
  minRenderableMatches: 0 | 6 | 7 | 11 | 16;
  reservation: "responsive-horizontal" | "fluid-infeed" | "tablet-horizontal";
  reservationVisibility: AdReservationVisibility;
  creatives: Partial<Record<Exclude<AdViewportClass, "unknown">, ManualAdCreative>>;
}

export interface StatsFeedSlot {
  placement: Exclude<StatsAdPlacementId, "stats-top">;
  provider: "adfit" | "adsense";
  afterMatchCount: 5 | 6 | 10 | 15;
  reservationVisibility: Exclude<AdReservationVisibility, "all">;
  state: "reserved" | "mounted";
}

const ADSENSE_CLIENT = "ca-pub-3993032200487955";
const ADSENSE_FLUID_SLOT = "4661728917";
const ADSENSE_FLUID_LAYOUT_KEY = "-fb+5w+4e-db+86";
const ADFIT_MOBILE_UNIT = "DAN-tQGcqmddMC8tPpXA";
const ADFIT_TOP_LEADERBOARD_UNIT = "DAN-dPiCxgIGtXKjLPP3";

const fluidCreative = (): AdSenseFluidCreative => ({
  provider: "adsense",
  client: ADSENSE_CLIENT,
  slot: ADSENSE_FLUID_SLOT,
  format: "fluid",
  layoutKey: ADSENSE_FLUID_LAYOUT_KEY,
  minHeight: 130,
});

export function shouldLoadExternalAdScripts(nodeEnv: string | undefined): boolean {
  return nodeEnv === "production";
}

export function createStatsAdPlacements(config: {
  feedAdfitUnit?: string;
}): Readonly<Record<StatsAdPlacementId, StatsAdPlacement | null>> {
  const feedAdfitUnit = config.feedAdfitUnit?.trim() || undefined;
  const topMobile: AdFitCreative = {
    provider: "adfit",
    adUnit: ADFIT_MOBILE_UNIT,
    width: 320,
    height: 100,
  };
  const topTablet: AdFitCreative = {
    provider: "adfit",
    adUnit: ADFIT_TOP_LEADERBOARD_UNIT,
    width: 728,
    height: 90,
  };
  const feedAdfit: AdFitCreative | null = feedAdfitUnit
    ? { provider: "adfit", adUnit: feedAdfitUnit, width: 728, height: 90 }
    : null;

  return {
    "stats-top": {
      id: "stats-top",
      provider: "adfit",
      afterMatchCount: null,
      minRenderableMatches: 0,
      reservation: "responsive-horizontal",
      reservationVisibility: "all",
      creatives: {
        mobile: topMobile,
        tablet: topTablet,
        desktop: topTablet,
        wide: topTablet,
      },
    },
    "stats-mobile-after-6": {
      id: "stats-mobile-after-6",
      provider: "adsense",
      afterMatchCount: 6,
      minRenderableMatches: 7,
      reservation: "fluid-infeed",
      reservationVisibility: "mobile-only",
      creatives: { mobile: fluidCreative() },
    },
    "stats-after-5": {
      id: "stats-after-5",
      provider: "adsense",
      afterMatchCount: 5,
      minRenderableMatches: 6,
      reservation: "fluid-infeed",
      reservationVisibility: "tablet-up",
      creatives: { tablet: fluidCreative(), desktop: fluidCreative(), wide: fluidCreative() },
    },
    "stats-after-10": feedAdfit ? {
      id: "stats-after-10",
      provider: "adfit",
      afterMatchCount: 10,
      minRenderableMatches: 11,
      reservation: "tablet-horizontal",
      reservationVisibility: "tablet-up",
      creatives: { tablet: feedAdfit, desktop: feedAdfit, wide: feedAdfit },
    } : null,
    "stats-after-15": {
      id: "stats-after-15",
      provider: "adsense",
      afterMatchCount: 15,
      minRenderableMatches: 16,
      reservation: "fluid-infeed",
      reservationVisibility: "tablet-up",
      creatives: { tablet: fluidCreative(), desktop: fluidCreative(), wide: fluidCreative() },
    },
  };
}

export type StatsAdRegistry = ReturnType<typeof createStatsAdPlacements>;

export const statsAdPlacements = createStatsAdPlacements({
  feedAdfitUnit: process.env.NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT,
});

export function selectStatsAdCreative(input: {
  placements: StatsAdRegistry;
  placement: StatsAdPlacementId;
  viewportClass: AdViewportClass;
  renderableMatchCount: number;
}): ManualAdCreative | null {
  const placement = input.placements[input.placement];
  if (!placement || input.viewportClass === "unknown") return null;
  if (input.renderableMatchCount < placement.minRenderableMatches) return null;
  return placement.creatives[input.viewportClass] ?? null;
}

function toFeedSlot(placement: StatsAdPlacement, state: StatsFeedSlot["state"]): StatsFeedSlot {
  return {
    placement: placement.id as StatsFeedSlot["placement"],
    provider: placement.provider,
    afterMatchCount: placement.afterMatchCount as StatsFeedSlot["afterMatchCount"],
    reservationVisibility: placement.reservationVisibility as StatsFeedSlot["reservationVisibility"],
    state,
  };
}

export function getStatsFeedSlots(input: {
  placements: StatsAdRegistry;
  viewportClass: AdViewportClass;
  renderableMatchCount: number;
}): readonly StatsFeedSlot[] {
  const mobilePlacements = [input.placements["stats-mobile-after-6"]];
  const tabletPlacements = [
    input.placements["stats-after-5"],
    input.placements["stats-after-10"],
    input.placements["stats-after-15"],
  ];
  const candidates = input.viewportClass === "mobile"
    ? mobilePlacements
    : input.viewportClass === "unknown"
      ? [...mobilePlacements, ...tabletPlacements]
      : tabletPlacements;

  return candidates
    .filter((placement): placement is StatsAdPlacement => Boolean(
      placement && input.renderableMatchCount >= placement.minRenderableMatches,
    ))
    .map((placement) => toFeedSlot(placement, input.viewportClass === "unknown" ? "reserved" : "mounted"))
    .sort((left, right) => left.afterMatchCount - right.afterMatchCount);
}
