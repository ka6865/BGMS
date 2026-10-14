import { describe, expect, it } from "vitest";
import { resolveAdViewportClass } from "@/hooks/useAdViewportClass";
import { ADSENSE_SLOTS } from "@/lib/ads/adsenseUnits";
import {
  createStatsAdPlacements,
  getStatsFeedSlots,
  selectStatsAdCreative,
} from "@/lib/ads/statsAdPlacements";

describe("stats ad placements", () => {
  const placements = createStatsAdPlacements();

  it.each([
    [{ min768: false, min1280: false, min1600: false }, "mobile"],
    [{ min768: true, min1280: false, min1600: false }, "tablet"],
    [{ min768: true, min1280: true, min1600: false }, "desktop"],
    [{ min768: true, min1280: true, min1600: true }, "wide"],
  ] as const)("media query snapshot %o를 %s로 분류한다", (snapshot, expected) => {
    expect(resolveAdViewportClass(snapshot)).toBe(expected);
  });

  it("상단은 viewport별 애드센스 고정 규격 하나만 선택한다", () => {
    expect(selectStatsAdCreative({
      placements,
      placement: "stats-top",
      viewportClass: "mobile",
      renderableMatchCount: 0,
    })).toMatchObject({ provider: "adsense", slot: ADSENSE_SLOTS.statsTop, format: "fixed", width: 320, height: 100 });

    expect(selectStatsAdCreative({
      placements,
      placement: "stats-top",
      viewportClass: "wide",
      renderableMatchCount: 0,
    })).toMatchObject({ provider: "adsense", slot: ADSENSE_SLOTS.statsTop, format: "fixed", width: 728, height: 90 });
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
    [15, [5]],
    [16, [5, 15]],
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
      expect.objectContaining({ afterMatchCount: 15, reservationVisibility: "tablet-up", state: "reserved" }),
    ]));
  });

  it.each([
    [5, []],
    [6, [5]],
    [7, [5, 6]],
    [15, [5, 6]],
    [16, [5, 6, 15]],
  ])("unknown renderable %i개는 trailing 없는 SSR reservation %o", (renderableMatchCount, expected) => {
    expect(getStatsFeedSlots({
      placements,
      viewportClass: "unknown",
      renderableMatchCount,
    }).map((slot) => slot.afterMatchCount)).toEqual(expected);
  });

  it("전적 화면 광고는 모두 애드센스 단위만 사용한다", () => {
    for (const value of Object.values(placements)) {
      expect(value.provider).toBe("adsense");
      for (const creative of Object.values(value.creatives)) expect(creative?.provider).toBe("adsense");
    }
  });
});
