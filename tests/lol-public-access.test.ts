import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({ search: vi.fn(), more: vi.fn(), detail: vi.fn(), resolve: vi.fn(), pathname: "/lol/kr" }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); },
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("next/script", () => ({ default: (props: Record<string, unknown>) => createElement("script", props) }));
vi.mock("@/components/common/Footer", () => ({ default: () => null }));
vi.mock("@/lib/lol/riotSearch.server", () => ({
  searchLolRiotId: mocks.search, getMoreLolMatches: mocks.more, getLolMatchDetails: mocks.detail,
  resolveLolParticipantRef: mocks.resolve, RiotSearchError: class extends Error {},
}));
vi.mock("@/lib/lol/persistence.server", () => ({ LolPersistenceError: class extends Error {} }));

beforeEach(() => { vi.resetAllMocks(); vi.resetModules(); vi.stubEnv("LOL_PUBLIC_ENABLED", "true"); mocks.pathname = "/lol/kr"; });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
const request = (path = "/api/lol/search", ip = "192.0.2.1", body: unknown = { riotId: "홍길동#KR1" }) => new Request(`http://localhost:3000${path}`, {
  method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": ip }, body: JSON.stringify(body),
});
const detailContext = { params: Promise.resolve({ matchId: "KR_123" }) };

