// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, Fragment, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdSenseBanner from "@/components/ads/AdSenseBanner";
import AdfitBanner from "@/components/ads/AdfitBanner";

describe("ad provider initialization", () => {
  beforeEach(() => {
    document.head.querySelectorAll("script").forEach((script) => script.remove());
    document.body.innerHTML = "";
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("local/test에서는 외부 provider script를 만들지 않는다", () => {
    vi.stubEnv("NODE_ENV", "test");
    render(createElement(Fragment, null,
      createElement(AdSenseBanner, {
        placementId: "stats-after-5",
        client: "ca-pub-3993032200487955",
        slot: "4661728917",
        format: "fluid",
      }),
      createElement(AdfitBanner, {
        placementId: "stats-top",
        adUnit: "DAN-tQGcqmddMC8tPpXA",
        adWidth: 320,
        adHeight: 100,
      }),
    ));

    expect(document.querySelectorAll('script[src*="googlesyndication"], script[src*="kakaocdn"], #adsbygoogle-main-js')).toHaveLength(0);
  });

  it("AdSenseBanner는 production에서도 main script 소유권을 가져가지 않는다", async () => {
    vi.stubEnv("NODE_ENV", "production");
    render(createElement(AdSenseBanner, {
      placementId: "stats-after-5",
      client: "ca-pub-3993032200487955",
      slot: "4661728917",
      format: "fluid",
      layoutKey: "-fb+5w+4e-db+86",
      minHeight: 130,
    }));

    await waitFor(() => expect(document.querySelectorAll("ins.adsbygoogle")).toHaveLength(1));
    expect(document.getElementById("adsbygoogle-main-js")).toBeNull();
    expect(document.querySelectorAll("[data-ad-placement]")).toHaveLength(0);
  });

  it("StrictMode와 동일 creative 두 인스턴스에도 live Kakao area/script는 하나다", async () => {
    vi.stubEnv("NODE_ENV", "production");
    render(createElement(StrictMode, null,
      createElement(Fragment, null,
        createElement(AdfitBanner, {
          placementId: "stats-top",
          adUnit: "DAN-tQGcqmddMC8tPpXA",
          adWidth: 320,
          adHeight: 100,
        }),
        createElement(AdfitBanner, {
          placementId: "stats-top",
          adUnit: "DAN-tQGcqmddMC8tPpXA",
          adWidth: 320,
          adHeight: 100,
        }),
      ),
    ));

    await waitFor(() => expect(document.querySelectorAll("ins.kakao_ad_area")).toHaveLength(1));
    expect(document.querySelectorAll('script[src*="ba.min.js"]')).toHaveLength(1);
    expect(document.querySelectorAll("[data-ad-placement]")).toHaveLength(0);
  });

  it("breakpoint creative replacement 뒤 새 Kakao 규격 하나만 남는다", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const view = render(createElement(AdfitBanner, {
      key: "stats-top:mobile",
      placementId: "stats-top",
      adUnit: "DAN-tQGcqmddMC8tPpXA",
      adWidth: 320,
      adHeight: 100,
    }));
    await waitFor(() => expect(document.querySelectorAll("ins.kakao_ad_area")).toHaveLength(1));

    view.rerender(createElement(AdfitBanner, {
      key: "stats-top:tablet",
      placementId: "stats-top",
      adUnit: "DAN-dPiCxgIGtXKjLPP3",
      adWidth: 728,
      adHeight: 90,
    }));

    await waitFor(() => expect(document.querySelector("ins.kakao_ad_area")).toHaveAttribute("data-ad-unit", "DAN-dPiCxgIGtXKjLPP3"));
    expect(document.querySelectorAll("ins.kakao_ad_area")).toHaveLength(1);
    expect(document.querySelectorAll('script[src*="ba.min.js"]')).toHaveLength(1);
  });

  it("현재 AdFit owner가 unmount되어도 duplicate claimant로 live creative를 넘긴다", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const banner = (key: string) => createElement(AdfitBanner, {
      key,
      placementId: "stats-top",
      adUnit: "DAN-tQGcqmddMC8tPpXA",
      adWidth: 320,
      adHeight: 100,
    });
    const view = render(createElement(Fragment, null, banner("owner"), banner("claimant")));
    await waitFor(() => expect(document.querySelectorAll("ins.kakao_ad_area")).toHaveLength(1));

    view.rerender(createElement(Fragment, null, banner("claimant")));

    await waitFor(() => expect(document.querySelectorAll("ins.kakao_ad_area")).toHaveLength(1));
    expect(document.querySelector("ins.kakao_ad_area")).toHaveAttribute("data-ad-unit", "DAN-tQGcqmddMC8tPpXA");
    expect(document.querySelectorAll('script[src*="ba.min.js"]')).toHaveLength(1);

    view.unmount();
    expect(document.querySelectorAll("ins.kakao_ad_area")).toHaveLength(0);
    expect(document.querySelectorAll('script[src*="ba.min.js"]')).toHaveLength(0);

    render(banner("remount"));
    await waitFor(() => expect(document.querySelectorAll("ins.kakao_ad_area")).toHaveLength(1));
    expect(document.querySelectorAll('script[src*="ba.min.js"]')).toHaveLength(1);
  });

  it("throwing adsbygoogle.push는 격리되고 다음 mount가 다시 초기화한다", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const throwingPush = vi.fn(() => { throw new Error("push failed"); });
    vi.stubGlobal("adsbygoogle", { push: throwingPush });
    const props = {
      placementId: "stats-after-5",
      client: "ca-pub-3993032200487955",
      slot: "4661728917",
      format: "fluid",
    };

    const first = render(createElement(AdSenseBanner, props));
    await waitFor(() => expect(throwingPush).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll("ins.adsbygoogle")).toHaveLength(0);
    first.unmount();

    const healthyPush = vi.fn();
    vi.stubGlobal("adsbygoogle", { push: healthyPush });
    render(createElement(AdSenseBanner, props));
    await waitFor(() => expect(healthyPush).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll("ins.adsbygoogle")).toHaveLength(1);
  });

  it("provider 초기화 예외는 콘텐츠로 전파하지 않는다", () => {
    vi.stubEnv("NODE_ENV", "production");
    const nativeAppendChild = HTMLElement.prototype.appendChild;
    vi.spyOn(HTMLElement.prototype, "appendChild").mockImplementation(function <T extends Node>(this: HTMLElement, node: T): T {
      if (node instanceof HTMLScriptElement || node instanceof HTMLModElement) {
        throw new Error("provider init failed");
      }
      return nativeAppendChild.call(this, node) as T;
    });

    expect(() => render(createElement(Fragment, null,
      createElement("div", { "data-testid": "content" }, "content"),
      createElement(AdSenseBanner, { client: "ca-pub", slot: "slot", format: "fluid" }),
      createElement(AdfitBanner, { placementId: "stats-top", adUnit: "DAN-test", adWidth: 320, adHeight: 100 }),
    ))).not.toThrow();
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });
});
