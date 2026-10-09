import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({ pathname: "/stats" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("@/components/common/Footer", () => ({ default: () => null }));

vi.mock("next/script", () => ({
  default: function MockScript({ strategy, ...props }: Record<string, unknown>) {
    void strategy;
    return createElement("script", props);
  },
}));
vi.mock("@/components/AuthProvider", () => ({ AuthProvider: ({ children }: { children: unknown }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/common/GlobalHeader", () => ({ default: () => null }));
vi.mock("@/components/common/BottomNav", () => ({ default: () => null }));
vi.mock("@/components/seo/JsonLd", () => ({ default: () => null }));
vi.mock("@next/third-parties/google", () => ({ GoogleAnalytics: () => null }));
vi.mock("@vercel/analytics/react", () => ({ Analytics: () => null }));
vi.mock("@vercel/speed-insights/react", () => ({ SpeedInsights: () => null }));
vi.mock("@/components/analytics/PageViewTracker", () => ({ default: () => null }));
vi.mock("@/lib/vercel-usage-controls", () => ({ isVercelSpeedInsightsEnabled: () => false }));

import RootLayout from "@/app/layout";
import { shouldLoadExternalAdScripts } from "@/lib/ads/statsAdPlacements";

describe("stats auto ads ownership boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    route.pathname = "/stats";
  });

  it.each([
    ["production", true],
    ["development", false],
    ["test", false],
    [undefined, false],
  ] as const)("NODE_ENV %s의 외부 광고 script 허용값은 %s다", (nodeEnv, expected) => {
    expect(shouldLoadExternalAdScripts(nodeEnv)).toBe(expected);
  });

  it("local/test layout은 AdSense main script를 렌더하지 않는다", () => {
    vi.stubEnv("NODE_ENV", "test");
    const html = renderToStaticMarkup(createElement(RootLayout, null, createElement(Fragment)));

    expect(html).not.toContain("adsbygoogle-main-js");
    expect(html).not.toContain("pagead2.googlesyndication.com");
  });

  it("production layout만 AdSense main script를 정확히 하나 소유한다", () => {
    vi.stubEnv("NODE_ENV", "production");
    const html = renderToStaticMarkup(createElement(RootLayout, null, createElement(Fragment)));

    expect(html.match(/id="adsbygoogle-main-js"/g)).toHaveLength(1);
    expect(html.match(/pagead2\.googlesyndication\.com/g)).toHaveLength(1);
    expect(html).not.toContain("auto-ad-side-rail");
    expect(html).not.toContain("auto-ad-anchor");
  });

  it.each(["/admin/support", "/admin/support/ticket-1", "/support", "/support/ticket-1"])(
    "%s는 광고 없이 전체 내용을 스크롤할 수 있다",
    (pathname) => {
      vi.stubEnv("NODE_ENV", "production");
      route.pathname = pathname;
      const html = renderToStaticMarkup(createElement(RootLayout, null, createElement("div", null, "문의")));
      expect(html).not.toContain("adsbygoogle-main-js");
      expect(html).toContain('data-ad-free="true"');
      expect(html).toContain("overflow-visible");
      expect(html).not.toContain("overflow-hidden");
      expect(html).not.toContain("h-[calc(100dvh-56px)]");
    },
  );

  it.each(["/", "/maps/erangel", "/admin/agent", "/replay/match-1"])(
    "%s의 기존 전체 화면 레이아웃을 유지한다",
    (pathname) => {
      route.pathname = pathname;
      const html = renderToStaticMarkup(createElement(RootLayout, null, createElement(Fragment)));
      expect(html).toContain("overflow-hidden");
    },
  );

  it("stats 광고 예약 CSS는 mobile/tablet visibility와 768px 경계를 선언한다", () => {
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

    expect(css).toMatch(/\.stats-page\s+\.stats-ad-slot--mobile-only\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.stats-page\s+\.stats-ad-slot--tablet-up\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/@media\s*\(min-width:\s*768px\)[\s\S]*\.stats-page\s+\.stats-ad-slot--mobile-only\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/@media\s*\(min-width:\s*768px\)[\s\S]*\.stats-page\s+\.stats-ad-slot--tablet-up\s*\{[^}]*display:\s*flex/);
  });

  it("wrapper처c shell은 legacy stats provider/rail/unit ownership을 가지지 않는다", () => {
    const wrapper = readFileSync(join(process.cwd(), "components/stat/StatSearch.tsx"), "utf8");
    const shell = readFileSync(join(process.cwd(), "components/stat/layout/StatsPageShell.tsx"), "utf8");
    const combined = `${wrapper}\n${shell}`;

    expect(wrapper).not.toMatch(/useStatsPageController|useStatsSearchHistory|useStatsProfilePrefill|useStatsAutocomplete/);
    expect(wrapper).not.toMatch(/use(?:State|Effect|Callback|Ref)\s*\(/);
    expect(combined).not.toMatch(/AdSenseBanner|AdfitBanner/);
    expect(combined).not.toMatch(/DAN-tQGcqmddMC8tPpXA|DAN-dPiCxgIGtXKjLPP3|DAN-RjyosR2uf8eSsVIC/);
    expect(combined).not.toMatch(/7728921550/);
    expect(combined).not.toMatch(/w-\[160px\]|160\s*[x×]\s*600/i);
  });
});
