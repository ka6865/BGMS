import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({ posts: vi.fn(), mayhem: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  permanentRedirect: (path: string) => { throw new Error(`redirect:${path}`); },
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    // 조건을 모아 두었다가 limit에서 공지 여부·기간과 함께 넘긴다.
    from: () => {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters[column] = value; return builder; },
        gte: (column: string, value: unknown) => { filters[`${column}>=`] = value; return builder; },
        order: () => builder,
        limit: (count: number) => mocks.posts({ ...filters, limit: count }),
      };
      return builder;
    },
  }),
}));
vi.mock("@/lib/lol/mayhemDatasetStore.server", () => ({ getLatestMayhemPublication: mocks.mayhem }));

beforeEach(() => {
  vi.resetModules();
  mocks.posts.mockImplementation(async (filters: { is_notice: boolean }) => ({ error: null, data: filters.is_notice
    ? [{ id: 7, title: "점검 안내", category: "배그 소식", created_at: "2026-11-09T01:00:00Z" }]
    : [16, 15, 14, 13, 12, 11].map(id => ({ id, title: `새 글 ${id}`, category: id === 16 ? "자유" : null, created_at: `2026-11-0${id - 10}T00:00:00Z` })) }));
  mocks.mayhem.mockResolvedValue({ patch: "16.22", publishedAt: "2026-11-09T22:44:20Z" });
});
afterEach(() => { vi.unstubAllEnvs(); });

const renderHome = async (params: Record<string, string> = {}) => {
  const { default: Home } = await import("@/app/page");
  const page = await Home({ searchParams: Promise.resolve(params) });
  const { default: HomeHub } = await import("@/components/home/HomeHub");
  expect(page.type).toBe(HomeHub);
  return renderToStaticMarkup(await HomeHub());
};

describe("홈 허브", () => {
  it("루트와 추적 쿼리는 지도로 이동하지 않고 두 게임 구역과 소식을 보여 준다", async () => {
    const html = await renderHome({ utm_source: "ad" });
    expect(html).toContain("배틀그라운드");
    expect(html).toContain('href="/lol/kr/aram-mayhem"');
    expect(html).toContain('role="search"');
    expect(html.indexOf("증바람 26.22 조합·증강 자료 갱신")).toBeLessThan(html.indexOf("점검 안내"));
    expect(html).toContain('href="/board/7"');
  });

  it("운영 키 공개 전에는 LoL 전적 메뉴에 개발 중을 표시한다", async () => {
    expect((await renderHome()).match(/개발 중/g)).toHaveLength(3);
    vi.stubEnv("LOL_RIOT_DATA_PUBLIC", "true");
    expect(await renderHome()).not.toContain("개발 중");
  });

  it("공지는 30일 안의 3개까지, 남은 자리는 최신 글로 채워 6개를 날짜순으로 보여 준다", async () => {
    const html = await renderHome();
    const notice = mocks.posts.mock.calls.map(([filters]) => filters).find(filters => filters.is_notice);
    expect(notice.limit).toBe(3);
    expect(Date.now() - Date.parse(notice["created_at>="])).toBeGreaterThanOrEqual(30 * 86_400_000 - 60_000);
    expect(html.match(/href="\/board\//g)).toHaveLength(5);
    expect(html).toContain(">자유<");
    expect(html).toContain(">새 글<");
    expect(html).not.toContain("새 글 12");
    expect(html).not.toContain("새 글 11");
    expect(html.indexOf("증바람 26.22")).toBeLessThan(html.indexOf("점검 안내"));
    expect(html.indexOf("점검 안내")).toBeLessThan(html.indexOf("새 글 16"));
    expect(html.indexOf("새 글 16")).toBeLessThan(html.indexOf("새 글 13"));
  });

  it("소식 조회가 모두 실패하면 소식 구역만 숨긴다", async () => {
    mocks.posts.mockRejectedValue(new Error("db"));
    mocks.mayhem.mockRejectedValue(new Error("db"));
    const html = await renderHome();
    expect(html).not.toContain("최근 소식");
    expect(html).toContain("리그 오브 레전드");
  });

  it("레거시 tab 주소는 계속 영구 이동한다", async () => {
    const { default: Home } = await import("@/app/page");
    await expect(Home({ searchParams: Promise.resolve({ tab: "Miramar" }) })).rejects.toThrow("redirect:/maps/miramar");
    await expect(Home({ searchParams: Promise.resolve({ tab: "Board", postId: "3" }) })).rejects.toThrow("redirect:/board/3");
  });
});
