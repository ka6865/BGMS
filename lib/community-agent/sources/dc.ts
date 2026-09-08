import { parse } from "node-html-parser";
import { fetchSourceText } from "../http";
import { cleanExcerpt, cleanText, evidence, failure, report, type SourceDeps } from "../sources";
import type { Evidence, SourceReport } from "../types";

const DC_ORIGIN = "https://gall.dcinside.com";
const MAX_CANDIDATES = 60;
const MAX_BODIES = 10;

export type DcListItem = { externalId: string; url: string; title: string; publishedAt: string | null };

function koreanTimestamp(value: string, now: Date): string | null {
  const full = value.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  const clock = value.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  const parts = full ?? (() => {
    if (!clock) return null;
    const korean = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).split("-");
    return ["", korean[0], korean[1], korean[2], clock[1], clock[2], clock[3] ?? "00"] as RegExpMatchArray;
  })();
  if (!parts) return null;
  const [, year, month, day, hour, minute, second = "00"] = parts;
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() <= now.getTime() ? parsed.toISOString() : null;
}

/** Parse only the verified PUBG gallery rows; ads and cross-gallery rows lack this exact URL shape. */
export function parseDcList(html: string, now: Date): DcListItem[] {
  const root = parse(html);
  const items: DcListItem[] = [];
  for (const row of root.querySelectorAll("table.gall_list tr.ub-content")) {
    const externalId = cleanText(row.querySelector("td.gall_num")?.text ?? "");
    const anchor = row.querySelector("a[href*='/board/view/']");
    const href = anchor?.getAttribute("href") ?? "";
    let url: URL;
    try { url = new URL(href, DC_ORIGIN); } catch { continue; }
    if (!/^\d+$/.test(externalId) || url.origin !== DC_ORIGIN || url.pathname !== "/board/view/"
      || url.searchParams.get("id") !== "battlegrounds" || url.searchParams.get("no") !== externalId) continue;
    const title = cleanText(anchor?.text ?? "");
    if (!title) continue;
    const date = row.querySelector("td.gall_date");
    const publishedAt = koreanTimestamp(date?.getAttribute("title") || cleanText(date?.text ?? ""), now);
    items.push({ externalId, url: url.toString(), title, publishedAt });
  }
  return items;
}

function hasDcRows(html: string): boolean {
  return parse(html).querySelectorAll("table.gall_list tr.ub-content").length > 0;
}

function parseDcBody(html: string): string | null {
  const root = parse(html);
  const body = root.querySelector(".write_div");
  if (!body) return null;
  for (const node of body.querySelectorAll("script,style,img,iframe,form,button,nav,a,.write_menu,.writer_info,.gall_writer,.ad_wrap,.advertise")) node.remove();
  const text = cleanExcerpt(body.text);
  return text || null;
}

async function bounded<T, R>(values: T[], limit: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  let index = 0;
  async function worker(): Promise<void> {
    while (index < values.length) {
      const current = values[index++];
      result.push(await work(current));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return result;
}

export async function collectDc(deps: SourceDeps): Promise<SourceReport> {
  try {
    const rows: DcListItem[] = [];
    for (const page of [1, 2]) {
      const url = new URL("/board/lists/?id=battlegrounds", DC_ORIGIN);
      url.searchParams.set("page", String(page));
      const html = await fetchSourceText(url, {}, deps);
      if (!hasDcRows(html)) return report("dc", "failed", [], "dc_selector_missing_or_blocked", rows.length);
      const parsed = parseDcList(html, deps.now);
      rows.push(...parsed);
    }
    const candidates = [...new Map(rows.slice(0, MAX_CANDIDATES).map((item) => [item.externalId, item])).values()];
    if (candidates.length === 0) return report("dc", "empty", [], "dc_no_matching_posts", 0);
    const outcomes = await bounded(candidates.slice(0, MAX_BODIES), 2, async (item) => {
      try { return { item, body: parseDcBody(await fetchSourceText(new URL(item.url), {}, deps)), error: null as string | null }; }
      catch (error) { return { item, body: null, error: error instanceof Error ? error.message : "source_request_failed" }; }
    });
    const items: Evidence[] = outcomes.flatMap(({ item, body }) => body === null ? [] : [
      evidence("dc", item.externalId, item.url, item.title, body, item.publishedAt, deps.now, "body", false),
    ]);
    const firstError = outcomes.find((outcome) => outcome.error)?.error;
    if (items.length === 0 && firstError) return report("dc", "failed", [], firstError, candidates.length);
    if (items.length === 0) return report("dc", "blocked", [], "dc_body_unavailable", candidates.length);
    return report("dc", firstError || items.length < Math.min(candidates.length, MAX_BODIES) ? "partial" : "ok", items, firstError, candidates.length);
  } catch (error) {
    return failure("dc", error);
  }
}
