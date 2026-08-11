// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, StrictMode, useEffect, useRef } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adfitMount, adfitRender, adfitUnmount, adsenseRender } = vi.hoisted(() => ({
  adfitMount: vi.fn(),
  adfitRender: vi.fn(),
  adfitUnmount: vi.fn(),
  adsenseRender: vi.fn(),
}));

vi.mock("@/components/ads/AdfitBanner", () => ({
  default: function MockAdfitBanner(props: Record<string, unknown>) {
    adfitRender(props);
    const initialProps = useRef(props);
    useEffect(() => {
      const mountedProps = initialProps.current;
      adfitMount(mountedProps);
      return () => adfitUnmount(mountedProps);
    }, []);
    return createElement("div", { "data-testid": "adfit-creative", "data-width": props.adWidth });
  },
}));
vi.mock("@/components/ads/AdSenseBanner", () => ({
  default: (props: Record<string, unknown>) => {
    adsenseRender(props);
    return createElement("div", { "data-testid": "adsense-creative" });
  },
}));

import { ResponsiveAdSlot } from "@/components/ads/ResponsiveAdSlot";
import { useAdViewportClass } from "@/hooks/useAdViewportClass";

function installMatchMedia(width: number) {
  const mediaQueries = new Map<string, MediaQueryList>();
  vi.stubGlobal("matchMedia", vi.fn((query: string) => {
    const existing = mediaQueries.get(query);
    if (existing) return existing;
    const value = {
      matches: query.includes("1600") ? width >= 1600
        : query.includes("1280") ? width >= 1280
          : width >= 768,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList;
    mediaQueries.set(query, value);
    return value;
  }));
  return mediaQueries;
}

function HookedTopSlot() {
  const viewportClass = useAdViewportClass();
  return createElement(ResponsiveAdSlot, { placement: "stats-top", viewportClass });
}

describe("ResponsiveAdSlot", () => {
  beforeEach(() => {
    adfitMount.mockReset();
    adfitRender.mockReset();
    adfitUnmount.mockReset();
    adsenseRender.mockReset();
    delete process.env.NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("unknown에서는 예약 container만 렌더하고 provider를 마운트하지 않는다", () => {
    render(createElement("div", { className: "stats-page" },
      createElement(ResponsiveAdSlot, {
        placement: "stats-mobile-after-6",
        viewportClass: "unknown",
        renderableMatchCount: 7,
      }),
    ));

    const slot = screen.getByLabelText("광고");
    expect(slot).toHaveAttribute("data-ad-state", "reserved");
    expect(slot).toHaveAttribute("data-ad-visibility", "mobile-only");
    expect(slot).toHaveClass("stats-ad-slot--mobile-only");
    expect(slot.closest(".stats-page")).not.toBeNull();
    expect(adfitRender).not.toHaveBeenCalled();
    expect(adsenseRender).not.toHaveBeenCalled();
  });

  it("resolved viewport에서는 active creative 하나만 마운트한다", () => {
    const view = render(createElement(ResponsiveAdSlot, {
      placement: "stats-top",
      viewportClass: "mobile",
    }));

    expect(screen.getByLabelText("광고")).toHaveAttribute("data-ad-state", "mounted");
    expect(adfitRender).toHaveBeenCalledTimes(1);
    expect(adfitRender).toHaveBeenLastCalledWith(expect.objectContaining({ adWidth: 320, adHeight: 100 }));

    view.rerender(createElement(ResponsiveAdSlot, {
      placement: "stats-top",
      viewportClass: "tablet",
    }));
    expect(adfitRender).toHaveBeenCalledTimes(2);
    expect(adfitRender).toHaveBeenLastCalledWith(expect.objectContaining({ adWidth: 728, adHeight: 90 }));
    expect(screen.getAllByTestId("adfit-creative")).toHaveLength(1);
    expect(adfitMount).toHaveBeenCalledTimes(2);
    expect(adfitUnmount).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[data-ad-placement="stats-top"]')).toHaveLength(1);
    expect(adsenseRender).not.toHaveBeenCalled();
  });

  it("tablet after-5는 AdSense adapter 계약을 그대로 전달한다", () => {
    render(createElement(ResponsiveAdSlot, {
      placement: "stats-after-5",
      viewportClass: "tablet",
      renderableMatchCount: 6,
    }));

    expect(adsenseRender).toHaveBeenCalledTimes(1);
    expect(adsenseRender).toHaveBeenCalledWith(expect.objectContaining({
      placementId: "stats-after-5",
      minHeight: 130,
      client: "ca-pub-3993032200487955",
      slot: "4661728917",
      format: "fluid",
      layoutKey: "-fb+5w+4e-db+86",
    }));
    expect(adfitRender).not.toHaveBeenCalled();
  });

  it("feed unit이 없으면 resolved after-10 container도 만들지 않는다", async () => {
    vi.stubEnv("NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT", "   ");
    vi.resetModules();
    const { ResponsiveAdSlot: MissingFeedSlot } = await import("@/components/ads/ResponsiveAdSlot");
    const { container } = render(createElement(MissingFeedSlot, {
      placement: "stats-after-10",
      viewportClass: "tablet",
      renderableMatchCount: 16,
    }));

    expect(container).toBeEmptyDOMElement();
    expect(adfitRender).not.toHaveBeenCalled();
    expect(adsenseRender).not.toHaveBeenCalled();
  });

  it("server unknown markup을 hydration한 뒤 mobile creative 하나로 해소한다", async () => {
    const mediaQueries = installMatchMedia(375);
    const serverMarkup = renderToString(createElement(HookedTopSlot));
    expect(serverMarkup).toContain('data-ad-state="reserved"');
    expect(adfitRender).not.toHaveBeenCalled();

    const container = document.createElement("div");
    container.innerHTML = serverMarkup;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onRecoverableError = vi.fn();
    const root = hydrateRoot(container, createElement(StrictMode, null, createElement(HookedTopSlot)), {
      onRecoverableError,
    });

    await waitFor(() => expect(container.querySelectorAll('[data-testid="adfit-creative"]')).toHaveLength(1));
    expect(container.querySelectorAll('[data-testid="adfit-creative"]')).toHaveLength(1);
    expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/hydration|did not match/i);
    expect(onRecoverableError).not.toHaveBeenCalled();

    for (const mediaQuery of mediaQueries.values()) {
      expect(mediaQuery.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    }

    await act(async () => root.unmount());
    for (const mediaQuery of mediaQueries.values()) {
      expect(mediaQuery.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
      expect(vi.mocked(mediaQuery.removeEventListener).mock.calls.length)
        .toBe(vi.mocked(mediaQuery.addEventListener).mock.calls.length);
    }
    container.remove();
  });
});
