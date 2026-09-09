import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchSource } from "../lib/community-agent/http";
import { collectSource, type SourceDeps } from "../lib/community-agent/sources";
import { collectDc, parseDcList } from "../lib/community-agent/sources/dc";
import { collectNaver, parseNaverItems } from "../lib/community-agent/sources/naver";
import { collectYoutube } from "../lib/community-agent/sources/youtube";

const NOW = new Date("2026-09-08T01:00:00.000Z");
const dcHtml = readFileSync(resolve(process.cwd(), "tests/fixtures/community-agent/dc.html"), "utf8");
const privacyHtml = readFileSync(resolve(process.cwd(), "tests/fixtures/community-agent/privacy.html"), "utf8");

function deps(overrides: Partial<SourceDeps> = {}): SourceDeps {
  return {
    now: NOW,
    env: {},
    channel: null,
    signal: new AbortController().signal,
    fetchImpl: vi.fn(),
    ...overrides,
  } as SourceDeps;
}

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

describe("community source boundaries", () => {
  it("카페 이름이 비슷해도 실제 URL이 다르면 제외한다", () => {
    const items = parseNaverItems({ items: [
      { title: "매칭 질문", link: "https://cafe.naver.com/playbattlegrounds/123",
        cafeurl: "https://cafe.naver.com/playbattlegrounds", description: "질문 요약" },
      { title: "다른 카페", link: "https://cafe.naver.com/another/123",
        cafeurl: "https://cafe.naver.com/another", description: "요약" },
    ] }, NOW);
    expect(items).toHaveLength(1);
    expect(items[0].publishedAt).toBeNull();
    expect(items[0].access).toBe("snippet");
  });

  it("디시 목록은 지정 갤러리 글만 남기고 날짜를 한국 시간으로 해석한다", () => {
    expect(parseDcList(dcHtml, NOW)).toEqual([{
      externalId: "123", title: "패치 후 매칭 질문",
      url: "https://gall.dcinside.com/board/view/?id=battlegrounds&no=123",
      publishedAt: "2026-09-08T00:30:00.000Z",
    }, {
      externalId: "124", title: "미래 글",
      url: "https://gall.dcinside.com/board/view/?id=battlegrounds&no=124",
      publishedAt: null,
    }]);
  });

  it("허용하지 않은 URL·redirect 우회·timeout과 1MB 응답을 거부한다", async () => {
    const sourceDeps = deps({ fetchImpl: vi.fn() });
    await expect(fetchSource(new URL("https://evil.example/path"), {}, sourceDeps)).rejects.toThrow("source_url_rejected");
    await expect(fetchSource(new URL("https://naverapihub.apigw.ntruss.com.evil.example/path"), {}, sourceDeps)).rejects.toThrow("source_url_rejected");
    await expect(fetchSource(new URL("http://gall.dcinside.com/path"), {}, sourceDeps)).rejects.toThrow("source_url_rejected");
    const redirectFetch = vi.fn().mockResolvedValue(response("ok"));
    await fetchSource(new URL("https://naverapihub.apigw.ntruss.com/path"), {}, deps({ fetchImpl: redirectFetch }));
    expect(redirectFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });

    vi.useFakeTimers();
    const delayed = fetchSource(new URL("https://gall.dcinside.com/path"), {}, deps({
      fetchImpl: vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
      })),
    }));
    const timeout = expect(delayed).rejects.toThrow("source_timeout");
    await vi.advanceTimersByTimeAsync(6_000);
    await timeout;
    vi.useRealTimers();

    const huge = new Response("x".repeat(1_048_577));
    const report = await collectDc(deps({ fetchImpl: vi.fn().mockResolvedValue(huge) }));
    expect(report).toMatchObject({ source: "dc", state: "failed", reason: "source_too_large" });
  });

  it("디시 본문에서 메뉴와 연락처·IP·프로필을 제거한다", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(dcHtml))
      .mockResolvedValueOnce(response(dcHtml))
      .mockResolvedValueOnce(response(privacyHtml));
    const report = await collectDc(deps({ fetchImpl }));
    expect(report.state).toBe("partial");
    expect(report.items[0]?.excerpt).toContain("본문 내용");
    expect(report.items[0]?.excerpt).not.toMatch(/010-|02-|070-|@|192\.168|2001:db8|프로필|메뉴/);
  });

  it("정상 빈 디시 목록은 차단이나 selector 실패로 기록하지 않는다", async () => {
    const empty = '<table class="gall_list"><tbody><tr><td>게시물이 없습니다.</td></tr></tbody></table>';
    const report = await collectDc(deps({
      fetchImpl: vi.fn().mockImplementation(() => response(empty)),
    }));
    expect(report).toMatchObject({ source: "dc", state: "empty", reason: "dc_no_matching_posts", fetchedCount: 0 });
  });

  it("네이버 키와 YouTube 키가 없으면 설정 필요로 표시한다", async () => {
    await expect(collectNaver(deps())).resolves.toMatchObject({ source: "naver", state: "needs_setup" });
    await expect(collectYoutube(deps())).resolves.toMatchObject({ source: "youtube", state: "needs_setup" });
  });

  it("설정된 네이버 자격 증명의 401 인증 실패는 설정 필요로 표시한다", async () => {
    const report = await collectNaver(deps({
      env: { NAVER_SEARCH_CLIENT_ID: "invalid-id", NAVER_SEARCH_CLIENT_SECRET: "invalid-secret" },
      fetchImpl: vi.fn().mockResolvedValue(response({ errorCode: "024", errorMessage: "Authentication failed" }, 401)),
    }));

    expect(report).toMatchObject({
      source: "naver", state: "needs_setup", reason: "naver_search_credentials_invalid",
      fetchedCount: 0, retainedCount: 0,
    });
  });

  it("네이버 API HUB 요청은 고정 endpoint와 NCP 헤더를 사용하며 URL에 키를 넣지 않는다", async () => {
    const clientId = "client-id-fixture";
    const clientSecret = "client-secret-fixture";
    const fetchImpl = vi.fn().mockImplementation(() => response({ items: [] }));

    await collectNaver(deps({
      env: { NAVER_SEARCH_CLIENT_ID: clientId, NAVER_SEARCH_CLIENT_SECRET: clientSecret },
      fetchImpl,
    }));

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [input, init] of fetchImpl.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://naverapihub.apigw.ntruss.com");
      expect(url.pathname).toBe("/search/v1/cafearticle");
      expect(url.searchParams.get("format")).toBe("json");
      expect(url.searchParams.get("display")).toBe("20");
      expect(url.searchParams.get("sort")).toBe("date");
      expect(url.toString()).not.toContain(clientId);
      expect(url.toString()).not.toContain(clientSecret);

      const headers = new Headers(init?.headers);
      expect(headers.get("X-NCP-APIGW-API-KEY-ID")).toBe(clientId);
      expect(headers.get("X-NCP-APIGW-API-KEY")).toBe(clientSecret);
      expect(headers.get("X-Naver-Client-Id")).toBeNull();
      expect(headers.get("X-Naver-Client-Secret")).toBeNull();
    }
  });

  it("YouTube keyInvalid는 첫 요청과 댓글 요청 모두 설정 필요로 표시한다", async () => {
    const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/community-agent/youtube.json"), "utf8"));
    const invalidKey = response({ error: { errors: [{ reason: "keyInvalid" }] } }, 400);
    await expect(collectYoutube(deps({
      env: { YOUTUBE_DATA_API_KEY: "invalid-key" },
      fetchImpl: vi.fn().mockResolvedValue(invalidKey),
    }))).resolves.toMatchObject({
      source: "youtube", state: "needs_setup", reason: "youtube_data_api_key_invalid",
      fetchedCount: 0, retainedCount: 0,
    });

    const commentKeyFailure = vi.fn()
      .mockResolvedValueOnce(response(fixture.channel))
      .mockResolvedValueOnce(response(fixture.playlist))
      .mockResolvedValueOnce(response({ error: { errors: [{ reason: "keyInvalid" }] } }, 400));
    await expect(collectYoutube(deps({
      env: { YOUTUBE_DATA_API_KEY: "invalid-key" }, fetchImpl: commentKeyFailure,
    }))).resolves.toMatchObject({
      source: "youtube", state: "needs_setup", reason: "youtube_data_api_key_invalid",
      fetchedCount: 1, retainedCount: 0,
    });
  });

  it("유튜브의 댓글 비활성화는 영상 설명 수집과 구분한다", async () => {
    const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/community-agent/youtube.json"), "utf8"));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(fixture.channel))
      .mockResolvedValueOnce(response(fixture.playlist))
      .mockResolvedValueOnce(response(fixture.commentsDisabled, 403));
    const report = await collectYoutube(deps({ env: { YOUTUBE_DATA_API_KEY: "test-key" }, fetchImpl }));
    expect(report).toMatchObject({ source: "youtube", state: "partial", reason: "youtube_comments_disabled" });
    expect(report.items).toEqual([expect.objectContaining({ access: "description", official: true, externalId: "video-1" })]);
  });

  it.each(["quotaExceeded", "forbidden"])("유튜브의 %s 403은 제한 원인을 보존하고 인증 오류로 바꾸지 않는다", async (reason) => {
    const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/community-agent/youtube.json"), "utf8"));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(fixture.channel))
      .mockResolvedValueOnce(response(fixture.playlist))
      .mockResolvedValueOnce(response({ error: { errors: [{ reason }] } }, 403));
    const report = await collectYoutube(deps({ env: { YOUTUBE_DATA_API_KEY: "test-key" }, fetchImpl }));
    expect(report).toMatchObject({ state: "partial", reason: `youtube_${reason}`, fetchedCount: 1, retainedCount: 1 });
  });

  it("유튜브 댓글을 30개로 자르고 설명과 댓글을 모두 수집 건수에 넣는다", async () => {
    const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/community-agent/youtube.json"), "utf8"));
    const comments = { items: Array.from({ length: 31 }, (_, index) => ({
      snippet: { topLevelComment: { id: `comment-${index}`, snippet: {
        textDisplay: `comment ${index}`, publishedAt: "2026-09-07T13:00:00Z",
      } } },
    })) };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(fixture.channel))
      .mockResolvedValueOnce(response(fixture.playlist))
      .mockResolvedValueOnce(response(comments));
    const report = await collectYoutube(deps({ env: { YOUTUBE_DATA_API_KEY: "test-key" }, fetchImpl }));
    expect(report).toMatchObject({ state: "ok", fetchedCount: 32, retainedCount: 31 });
    expect(report.items.filter((item) => item.access === "comment")).toHaveLength(30);
  });

  it("네이버 응답은 대상 카페의 검증 가능한 요약만 저장한다", async () => {
    const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/community-agent/naver.json"), "utf8"));
    const report = await collectNaver(deps({
      env: { NAVER_SEARCH_CLIENT_ID: "id", NAVER_SEARCH_CLIENT_SECRET: "secret" },
      fetchImpl: vi.fn().mockImplementation(() => response(fixture)),
    }));
    expect(report).toMatchObject({ state: "ok", fetchedCount: 6, retainedCount: 1 });
    expect(report.items[0]).toMatchObject({ externalId: "100", excerpt: "실제 요약", publishedAt: null, access: "snippet" });
  });

  it("통합 수집은 설정 누락 출처를 즉시 분기한다", async () => {
    const report = await collectSource("naver", deps());
    expect(report).toMatchObject({ source: "naver", state: "needs_setup" });
  });

  it("중단 신호를 무시하는 fetch도 출처별 40초 deadline에서 종료한다", async () => {
    vi.useFakeTimers();
    try {
      const pending = collectSource("dc", deps({
        fetchImpl: vi.fn(() => new Promise<Response>(() => {})),
      }));
      await vi.advanceTimersByTimeAsync(39_999);
      let settled = false;
      void pending.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        source: "dc", state: "failed", reason: "source_deadline", fetchedCount: 0, retainedCount: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
