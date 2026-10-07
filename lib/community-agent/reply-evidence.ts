import { parse } from "node-html-parser";
import { canonicalOfficialUrl, officialUrl, parseOfficialArticle, parseOfficialListing, withOfficialPages } from "./sources/official";

export type ReplyEvidenceInput = { title: string; postHtml: string; question: string };
export type ReplyEvidence = {
  sources: { url: string; title: string; text: string; fetchedAt: string }[];
  reason: string | null;
};
const LISTING = "https://pubg.com/ko/news?category=patch_notes";
const MAX_TEXT = 12_000;

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

  try {
    return await withOfficialPages(async fetchHtml => {
      let articleUrl = linked ? canonicalOfficialUrl(linked) : null;
      if (!articleUrl) {
        const listing = parseOfficialListing((await fetchHtml(LISTING, true)).html);
        articleUrl = listing.find(item => matches(item.title, version))?.url ?? null;
      }
      if (!articleUrl) return { sources: [], reason: "no_official_source" };
      const fetched = await fetchHtml(articleUrl);
      const article = parseOfficialArticle(fetched.html);
      const { title, text } = article;
      if (!matches(title, version)) return { sources: [], reason: "source_version_mismatch" };
      if (!text) return { sources: [], reason: "source_empty" };
      // Keep maintenance dates available even when a long patch exceeds the context budget.
      const scheduleIndex = text.indexOf("라이브 점검 일정");
      const selected = scheduleIndex < 0 || scheduleIndex < MAX_TEXT - 3000 ? text.slice(0, MAX_TEXT)
        : (text.slice(scheduleIndex, scheduleIndex + 3000) + "\n\n" + text.slice(0, scheduleIndex)).slice(0, MAX_TEXT);
      return { sources: [{ url: canonicalOfficialUrl(fetched.url), title, text: selected, fetchedAt: (options.now ?? new Date()).toISOString() }], reason: null };
    }, options);
  } catch (error) {
    const reason = error instanceof Error && /^source_[a-z_]+$/.test(error.message) ? error.message : "source_unavailable";
    return { sources: [], reason };
  }
}
