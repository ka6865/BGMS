import { parse } from "node-html-parser";
import { extractIssueSearchTerms } from "../discovery";
import { evidence } from "../sources";
import type { Evidence } from "../types";

const LISTING = "https://pubg.com/ko/news";
const MAX_BYTES = 2 * 1024 * 1024;
type OfficialOptions = { fetchImpl?: typeof fetch; now?: Date };
type OfficialPage = { html: string; url: URL };
type FetchOfficialPage = (initial: string, listing?: boolean) => Promise<OfficialPage>;

export function officialUrl(value: string, listing = false): URL | null {
  try {
    const url = new URL(value, LISTING);
    if (url.protocol !== "https:" || !["pubg.com", "www.pubg.com"].includes(url.hostname)
      || url.username || url.password || url.port) return null;
    if (!/^\/ko\/news\/\d+\/?$/.test(url.pathname)
      && !(listing && /^\/ko\/news\/?$/.test(url.pathname))) return null;
    url.hash = "";
    url.search = listing && /^\/ko\/news\/?$/.test(url.pathname) && url.searchParams.get("category") === "patch_notes"
      ? "?category=patch_notes" : "";
    return url;
  } catch { return null; }
}

export function canonicalOfficialUrl(url: URL): string {
  const result = new URL(url);
  result.hostname = "pubg.com";
  return result.href;
}

/** 공식 목록과 본문은 리다이렉트를 포함한 전체 3요청·10초 한도를 공유한다. */
export async function withOfficialPages<T>(work: (fetchPage: FetchOfficialPage) => Promise<T>, options: OfficialOptions = {}): Promise<T> {
  const controller = new AbortController();
  let requests = 0;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("source_timeout")); }, 10_000);
  });
  const fetchPage: FetchOfficialPage = async (initial, listing = false) => {
    let url = officialUrl(initial, listing);
    while (url) {
      if (controller.signal.aborted) throw new Error("source_timeout");
      if (++requests > 3) throw new Error("source_request_limit");
      const response = await (options.fetchImpl ?? fetch)(url.href, {
        redirect: "manual", signal: controller.signal, headers: { Accept: "text/html" },
      });
      if (controller.signal.aborted) { await response.body?.cancel(); throw new Error("source_timeout"); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        url = location ? officialUrl(new URL(location, url).href, listing) : null;
        if (!url) throw new Error("source_redirect_rejected");
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error("source_unavailable"); }
      if (Number(response.headers.get("content-length")) > MAX_BYTES) {
        await response.body?.cancel(); throw new Error("source_too_large");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("source_empty");
      const decoder = new TextDecoder();
      let html = "";
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) { await reader.cancel(); throw new Error("source_too_large"); }
          html += decoder.decode(value, { stream: true });
        }
        html += decoder.decode();
      } finally { reader.releaseLock(); }
      return { html, url };
    }
    throw new Error("no_official_source");
  };
  try { return await Promise.race([work(fetchPage), timeout]); }
  finally { clearTimeout(timer!); controller.abort(); }
}

export function parseOfficialListing(html: string): Array<{ url: string; title: string }> {
  const root = parse(html);
  const items: Array<{ url: string; title: string }> = [];
  for (const anchor of root.querySelectorAll("a[href]")) {
    const url = officialUrl(anchor.getAttribute("href") ?? "");
    const title = anchor.text.replace(/\s+/g, " ").trim();
    if (url && title) items.push({ url: canonicalOfficialUrl(url), title });
  }
  // 실제 Nuxt 목록의 id/title 리터럴만 읽고 스크립트는 실행하지 않는다.
  for (const script of root.querySelectorAll("script")) {
    if (!script.text.includes("window.__NUXT__=")) continue;
    for (const entry of script.text.matchAll(/\bpostId:(\d+),[^{}]{0,800}?\btitle:("(?:\\.|[^"\\])*")/g)) {
      let title: unknown;
      try { title = JSON.parse(entry[2]); } catch { continue; }
      if (typeof title === "string" && title.trim()) items.push({ url: `${LISTING}/${entry[1]}`, title: title.trim() });
    }
  }
  return [...new Map(items.map(item => [item.url, item])).values()];
}

export function parseOfficialArticle(html: string): { title: string; text: string; publishedAt: string | null } {
  const root = parse(html);
  const title = (root.querySelector(".detail-header__title") ?? root.querySelector("article h1"))?.text.trim() ?? "";
  const content = root.querySelector("#contentElement") ?? root.querySelector(".content-template__inner") ?? root.querySelector("article");
  if (!content) return { title, text: "", publishedAt: null };
  const date = root.querySelector('meta[property="article:published_time"]')?.getAttribute("content")
    ?? root.querySelector(".detail-header time[datetime], article header time[datetime]")?.getAttribute("datetime");
  const publishedAt = date && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(date)
    && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null;
  content.querySelectorAll("script,style,noscript,iframe,svg,template,nav,footer").forEach(node => node.remove());
  const text = content.structuredText.replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text, publishedAt };
}

/** 커뮤니티 제목으로 찾은 공식 목록 후보도 실제 원문의 자체 제목과 본문을 재검증한다. */
export async function loadOfficialIssueEvidence(items: Evidence[], options: OfficialOptions = {}): Promise<Evidence[]> {
  const mobile = /(?:배그|배틀그라운드)\s*모바일|pubg\s*mobile/i;
  const terms = extractIssueSearchTerms(items.filter(item => !mobile.test(item.title)).map(item => item.title));
  if (terms.length === 0) return [];
  const matches = (title: string) => !mobile.test(title)
    && terms.some(term => title.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
  const result: Evidence[] = [];
  try {
    return await withOfficialPages(async fetchPage => {
      const listing = parseOfficialListing((await fetchPage(LISTING, true)).html);
      for (const item of listing.filter(item => matches(item.title)).slice(0, 2)) {
        try {
          const page = await fetchPage(item.url);
          const article = parseOfficialArticle(page.html);
          if (!article.text || !matches(article.title)) continue;
          const externalId = page.url.pathname.match(/\d+/)?.[0];
          if (externalId && !result.some(item => item.externalId === externalId)) result.push(evidence("official", externalId, canonicalOfficialUrl(page.url), article.title,
            article.text, article.publishedAt, options.now ?? new Date(), "body", true));
        } catch { /* 개별 공식 원문 실패가 다른 후보나 커뮤니티 수집을 중단하지 않는다. */ }
      }
      return result;
    }, options);
  } catch { return result; }
}
