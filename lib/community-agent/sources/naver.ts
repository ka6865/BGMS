import { parse } from "node-html-parser";
import { extractIssueSearchTerms } from "../discovery";
import { fetchSourceJson, SourceHttpError } from "../http";
import { cleanText, evidence, report, type SourceDeps } from "../sources";
import type { Evidence, SourceReport } from "../types";

const CAFE_URL = "https://cafe.naver.com/playbattlegrounds";
const SEARCH_TERMS = ["배틀그라운드 패치", "배틀그라운드 질문", "배틀그라운드 팁", "배틀그라운드 콜라보"];

function normalizedCafe(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "cafe.naver.com" || url.username || url.password || url.port) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch { return null; }
}

function article(value: unknown): { url: string; id: string } | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "cafe.naver.com" || url.username || url.password || url.port) return null;
    const match = url.pathname.match(/^\/playbattlegrounds\/(\d+)\/?$/);
    if (!match) return null;
    url.hash = "";
    return { url: url.toString(), id: match[1] };
  } catch { return null; }
}

function htmlText(value: unknown): string {
  if (typeof value !== "string") return "";
  return cleanText(parse(value).text);
}

/** Keep only snippets explicitly attributed by Naver to the one authorized cafe. */
export function parseNaverItems(value: unknown, now: Date): Evidence[] {
  const items = value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
    ? (value as { items: unknown[] }).items : [];
  const deduped = new Map<string, Evidence>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (normalizedCafe(row.cafeurl) !== CAFE_URL) continue;
    const link = article(row.link);
    const title = htmlText(row.title);
    if (!link || !title) continue;
    deduped.set(link.id, evidence("naver", link.id, link.url, title, htmlText(row.description) || null, null, now, "snippet", false));
  }
  return [...deduped.values()];
}

export async function collectNaver(deps: SourceDeps): Promise<SourceReport> {
  const clientId = deps.env.NAVER_SEARCH_CLIENT_ID;
  const clientSecret = deps.env.NAVER_SEARCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return report("naver", "needs_setup", [], "naver_search_credentials_missing", 0);
  const received: unknown[] = [];
  let errorReason: string | null = null;
  let credentialsInvalid = false;
  const queries = [...SEARCH_TERMS];
  for (const [index, query] of queries.entries()) {
    try {
      const url = new URL("/search/v1/cafearticle", "https://naverapihub.apigw.ntruss.com");
      url.searchParams.set("format", "json");
      url.searchParams.set("query", query);
      url.searchParams.set("display", "20");
      url.searchParams.set("sort", "date");
      received.push(await fetchSourceJson(url, {
        headers: { "X-NCP-APIGW-API-KEY-ID": clientId, "X-NCP-APIGW-API-KEY": clientSecret },
      }, deps));
      if (index === SEARCH_TERMS.length - 1) {
        queries.push(...extractIssueSearchTerms(received.flatMap((value) => parseNaverItems(value, deps.now).map((item) => item.title)))
          .map((term) => `배틀그라운드 ${term}`));
      }
    } catch (error) {
      credentialsInvalid = error instanceof SourceHttpError && error.status === 401;
      errorReason = error instanceof Error ? error.message : "source_request_failed";
      break;
    }
  }
  const fetchedCount = received.reduce<number>((count, value) => count + (
    value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items.length : 0
  ), 0);
  const parsed = received.map((value) => parseNaverItems(value, deps.now));
  const base = parsed.slice(0, SEARCH_TERMS.length);
  const prioritized = parsed.slice(SEARCH_TERMS.length).flat();
  for (let index = 0; index < Math.max(0, ...base.map((items) => items.length)); index++) {
    for (const items of base) if (items[index]) prioritized.push(items[index]);
  }
  const items = [...new Map(prioritized.map((item) => [item.externalId, item])).values()].slice(0, 60);
  if (credentialsInvalid) return report("naver", "needs_setup", [], "naver_search_credentials_invalid", fetchedCount);
  if (errorReason && items.length === 0) return report("naver", "failed", [], errorReason, fetchedCount);
  if (errorReason) return report("naver", "partial", items, errorReason, fetchedCount);
  return report("naver", items.length ? "ok" : "empty", items, items.length ? null : "naver_no_matching_cafe_items", fetchedCount);
}
