import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const notFoundMock = vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); });
vi.mock("next/navigation", () => ({ notFound: notFoundMock, usePathname: () => "/lol/kr/ladder" }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children) }));
vi.mock("@/lib/lol/publicAccess.server", () => ({ requireLolPublicPage: () => undefined }));
vi.mock("@/lib/lol/champions.server", () => ({ getLolChampions: async () => ({ version: "1", champions: [] }) }));
vi.mock("@/lib/lol/ranking.server", () => ({ getCachedLolMasteryBoard: async () => null }));

const { default: LolMastersPage } = await import("@/app/lol/kr/masters/page");
const { default: LolHeader } = await import("@/components/lol/LolHeader");

afterEach(() => { delete process.env.LOL_MASTERS_PUBLIC; notFoundMock.mockClear(); });

describe("장인 경로 플래그", () => {
  it("LOL_MASTERS_PUBLIC이 꺼져 있으면 경로가 404다", async () => {
    await expect(LolMastersPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();
  });

  it("LOL_MASTERS_PUBLIC=true이면 404가 아니다", async () => {
    process.env.LOL_MASTERS_PUBLIC = "true";
    const element = await LolMastersPage({ searchParams: Promise.resolve({}) });
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(element)).toContain("아직 집계되지 않았습니다");
  });
});

describe("LoL 헤더 메뉴", () => {
  it("플래그가 꺼져 있으면 장인 메뉴를 숨기고 랭킹 라벨을 쓴다", () => {
    const html = renderToStaticMarkup(createElement(LolHeader, { mastersEnabled: false }));
    expect(html).toContain(">랭킹<");
    expect(html).not.toContain("/lol/kr/masters");
  });

  it("플래그가 켜져 있으면 장인 메뉴를 보인다", () => {
    const html = renderToStaticMarkup(createElement(LolHeader, { mastersEnabled: true }));
    expect(html).toContain('href="/lol/kr/masters"');
    expect(html).toContain(">장인<");
  });
});
