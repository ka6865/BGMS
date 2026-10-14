import { afterEach, describe, expect, it, vi } from "vitest";

async function loadWithPage(href: string, referrer: string) {
  vi.resetModules();
  const url = new URL(href);
  vi.stubGlobal("window", { location: { hostname: url.hostname, search: url.search } });
  vi.stubGlobal("document", { referrer });
  return import("@/lib/analytics");
}

describe("첫 페이지뷰 유입 출처", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("외부 리퍼러는 도메인만 남기고 경로와 검색어는 버린다", async () => {
    const { consumeLandingAttribution } = await loadWithPage(
      "https://bgms.kr/stats",
      "https://www.google.com/search?q=%EB%B0%B0%EA%B7%B8",
    );
    expect(consumeLandingAttribution()).toEqual({ landing: true, referrer_host: "www.google.com" });
  });

  it("리퍼러가 없으면 direct, 같은 사이트면 internal로 구분한다", async () => {
    const direct = await loadWithPage("https://bgms.kr/crates", "");
    expect(direct.consumeLandingAttribution()?.referrer_host).toBe("direct");

    const internal = await loadWithPage("https://bgms.kr/crates", "https://bgms.kr/maps/erangel");
    expect(internal.consumeLandingAttribution()?.referrer_host).toBe("internal");
  });

  it("utm 값을 길이 제한과 함께 담는다", async () => {
    const longCampaign = "c".repeat(150);
    const { consumeLandingAttribution } = await loadWithPage(
      `https://bgms.kr/crates?utm_source=discord&utm_medium=community&utm_campaign=${longCampaign}`,
      "https://discord.com/",
    );
    expect(consumeLandingAttribution()).toEqual({
      landing: true,
      referrer_host: "discord.com",
      utm_source: "discord",
      utm_medium: "community",
      utm_campaign: "c".repeat(100),
    });
  });

  it("문서 로드 뒤 첫 호출에만 출처를 돌려준다", async () => {
    const { consumeLandingAttribution } = await loadWithPage("https://bgms.kr/stats", "https://www.naver.com/");
    expect(consumeLandingAttribution()).not.toBeNull();
    expect(consumeLandingAttribution()).toBeNull();
  });
});
