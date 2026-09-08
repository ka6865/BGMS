import { createHash, randomUUID } from "node:crypto";
import type { Evidence, CollectSource, SourceReport } from "./types";
import type { HttpDeps } from "./http";
import { collectDc } from "./sources/dc";
import { collectNaver } from "./sources/naver";
import { collectYoutube } from "./sources/youtube";

const COLLECT_DEADLINE_MS = 40_000;

export type SourceDeps = HttpDeps & {
  now: Date;
  env: Record<string, string | undefined>;
  channel: { id: string; uploads: string } | null;
};

export function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Remove contact identifiers before an excerpt reaches persistence or a model. */
export function cleanExcerpt(value: string): string {
  return cleanText(value)
    .replace(/\b(?:\+?82[- ]?)?0?1[016789][ -]?\d{3,4}[ -]?\d{4}\b/g, "[redacted]")
    .replace(/(?<!\d)(?:0(?:2|[3-6]\d|70|50\d)[ .-]?\d{3,4}[ .-]?\d{4}|1[5-8]\d{2}[ .-]?\d{4})(?!\d)/g, "[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted]")
    .replace(/(?<![0-9A-Fa-f:])(?:(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){0,6}:[0-9A-Fa-f:]{0,29})(?![0-9A-Fa-f:])/g, "[redacted]")
    .slice(0, 500);
}

export function evidence(
  source: Evidence["source"], externalId: string, url: string, title: string,
  excerpt: string | null, publishedAt: string | null, fetchedAt: Date,
  access: Evidence["access"], official: boolean,
): Evidence {
  const normalizedTitle = cleanExcerpt(title);
  const normalizedExcerpt = excerpt === null ? null : cleanExcerpt(excerpt);
  return {
    id: randomUUID(), source, externalId, url, title: normalizedTitle,
    excerpt: normalizedExcerpt || null, publishedAt, fetchedAt: fetchedAt.toISOString(), access, official,
    contentHash: createHash("sha256").update(`${normalizedTitle}\n${normalizedExcerpt ?? ""}`).digest("hex"),
  };
}

export function report(
  source: CollectSource, state: SourceReport["state"], items: Evidence[] = [],
  reason: string | null = null, fetchedCount = items.length, channel?: { id: string; uploads: string },
): SourceReport {
  return { source, state, items, reason, fetchedCount, retainedCount: items.length, ...(channel ? { channel } : {}) };
}

export function failure(source: CollectSource, error: unknown): SourceReport {
  const reason = error instanceof Error && /^source_(?:http_\d+|timeout|too_large|invalid_json|url_rejected|aborted|deadline)$/.test(error.message)
    ? error.message
    : "source_request_failed";
  return report(source, "failed", [], reason, 0);
}

function combinedSignal(parent: AbortSignal, controller: AbortController): () => void {
  const onAbort = () => controller.abort(parent.reason ?? new Error("source_aborted"));
  if (parent.aborted) onAbort();
  else parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

/** Dispatch a single collector with a hard per-source deadline. */
export async function collectSource(source: CollectSource, deps: SourceDeps): Promise<SourceReport> {
  const controller = new AbortController();
  const detach = combinedSignal(deps.signal, controller);
  const timer = setTimeout(() => controller.abort(new Error("source_deadline")), COLLECT_DEADLINE_MS);
  const scoped = { ...deps, signal: controller.signal };
  try {
    if (source === "dc") return await collectDc(scoped);
    if (source === "naver") return await collectNaver(scoped);
    return await collectYoutube(scoped);
  } catch (error) {
    return failure(source, controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : error);
  } finally {
    clearTimeout(timer);
    detach();
  }
}
