// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, Fragment } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdSenseBanner from "@/components/ads/AdSenseBanner";

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
      createElement(AdSenseBanner, {
        placementId: "stats-top",
        slot: "9810524879",
        width: 320,
        height: 100,
      }),
    ));

    expect(document.querySelectorAll('script[src*="googlesyndication"], #adsbygoogle-main-js')).toHaveLength(0);
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

  it("고정 규격 AdSenseBanner는 format 없이 ins 크기만 지정한다", async () => {
    vi.stubEnv("NODE_ENV", "production");
    render(createElement(AdSenseBanner, {
      placementId: "stats-top",
      slot: "9810524879",
      width: 728,
      height: 90,
    }));

    await waitFor(() => expect(document.querySelectorAll("ins.adsbygoogle")).toHaveLength(1));
    const ins = document.querySelector("ins.adsbygoogle") as HTMLElement;
    expect(ins).toHaveAttribute("data-ad-client", "ca-pub-3993032200487955");
    expect(ins).toHaveAttribute("data-ad-slot", "9810524879");
    expect(ins).not.toHaveAttribute("data-ad-format");
    expect(ins.style.width).toBe("728px");
    expect(ins.style.height).toBe("90px");
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
      createElement(AdSenseBanner, { placementId: "stats-top", slot: "slot", width: 320, height: 100 }),
    ))).not.toThrow();
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });
});