describe("LoL 공개 보안 경계", () => {
  it.each([undefined, "false", "TRUE", "1"])("플래그 %s는 페이지·metadata·API·ref를 모두 차단한다", async (value) => {
    vi.stubEnv("LOL_PUBLIC_ENABLED", value);
    const { default: layout } = await import("@/app/lol/layout");
    const { default: page } = await import("@/app/lol/kr/page");
    const { default: profile, generateMetadata } = await import("@/app/lol/kr/[riotId]/page");
    expect(() => layout({ children: "child" })).toThrow("404");
    expect(() => page()).toThrow("404");
    const params = Promise.resolve({ riotId: "홍길동-KR1" });
    await expect(profile({ params })).rejects.toThrow("404");
    await expect(generateMetadata({ params })).rejects.toThrow("404");
    const search = await import("@/app/api/lol/search/route");
    const more = await import("@/app/api/lol/matches/more/route");
    const detail = await import("@/app/api/lol/matches/[matchId]/route");
    const ref = await import("@/app/lol/kr/by-ref/[ref]/route");
    expect((await search.POST(request())).status).toBe(404);
    expect((await more.POST(request())).status).toBe(404);
    expect((await detail.GET(request(), detailContext)).status).toBe(404);
    expect((await ref.GET(request(), { params: Promise.resolve({ ref: "sealed" }) })).status).toBe(404);
    expect(mocks.search).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("공개 검색은 관리자 인증 없이 기존 DTO와 갱신 계약을 전달한다", async () => {
    const { POST } = await import("@/app/api/lol/search/route");
    const dto = { account: { gameName: "홍길동", tagLine: "KR1" }, matches: [], refreshRemainSeconds: 120 };
    mocks.search.mockResolvedValue(dto);
    const payload = await (await POST(request())).json();
    expect(payload).toEqual(dto);
    expect(mocks.search).toHaveBeenCalledWith("홍길동#KR1", { refresh: false });
    mocks.search.mockResolvedValue({ status: "cooldown", remainSeconds: 120, lastUpdatedAt: "2026-10-23" });
    expect(await (await POST(request(undefined, undefined, { riotId: "홍길동#KR1", refresh: true }))).json())
      .toMatchObject({ status: "cooldown", remainSeconds: 120 });
    const serialized = JSON.stringify(payload);
    for (const field of ["puuid", "metrics", "rateLimits", "tables", "pending", "service_role"]) expect(serialized).not.toContain(field);
  });

  it("검색·갱신은 IP당 분당 10회이며 다른 IP와 다음 윈도는 허용한다", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T00:00:00Z"));
    const { POST } = await import("@/app/api/lol/search/route");
    mocks.search.mockResolvedValue({ matches: [] });
    for (let i = 0; i < 10; i++) expect((await POST(request())).status).toBe(200);
    const denied = await POST(request());
    expect(denied.status).toBe(429); expect(denied.headers.get("retry-after")).toBe("60");
    expect(await denied.text()).toContain("잠시 후");
    expect((await POST(request(undefined, "192.0.2.2"))).status).toBe(200);
    vi.advanceTimersByTime(60_000);
    expect((await POST(request())).status).toBe(200);
  });

  it("더보기·상세·ref는 IP당 30회 버킷을 공유한다", async () => {
    const { POST } = await import("@/app/api/lol/matches/more/route");
    const { GET } = await import("@/app/api/lol/matches/[matchId]/route");
    const ref = await import("@/app/lol/kr/by-ref/[ref]/route");
    mocks.more.mockResolvedValue({ matches: [] }); mocks.detail.mockResolvedValue({ teams: [] });
    for (let i = 0; i < 29; i++) expect((await POST(request(undefined, undefined, { riotId: "홍길동#KR1", offset: 5 }))).status).toBe(200);
    expect((await GET(request(), detailContext)).status).toBe(200);
    expect((await ref.GET(request(), { params: Promise.resolve({ ref: "sealed" }) })).status).toBe(429);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("타 출처·Origin 누락은 거부하고 브라우저 same-origin GET은 허용한다", async () => {
    const { POST } = await import("@/app/api/lol/search/route");
    const { GET } = await import("@/app/api/lol/matches/[matchId]/route");
    expect((await POST(new Request("http://localhost:3000/api/lol/search", { method: "POST" }))).status).toBe(403);
    const headers = { host: "localhost:3000", origin: "https://attacker.invalid" };
    expect((await POST(new Request("http://localhost:3000/api/lol/search", { method: "POST", headers }))).status).toBe(403);
    mocks.detail.mockResolvedValue({ teams: [] });
    expect((await GET(new Request("http://localhost:3000/api/lol/matches/KR_123", {
      headers: { host: "localhost:3000", "sec-fetch-site": "same-origin" },
    }), detailContext)).status).toBe(200);
  });

  it("현재 이름으로 공개 경로에만 이동한다", async () => {
    const { GET } = await import("@/app/lol/kr/by-ref/[ref]/route");
    mocks.resolve.mockResolvedValue("홍길동#KR1");
    const result = await GET(new Request("http://localhost:3000/lol/kr/by-ref/sealed"), { params: Promise.resolve({ ref: "sealed" }) });
    expect(result.status).toBe(307);
    expect(result.headers.get("location")).toBe(`http://localhost:3000/lol/kr/${encodeURIComponent("홍길동-KR1")}`);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });

  it("공개 패널은 운영 모듈을 import하지 않고 공통 영문·한국어 고지를 표시한다", async () => {
    const { default: Panel } = await import("@/components/lol/LolSearchPanel");
    const html = renderToStaticMarkup(createElement<{ publicView?: boolean }>(Panel, { publicView: true }));
    expect(html).toContain("Riot Games, and all associated properties");
    expect(html).toContain("상표 또는 등록 상표");
    for (const text of ["계정 데이터 삭제", "운영 상태", "수집 시작", "관리자 전용"]) expect(html).not.toContain(text);
    const source = readFileSync("components/lol/LolSearchPanel.tsx", "utf8");
    expect(source).not.toMatch(/import.*Lol(?:Ops|Collection)Panel/);
    expect((await import("@/app/lol/layout")).metadata.robots).toEqual({ index: false, follow: false });
  });

  it.each(["/lol", "/lol/kr", "/lol/kr/홍길동-KR1"])("프로덕션 %s 레이아웃에서 광고 스크립트·슬롯을 렌더링하지 않는다", async (path) => {
    mocks.pathname = path;
    vi.stubEnv("NODE_ENV", "production");
    const { default: Wrapper } = await import("@/components/layout/SidebarFooterWrapper");
    const html = renderToStaticMarkup(createElement(Wrapper, null, "LoL"));
    expect(html).toContain('data-ad-free="true"');
    expect(html).not.toContain("adsbygoogle"); expect(html).not.toContain("googlesyndication");
  });

  it("다른 경로의 프로덕션 광고 로더는 유지한다", async () => {
    mocks.pathname = "/stats";
    vi.stubEnv("NODE_ENV", "production");
    const { default: Wrapper } = await import("@/components/layout/SidebarFooterWrapper");
    const html = renderToStaticMarkup(createElement(Wrapper, null, "전적"));
    expect(html).toContain("adsbygoogle-main-js");
  });
});
