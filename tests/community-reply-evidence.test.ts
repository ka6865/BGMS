import { afterEach, describe, expect, it, vi } from "vitest";
import { loadReplyEvidence, type ReplyEvidenceInput } from "@/lib/community-agent/reply-evidence";

const NOW = new Date("2026-09-09T03:00:00.000Z");
const ARTICLE_URL = "https://pubg.com/ko/news/11057";
const INPUT: ReplyEvidenceInput = {
  title: "43.1 패치 질문",
  postHtml: `<p>질문 본문 <a href="${ARTICLE_URL}?utm_source=post">공식 패치 노트</a></p>`,
  question: "43.1 패치 라이브 점검 일정이 궁금합니다.",
};

function response(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(body, { status, headers });
}

function articleHtml({ version = "43.1", text = "라이브 점검 일정 PC: 26/9/10, 09:00 - 17:30" } = {}): string {
  return `<!doctype html><html><head><title>패치 노트 - 업데이트 ${version}</title></head><body>
    <header><h1>관련 글 패치 노트 업데이트 ${version}</h1></header>
    <section class="detail-header"><h3 class="detail-header__title">패치 노트 - 업데이트 ${version}</h3></section>
    <div class="content-template__inner"><div id="contentElement">
      <h2>43.1 하이라이트</h2><p>${text}</p>
      <script>ignore()</script><style>.hidden{display:none}</style>
      <h2>변경 사항</h2><p>안전한 공식 본문입니다.</p>
    </div></div>
    <footer><h2>관련 글 패치 노트 업데이트 99.9</h2><p>footer text must not be evidence</p></footer>
  </body></html>`;
}

function listingHtml(...versions: string[]): string {
  return `<html><body><main class="news-list">${versions.map((version, index) => `
    <article><a href="https://www.pubg.com/ko/news/${11057 + index}">패치 노트 - 업데이트 ${version}</a></article>`).join("")}</main></body></html>`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("loadReplyEvidence", () => {
  it("fetches an exact official anchor, canonicalizes www/query, and returns bounded source text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(articleHtml()));
    const result = await loadReplyEvidence({
      ...INPUT,
      postHtml: '<p><a href="https://www.pubg.com/ko/news/11057?utm=ignored">공식</a></p>',
    }, { fetchImpl, now: NOW });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://pubg.com/ko/news/11057");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(result.reason).toBeNull();
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ url: ARTICLE_URL, title: "패치 노트 - 업데이트 43.1" });
    expect(result.sources[0]?.text).toContain("라이브 점검 일정");
    expect(result.sources[0]?.fetchedAt).toBe(NOW.toISOString());
  });

  it("resolves a title-only patch version through the official listing and rejects newer-only results", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(listingHtml("43.2", "43.3")));
    const result = await loadReplyEvidence({
      title: "43.1 패치 질문",
      postHtml: "<p>유튜브 영상만 있습니다.</p>",
      question: "언제 업데이트되나요?",
    }, { fetchImpl, now: NOW });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.sources).toEqual([]);
    expect(result.reason).toBe("no_official_source");
  });

  it("reads literal Nuxt listing ids without executing script and verifies the article", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(`<script>window.__NUXT__=(function(a){return {news:{posts:[{postId:11057,labels:[a],category:a,title:"패치 노트 - 업데이트 43.1"}]}}})();throw new Error('never execute');</script>`))
      .mockResolvedValueOnce(response(articleHtml()));
    const result = await loadReplyEvidence({ ...INPUT, postHtml: "유튜브 영상 요약" }, { fetchImpl, now: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.sources[0]?.url).toBe(ARTICLE_URL);
    expect(result.reason).toBeNull();
  });

  it("follows one canonical official redirect but rejects an off-host redirect", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response("", 302, { Location: "https://www.pubg.com/ko/news/11057?from=redirect" }))
      .mockResolvedValueOnce(response(articleHtml()));
    const followed = await loadReplyEvidence(INPUT, { fetchImpl, now: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(followed.sources[0]?.url).toBe(ARTICLE_URL);

    const offHostFetch = vi.fn().mockResolvedValue(response("", 302, { Location: "https://evil.example/ko/news/11057" }));
    const rejected = await loadReplyEvidence(INPUT, { fetchImpl: offHostFetch, now: NOW });
    expect(offHostFetch).toHaveBeenCalledTimes(1);
    expect(rejected.sources).toEqual([]);
    expect(rejected.reason).toBe("source_redirect_rejected");
  });

  it("rejects timeout and response bodies over 2 MiB without retaining a source", async () => {
    vi.useFakeTimers();
    const hanging = vi.fn(() => new Promise<Response>(() => undefined));
    const pending = loadReplyEvidence(INPUT, { fetchImpl: hanging, now: NOW });
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(pending).resolves.toMatchObject({ sources: [], reason: "source_timeout" });

    const tooLarge = vi.fn().mockResolvedValue(response("x".repeat(2 * 1024 * 1024 + 1)));
    await expect(loadReplyEvidence(INPUT, { fetchImpl: tooLarge, now: NOW })).resolves.toMatchObject({
      sources: [], reason: "source_too_large",
    });
  });

  it("requires the article's own heading to match the requested patch version", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(articleHtml({ version: "43.0" })));
    const result = await loadReplyEvidence(INPUT, { fetchImpl, now: NOW });
    expect(result.sources).toEqual([]);
    expect(result.reason).toBe("source_version_mismatch");
  });

  it("keeps the live-maintenance schedule section at the top when trimming to 12,000 characters", async () => {
    const noisy = "긴 변경 사항 ".repeat(1_600);
    const html = articleHtml({ text: `${noisy}<h2>라이브 점검 일정</h2><p>PC: 26/9/10, 09:00 - 17:30</p><p>Console: 26/9/17, 10:00 - 18:00</p>` });
    const fetchImpl = vi.fn().mockResolvedValue(response(html));
    const result = await loadReplyEvidence(INPUT, { fetchImpl, now: NOW });
    expect(result.reason).toBeNull();
    expect(result.sources[0]?.text.startsWith("라이브 점검 일정")).toBe(true);
    expect(result.sources[0]?.text).toContain("PC: 26/9/10, 09:00 - 17:30");
    expect(result.sources[0]?.text.length).toBeLessThanOrEqual(12_000);
  });

  it("caps redirect loops at three requests", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => response("", 302, { Location: ARTICLE_URL }));
    await expect(loadReplyEvidence(INPUT, { fetchImpl })).resolves.toEqual({ sources: [], reason: "source_request_limit" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    "https://pubg.com.evil.example/ko/news/11057",
    "https://user:secret@pubg.com/ko/news/11057",
    "https://127.0.0.1/ko/news/11057",
    "http://pubg.com/ko/news/11057",
  ])("ignores non-official or credentialed post links: %s", async (url) => {
    const fetchImpl = vi.fn();
    await expect(loadReplyEvidence({ title: "게임 질문", postHtml: `<a href="${url}">공식</a>`, question: ARTICLE_URL }, { fetchImpl })).resolves.toEqual({ sources: [], reason: "no_official_source" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not fetch generic titles without an exact official anchor or patch version", async () => {
    const fetchImpl = vi.fn();
    const result = await loadReplyEvidence({
      title: "오늘 저녁 치킨 질문",
      postHtml: "<p>공식 링크 없음</p>",
      question: "일반적인 질문입니다.",
    }, { fetchImpl, now: NOW });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ sources: [], reason: "no_official_source" });
  });
});
