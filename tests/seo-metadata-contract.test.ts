import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }),
  }),
}));

const read = (path: string) => readFileSync(resolve(path), "utf8");

describe("SEO 메타데이터 계약", () => {
  it("공통 제목 형식이 브랜드를 붙이므로 페이지 제목에 브랜드를 다시 넣지 않는다", async () => {
    expect(read("app/layout.tsx")).toContain('template: "%s | BGMS 배그 고젠"');
    const { getTabSeo } = await import("@/lib/seo-config");
    expect(getTabSeo("Erangel").title).not.toMatch(/BGMS/);
  });

  it("무기 페이지는 레이아웃의 /weapons 정식 주소를 덮어쓰지 않는다", () => {
    expect(read("app/weapons/layout.tsx")).toContain('canonical: "/weapons"');
    expect(read("app/weapons/page.tsx")).not.toMatch(/generateMetadata|getTabSeo/);
  });

  it("사이트맵은 이동하는 루트 대신 실제 페이지를 싣는다", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const urls = (await sitemap()).map((entry) => new URL(entry.url).pathname);
    expect(urls).not.toContain("/");
    expect(urls).toEqual(expect.arrayContaining(["/maps/erangel", "/rankings", "/meta", "/crates", "/board", "/stats"]));
  });

  it("루트는 영구 이동하고 개발·관리 화면은 검색에서 제외한다", () => {
    expect(read("app/page.tsx")).not.toMatch(/\bredirect\(/);
    for (const dir of ["test-coordinate", "map-editor"]) {
      expect(read(`app/${dir}/layout.tsx`)).toContain("robots: { index: false, follow: false }");
    }
  });
});
