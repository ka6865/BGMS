import { parse } from "node-html-parser";

export type ReplyEvidenceInput = { title: string; postHtml: string; question: string };
export type ReplyEvidence = {
  sources: { url: string; title: string; text: string; fetchedAt: string }[];
  reason: string | null;
};
const LISTING = "https://pubg.com/ko/news?category=patch_notes";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 12_000;

function officialUrl(value: string, listing = false): URL | null {
  try {
    const url = new URL(value, LISTING);
    if (url.protocol !== "https:" || !["pubg.com", "www.pubg.com"].includes(url.hostname)
      || url.username || url.password || url.port) return null;
    if (!/^\/ko\/news\/\d+\/?$/.test(url.pathname)
      && !(listing && /^\/ko\/news\/?$/.test(url.pathname))) return null;
    url.hash = "";
    url.search = /^\/ko\/news\/?$/.test(url.pathname) ? "?category=patch_notes" : "";
    return url;
  } catch { return null; }
}
function canonical(url: URL): string {
  const result = new URL(url);
  result.hostname = "pubg.com";
  return result.href;
}
function versionOf(title: string): string | null {
  return /패치|업데이트/i.test(title) ? title.match(/(?<![\d.])\d{1,3}\.\d{1,2}(?![\d.])/)?.[0] ?? null : null;
}
function matches(title: string, version: string | null): boolean {
  return /패치\s*노트/.test(title) && (!version || versionOf(title) === version);
}

/** Fetch only vetted official articles; never follow URLs supplied by comments. */
export async function loadReplyEvidence(
  input: ReplyEvidenceInput,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<ReplyEvidence> {
  const version = versionOf(input.title);
  const post = parse(input.postHtml.replace(/\\"/g, '"'));
  const linked = post.querySelectorAll("a[href]")
    .map(a => officialUrl(a.getAttribute("href") ?? ""))
    .find((url): url is URL => url !== null);
  if (!linked && !version) return { sources: [], reason: "no_official_source" };

  const controller = new AbortController();
  let requests = 0;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("source_timeout")); }, 10_000);
  });
  const fetchHtml = async (initial: string, listing = false): Promise<{ html: string; url: URL }> => {
    let url = officialUrl(initial, listing);
    while (url) {
      if (++requests > 3) throw new Error("source_request_limit");
      const response = await (options.fetchImpl ?? fetch)(url.href, {
        redirect: "manual", signal: controller.signal, headers: { Accept: "text/html" },
      });
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
  const work = async (): Promise<ReplyEvidence> => {
    let articleUrl = linked ? canonical(linked) : null;
    if (!articleUrl) {
      const listingHtml = (await fetchHtml(LISTING, true)).html;
      const listing = parse(listingHtml);
      for (const anchor of listing.querySelectorAll("a[href]")) {
        if (!matches(anchor.text, version)) continue;
        const url = officialUrl(anchor.getAttribute("href") ?? "");
        if (url) { articleUrl = canonical(url); break; }
      }
      // PUBG's Nuxt listing has cards without hrefs. Read only literal id/title
      // fields from its serialized data, never execute the page's scripts.
      if (!articleUrl) {
        for (const script of listing.querySelectorAll("script")) {
          if (!script.text.includes("window.__NUXT__=")) continue;
          const records = script.text.matchAll(/\bpostId:(\d+),[^{}]{0,800}?\btitle:("(?:\\.|[^"\\])*")/g);
          for (const entry of records) {
            let title: unknown;
            try { title = JSON.parse(entry[2]); } catch { continue; }
            if (typeof title === "string" && matches(title, version)) {
              articleUrl = `https://pubg.com/ko/news/${entry[1]}`;
              break;
            }
          }
          if (articleUrl) break;
        }
      }
    }
    if (!articleUrl) return { sources: [], reason: "no_official_source" };
    const fetched = await fetchHtml(articleUrl);
    const root = parse(fetched.html);
    const title = (root.querySelector(".detail-header__title") ?? root.querySelector("article h1"))?.text.trim();
    if (!title || !matches(title, version)) return { sources: [], reason: "source_version_mismatch" };
    const content = root.querySelector("#contentElement") ?? root.querySelector(".content-template__inner") ?? root.querySelector("article");
    if (!content) return { sources: [], reason: "source_empty" };
    content.querySelectorAll("script,style,noscript,iframe,svg,template,nav,footer").forEach(node => node.remove());
    const text = content.structuredText.replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return { sources: [], reason: "source_empty" };
    // Keep maintenance dates available even when a long patch exceeds the context budget.
    const scheduleIndex = text.indexOf("라이브 점검 일정");
    const selected = scheduleIndex < 0 || scheduleIndex < MAX_TEXT - 3000 ? text.slice(0, MAX_TEXT)
      : (text.slice(scheduleIndex, scheduleIndex + 3000) + "\n\n" + text.slice(0, scheduleIndex)).slice(0, MAX_TEXT);
    return { sources: [{ url: canonical(fetched.url), title, text: selected, fetchedAt: (options.now ?? new Date()).toISOString() }], reason: null };
  };
  try { return await Promise.race([work(), timeout]); }
  catch (error) {
    const reason = error instanceof Error && /^source_[a-z_]+$/.test(error.message) ? error.message : "source_unavailable";
    return { sources: [], reason };
  } finally { clearTimeout(timer!); controller.abort(); }
}
