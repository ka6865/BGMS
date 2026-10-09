import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOfficialIssueEvidence } from "@/lib/community-agent/sources/official";
import { evidence } from "@/lib/community-agent/sources";

const NOW = new Date("2026-10-08T03:00:00.000Z");
const issue = (title = "벤틀리 콜라보 가격") => evidence("dc", "1", "https://gall.dcinside.com/board/view/?id=battlegrounds&no=1",
  title, "커뮤니티에서 본 내용", NOW.toISOString(), NOW, "body", false);
const article = (title = "PUBG x 벤틀리 출시", text = "공식 콜라보 안내", date = "") =>
  `<section class="detail-header"><h3 class="detail-header__title">${title}</h3>${date ? `<time datetime="${date}"></time>` : ""}</section>
  <div id="contentElement"><p>${text}</p><script>개인정보</script><footer>관련 뉴스</footer></div>`;
const listing = (...titles: string[]) => titles.map((title, index) => `<a href="/ko/news/${12000 + index}">${title}</a>`).join("");

afterEach(() => vi.useRealTimers());

describe("official issue evidence", () => {
  it("matches the discovered issue and verifies a canonical official body with bounded excerpt", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(`<a href="https://www.pubg.com/ko/news/12000?utm=test">PUBG x 벤틀리 출시</a>`))
      .mockResolvedValueOnce(new Response(article(undefined, "공식 안내 ".repeat(200), "2026-10-07T00:00:00Z")));
    const items = await loadOfficialIssueEvidence([issue()], { fetchImpl, now: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual(["https://pubg.com/ko/news", "https://pubg.com/ko/news/12000"]);
    expect(items[0]).toMatchObject({ source: "official", official: true, access: "body", externalId: "12000",
      url: "https://pubg.com/ko/news/12000", publishedAt: "2026-10-07T00:00:00.000Z", fetchedAt: NOW.toISOString() });
    expect(items[0]?.excerpt?.length).toBeLessThanOrEqual(500);
    expect(items[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(items[0]?.excerpt).not.toContain("개인정보");
  });

  it("does not infer publication time from collection time or body dates", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(listing("벤틀리 콜라보")))
      .mockResolvedValueOnce(new Response(article(undefined, "2026-10-07 출시 안내")));
    const items = await loadOfficialIssueEvidence([issue()], { fetchImpl, now: NOW });
    expect(items[0]?.publishedAt).toBeNull();
  });

  it("uses literal Nuxt ids and bounds listing plus two articles to three requests", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(`<script>window.__NUXT__=({posts:[
      {postId:12000,title:"벤틀리 콜라보"},{postId:12001,title:"벤틀리 출시"},{postId:12002,title:"벤틀리 스킨"}]});throw Error('never execute');</script>`))
      .mockImplementation(async () => new Response(article()));
    const items = await loadOfficialIssueEvidence([issue()], { fetchImpl, now: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(items.map(item => item.externalId)).toEqual(["12000", "12001"]);
  });

  it("does not promote community text or unrelated original article headings", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(listing("벤틀리 콜라보")))
      .mockResolvedValueOnce(new Response(article("PUBG x 다른브랜드 출시")));
    expect(await loadOfficialIssueEvidence([issue()], { fetchImpl, now: NOW })).toEqual([]);
    expect(issue().official).toBe(false);
  });

  it("never follows external links or PUBG Mobile issues", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<a href="https://instagram.com/pubg">벤틀리 콜라보</a><a href="https://pubgmobile.com/ko/news/12000">벤틀리 출시</a>'));
    expect(await loadOfficialIssueEvidence([issue()], { fetchImpl, now: NOW })).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockClear();
    expect(await loadOfficialIssueEvidence([issue("PUBG Mobile 벤틀리 콜라보")], { fetchImpl, now: NOW })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps a verified article when another official source is blocked", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(listing("벤틀리 콜라보", "벤틀리 출시")))
      .mockResolvedValueOnce(new Response(article())).mockResolvedValueOnce(new Response("blocked", { status: 403 }));
    expect(await loadOfficialIssueEvidence([issue()], { fetchImpl, now: NOW })).toHaveLength(1);
  });

  it("returns existing collection control when the official listing fails or no issue exists", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network failure"));
    expect(await loadOfficialIssueEvidence([issue()], { fetchImpl, now: NOW })).toEqual([]);
    fetchImpl.mockClear();
    expect(await loadOfficialIssueEvidence([], { fetchImpl, now: NOW })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects off-host redirects without following them", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(listing("벤틀리 콜라보")))
      .mockResolvedValueOnce(new Response("", { status: 302, headers: { Location: "https://evil.example/ko/news/12000" } }));
    expect(await loadOfficialIssueEvidence([issue()], { fetchImpl, now: NOW })).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fetches the original www redirect host and canonicalizes only the resulting evidence URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(listing("벤틀리 콜라보")))
      .mockImplementation(async (url: string) => url.startsWith("https://www.pubg.com/")
        ? new Response(article()) : new Response("", { status: 301, headers: { Location: "https://www.pubg.com/ko/news/12000" } }));
    const items = await loadOfficialIssueEvidence([issue()], { fetchImpl, now: NOW });
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      "https://pubg.com/ko/news", "https://pubg.com/ko/news/12000", "https://www.pubg.com/ko/news/12000",
    ]);
    expect(items[0]?.url).toBe("https://pubg.com/ko/news/12000");
  });

  it("bounds the total timeout and does not fetch a later article after abort", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(listing("벤틀리 콜라보", "벤틀리 출시")))
      .mockImplementationOnce(() => new Promise<Response>(() => undefined));
    const pending = loadOfficialIssueEvidence([issue()], { fetchImpl, now: NOW });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
