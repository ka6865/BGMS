// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, StrictMode, useEffect, useRef } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adsenseMount, adsenseRender, adsenseUnmount } = vi.hoisted(() => ({
  adsenseMount: vi.fn(),
  adsenseRender: vi.fn(),
  adsenseUnmount: vi.fn(),
}));

vi.mock("@/components/ads/AdSenseBanner", () => ({
  default: function MockAdSenseBanner(props: Record<string, unknown>) {
    adsenseRender(props);
    const initialProps = useRef(props);
    useEffect(() => {
      const mountedProps = initialProps.current;
      adsenseMount(mountedProps);
      return () => adsenseUnmount(mountedProps);
    }, []);
    return createElement("div", { "data-testid": "adsense-creative", "data-width": props.width });
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
    adsenseMount.mockReset();
    adsenseRender.mockReset();
    adsenseUnmount.mockReset();
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
    expect(adsenseRender).not.toHaveBeenCalled();
  });

  it("resolved viewport에서는 active creative 하나만 마운트한다", () => {
    const view = render(createElement(ResponsiveAdSlot, {
      placement: "stats-top",
      viewportClass: "mobile",
    }));

    expect(screen.getByLabelText("광고")).toHaveAttribute("data-ad-state", "mounted");
    expect(adsenseRender).toHaveBeenCalledTimes(1);
    expect(adsenseRender).toHaveBeenLastCalledWith(expect.objectContaining({ slot: "9810524879", width: 320, height: 100 }));

    view.rerender(createElement(ResponsiveAdSlot, {
      placement: "stats-top",
      viewportClass: "tablet",
    }));
    expect(adsenseRender).toHaveBeenCalledTimes(2);
    expect(adsenseRender).toHaveBeenLastCalledWith(expect.objectContaining({ slot: "9810524879", width: 728, height: 90 }));
    expect(screen.getAllByTestId("adsense-creative")).toHaveLength(1);
    expect(adsenseMount).toHaveBeenCalledTimes(2);
    expect(adsenseUnmount).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[data-ad-placement="stats-top"]')).toHaveLength(1);
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
  });

  it("server unknown markup을 hydration한 뒤 mobile creative 하나로 해소한다", async () => {
    const mediaQueries = installMatchMedia(375);
    const serverMarkup = renderToString(createElement(HookedTopSlot));
    expect(serverMarkup).toContain('data-ad-state="reserved"');
    expect(adsenseRender).not.toHaveBeenCalled();

    const container = document.createElement("div");
    container.innerHTML = serverMarkup;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onRecoverableError = vi.fn();
    const root = hydrateRoot(container, createElement(StrictMode, null, createElement(HookedTopSlot)), {
      onRecoverableError,
    });

    await waitFor(() => expect(container.querySelectorAll('[data-testid="adsense-creative"]')).toHaveLength(1));
    expect(container.querySelectorAll('[data-testid="adsense-creative"]')).toHaveLength(1);
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
