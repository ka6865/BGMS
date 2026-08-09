import { describe, expect, it } from "vitest";
import { resolveAdViewportClass } from "@/hooks/useAdViewportClass";
import {
  createStatsAdPlacements,
  getStatsFeedSlots,
  selectStatsAdCreative,
  type AdViewportClass,
} from "@/lib/ads/statsAdPlacements";

describe("stats ad placements", () => {
  const placements = createStatsAdPlacements({
    feedAdfitUnit: "DAN-fixture-stats-feed-728",
  });

  it.each([
    [{ min768: false, min1280: false, min1600: false }, "mobile"],
    [{ min768: true, min1280: false, min1600: false }, "tablet"],
    [{ min768: true, min1280: true, min1600: false }, "desktop"],
    [{ min768: true, min1280: true, min1600: true }, "wide"],
  ] as const)("media query snapshot %o를 %s로 분류한다", (snapshot, expected) => {
    expect(resolveAdViewportClass(snapshot)).toBe(expected);
  });

  it("상단은 viewport별 AdFit 규격 하나만 선택한다", () => {
    expect(selectStatsAdCreative({
      placements,
      placement: "stats-top",
      viewportClass: "mobile",
      renderableMatchCount: 0,
    })).toMatchObject({ provider: "adfit", adUnit: "DAN-tQGcqmddMC8tPpXA", width: 320, height: 100 });

    expect(selectStatsAdCreative({
      placements,
      placement: "stats-top",
      viewportClass: "wide",
      renderableMatchCount: 0,
    })).toMatchObject({ provider: "adfit", adUnit: "DAN-dPiCxgIGtXKjLPP3", width: 728, height: 90 });
  });

  it.each([
    [6, []],
    [7, [6]],
  ])("mobile renderable %i개에서 after slots %o", (renderableMatchCount, expected) => {
    expect(getStatsFeedSlots({
      placements,
      viewportClass: "mobile",
      renderableMatchCount,
    }).map((slot) => slot.afterMatchCount)).toEqual(expected);
  });

  it.each([
    [5, []],
    [6, [5]],
    [10, [5]],
    [11, [5, 10]],
    [15, [5, 10]],
    [16, [5, 10, 15]],
  ])("tablet+ renderable %i개에서 trailing ad 없는 after slots %o", (renderableMatchCount, expected) => {
    for (const viewportClass of ["tablet", "desktop", "wide"] as const) {
      expect(getStatsFeedSlots({
        placements,
        viewportClass,
        renderableMatchCount,
      }).map((slot) => slot.afterMatchCount)).toEqual(expected);
    }
  });

  it("unknown은 provider를 선택하지 않고 viewport별 예약 token만 반환한다", () => {
    expect(selectStatsAdCreative({
      placements,
      placement: "stats-top",
      viewportClass: "unknown",
      renderableMatchCount: 0,
    })).toBeNull();

    expect(getStatsFeedSlots({
      placements,
      viewportClass: "unknown",
      renderableMatchCount: 16,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ afterMatchCount: 6, reservationVisibility: "mobile-only", state: "reserved" }),
      expect.objectContaining({ afterMatchCount: 5, reservationVisibility: "tablet-up", state: "reserved" }),
      expect.objectContaining({ afterMatchCount: 10, reservationVisibility: "tablet-up", state: "reserved" }),
      expect.objectContaining({ afterMatchCount: 15, reservationVisibility: "tablet-up", state: "reserved" }),
    ]));
  });

  it.each([
    [5, []],
    [6, [5]],
    [7, [5, 6]],
    [10, [5, 6]],
    [11, [5, 6, 10]],
    [15, [5, 6, 10]],
    [16, [5, 6, 10, 15]],
  ])("unknown renderable %i개는 trailing 없는 SSR reservation %o", (renderableMatchCount, expected) => {
    expect(getStatsFeedSlots({
      placements,
      viewportClass: "unknown",
      renderableMatchCount,
    }).map((slot) => slot.afterMatchCount)).toEqual(expected);
  });

  it.each([undefined, "", "   "])("feed AdFit env %o가 비어 있으면 after-10 placement와 예약을 모두 생략한다", (feedAdfitUnit) => {
    const withoutFeedAdfit = createStatsAdPlacements({ feedAdfitUnit });

    expect(withoutFeedAdfit["stats-after-10"]).toBeNull();
    for (const viewportClass of ["unknown", "tablet", "desktop", "wide"] as AdViewportClass[]) {
      expect(getStatsFeedSlots({
        placements: withoutFeedAdfit,
        viewportClass,
        renderableMatchCount: 16,
      }).map((slot) => slot.afterMatchCount)).not.toContain(10);
    }
    for (const [placement, value] of Object.entries(withoutFeedAdfit)) {
      if (placement === "stats-top") continue;
      expect(JSON.stringify(value)).not.toContain("DAN-dPiCxgIGtXKjLPP3");
    }
  });
});
