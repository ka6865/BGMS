import type { Topic } from "./types";

const KOREAN_TIME_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** Return the Korean calendar day (UTC+09:00) for a valid Date. */
export function koreanDay(date: Date): string {
  const timestamp = date instanceof Date ? date.getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new RangeError("Invalid date");
  }

  const shifted = new Date(timestamp + KOREAN_TIME_OFFSET_MS);
  if (!Number.isFinite(shifted.getTime())) {
    throw new RangeError("Invalid date");
  }

  return shifted.toISOString().slice(0, 10);
}

/** Classify an evidence timestamp relative to now, returning unknown for unusable/future dates. */
export function classifyWindow(
  publishedAt: string | null,
  now: Date,
): "24h" | "7d" | "older" | "unknown" {
  const age =
    publishedAt === null
      ? Number.NaN
      : now.getTime() - Date.parse(publishedAt);

  if (!Number.isFinite(age) || age < 0) {
    return "unknown";
  }
  if (age <= DAY_MS) {
    return "24h";
  }
  if (age <= 7 * DAY_MS) {
    return "7d";
  }
  return "older";
}

/** Map a selected topic kind to the board category allowed by the community policy. */
export function categoryFor(kind: Topic["kind"]): "배그 소식" | "자유" {
  return kind === "news" ? "배그 소식" : "자유";
}
