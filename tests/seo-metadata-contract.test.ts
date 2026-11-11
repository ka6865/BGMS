import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }),
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/champions.server", () => ({ getLolChampions: async () => ({ version: "16.22.1", champions: [{ id: 157, imageId: "Yasuo", name: "야스오" }] }) }));
vi.mock("@/lib/lol/mayhemTips.server", () => ({ listMayhemTipSitemap: async () => [{ id: 7, kind: "tip", comment_count: 0, created_at: "2026-11-10T00:00:00Z", updated_at: null }] }));

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

  it("사이트맵은 홈 허브와 실제 페이지를 싣는다", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const urls = (await sitemap()).map((entry) => new URL(entry.url).pathname);
    expect(urls).toEqual(expect.arrayContaining(["/", "/maps/erangel", "/rankings", "/crates", "/board", "/stats"]));
    expect(urls).not.toContain("/meta");
  });

  it("정리한 /meta 시험 페이지는 무기도감으로 영구 이동한다", async () => {
    const { default: nextConfig } = await import("@/next.config");
    const redirects = await nextConfig.redirects?.();
    expect(redirects).toContainEqual({ source: "/meta", destination: "/weapons", permanent: true });
  });

  it("루트는 홈 허브를 렌더링하고 개발·관리 화면은 검색에서 제외한다", () => {
    expect(read("app/page.tsx")).not.toMatch(/\bredirect\(|permanentRedirect\(['"`]\/maps\/erangel['"`]\)/);
    for (const dir of ["test-coordinate", "map-editor"]) {
      expect(read(`app/${dir}/layout.tsx`)).toContain("robots: { index: false, follow: false }");
    }
  });

  it("LoL 공개 시 증바람 본 화면·챔피언별·제보 글만 사이트맵에 싣는다", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    expect((await sitemap()).map((entry) => new URL(entry.url).pathname).filter((path) => path.startsWith("/lol"))).toEqual([]);
    vi.stubEnv("LOL_PUBLIC_ENABLED", "true");
    vi.stubEnv("LOL_MAYHEM_TIPS_ENABLED", "true");
    try {
      const urls = (await sitemap()).map((entry) => new URL(entry.url).pathname).filter((path) => path.startsWith("/lol"));
      expect(urls).toEqual(["/lol/kr/aram-mayhem", "/lol/kr/aram-mayhem/champions/yasuo", "/lol/kr/aram-mayhem/tips/7"]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("증바람 메타데이터는 LoL 레이아웃의 검색 제외를 덮어쓰고 답변 없는 질문만 제외한다", async () => {
    const { mayhemMetadata } = await import("@/lib/lol/mayhemSeo");
    const meta = mayhemMetadata("t", "d", "/lol/kr/aram-mayhem");
    expect(meta.robots).toEqual({ index: true, follow: true });
    expect(meta.alternates?.canonical).toBe("/lol/kr/aram-mayhem");
    expect(mayhemMetadata("t", "d", "/x", false).robots).toEqual({ index: false, follow: true });
    expect(read("app/lol/kr/aram-mayhem/tips/[id]/page.tsx")).toContain("!question || tip.comments > 0");
    expect(read("app/lol/kr/aram-mayhem/tips/[id]/page.tsx")).toContain('.replace(/</g, "\\\\u003c")');
  });
});
