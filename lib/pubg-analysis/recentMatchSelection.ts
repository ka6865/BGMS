/**
 * Deterministic selection of the recent matches that are eligible for the
 * multi-match AI summary.  This module intentionally has no database, route,
 * or AI dependencies so that the selection identity can be tested in
 * isolation and reused by callers that have different match storage shapes.
 */

export const RECENT_MATCH_SELECTION_VERSION = "recent-valid-10-v1";

export type RecentMatchCandidate<T> = {
  /** A raw match identifier. The selected/rejected result exposes its canonical form. */
  id: string | null;
  createdAt: string | null;
  matchType: string | null;
  gameMode: string | null;
  mapName: string | null;
  /** Stable source order supplied by the caller. Lower values win ties. */
  sourceIndex: number;
  value: T;
};

export type SelectionRejectionReason =
  | "missing_id"
  | "match_type_excluded"
  | "mode_excluded"
  | "map_excluded"
  | "duplicate_id"
  | "over_limit";

export type RecentMatchRejection<T> = {
  id: string | null;
  reason: SelectionRejectionReason;
  candidate: RecentMatchCandidate<T>;
};

export type RecentMatchSelection<T> = {
  selected: Array<RecentMatchCandidate<T>>;
  rejected: Array<RecentMatchRejection<T>>;
  selectionVersion: string;
};

export type RecentMatchSelectionOptions = {
  limit?: number;
  selectionVersion?: string;
};

const EXCLUDED_MATCH_TYPE_TOKENS = ["airoyale", "seasonal"] as const;
const EXCLUDED_MODE_TOKENS = ["event", "arcade", "custom", "training"] as const;
const EXCLUDED_MAP_TOKENS = ["safehouse", "range", "training"] as const;

function compareLexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Return the canonical match ID used by the summary identity.
 * PUBG IDs can arrive as `shard:<id>` or just `<id>`; only the last colon
 * segment is meaningful. Non-string scalar IDs remain useful for old rows,
 * while nullish/blank values are rejected by the selector.
 */
export function normalizeMatchId(rawId: unknown): string | null {
  if (rawId === null || rawId === undefined) return null;
  if (typeof rawId === "object" || typeof rawId === "function" || typeof rawId === "symbol") return null;

  const raw = String(rawId).trim();
  if (!raw) return null;
  const lastSegment = raw.split(":").pop()?.trim() || "";
  return lastSegment || null;
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hasToken(value: unknown, tokens: readonly string[]): boolean {
  const text = normalizedText(value);
  if (!text) return false;

  // Map IDs such as `Erangel_Main` contain the letters "range" as part of
  // the real map name. Treat separators as token boundaries and retain a
  // compact-name fallback for `TrainingGround`-style IDs.
  const segments = text.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => {
    if (segments.includes(token)) return true;
    if (token === "range" && text.includes("erangel")) return false;
    return text.includes(token);
  });
}

function hasExactToken(value: unknown, tokens: readonly string[]): boolean {
  const text = normalizedText(value);
  return text.length > 0 && tokens.includes(text);
}

function dateTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sourceIndex(candidate: RecentMatchCandidate<unknown>): number {
  return Number.isFinite(candidate.sourceIndex) ? candidate.sourceIndex : Number.MAX_SAFE_INTEGER;
}

function compareCandidateDateThenSourceThenId(
  a: RecentMatchCandidate<unknown> & { canonicalId: string },
  b: RecentMatchCandidate<unknown> & { canonicalId: string },
): number {
  const aDate = dateTimestamp(a.createdAt);
  const bDate = dateTimestamp(b.createdAt);

  // Parseable timestamps always precede invalid/missing timestamps. Within
  // that partition, newest timestamps come first.
  if (aDate !== null || bDate !== null) {
    if (aDate === null) return 1;
    if (bDate === null) return -1;
    if (aDate !== bDate) return bDate - aDate;
  }

  const sourceDelta = sourceIndex(a) - sourceIndex(b);
  if (sourceDelta !== 0) return sourceDelta;
  return compareLexical(a.canonicalId, b.canonicalId);
}

function stableCandidateTieBreak(
  a: RecentMatchCandidate<unknown> & { canonicalId: string; originalId: string },
  b: RecentMatchCandidate<unknown> & { canonicalId: string; originalId: string },
): number {
  const base = compareCandidateDateThenSourceThenId(a, b);
  if (base !== 0) return base;

  // Canonical IDs are equal within this duplicate group. Preserve the trimmed
  // raw ID as a final lexical key so `shard:x` and `x` resolve identically no
  // matter which row arrived first. Never inspect `value`: score, placement,
  // and impact fields must not decide the duplicate winner.
  return compareLexical(a.originalId, b.originalId);
}

function normalizedCandidate<T>(candidate: RecentMatchCandidate<T>, canonicalId: string) {
  return {
    ...candidate,
    id: canonicalId,
    originalId: typeof candidate.id === "string" ? candidate.id.trim() : String(candidate.id ?? ""),
    canonicalId,
  } as RecentMatchCandidate<T> & { canonicalId: string; originalId: string };
}

/**
 * Select the latest valid unique matches without considering score, placement,
 * or any other performance value. Rejections retain candidate metadata and
 * are sorted by source index so diagnostics are stable across execution.
 */
export function selectRecentMatches<T>(
  candidates: readonly RecentMatchCandidate<T>[],
  options: RecentMatchSelectionOptions = {},
): RecentMatchSelection<T> {
  const requestedLimit = options.limit === undefined ? 10 : Number(options.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit >= 0
    ? Math.floor(requestedLimit)
    : 10;
  const selectionVersion = options.selectionVersion || RECENT_MATCH_SELECTION_VERSION;

  const rejected: Array<RecentMatchRejection<T> & { order: number }> = [];
  const eligibleById = new Map<string, Array<RecentMatchCandidate<T> & {
    canonicalId: string;
    originalId: string;
  }>>();

  candidates.forEach((inputCandidate, arrayIndex) => {
    const candidate = { ...inputCandidate };
    const canonicalId = normalizeMatchId(candidate.id);

    const reject = (reason: SelectionRejectionReason) => {
      rejected.push({
        id: canonicalId,
        reason,
        candidate: { ...candidate, id: canonicalId },
        order: arrayIndex,
      });
    };

    if (!canonicalId) {
      reject("missing_id");
      return;
    }
    if (hasExactToken(candidate.matchType, EXCLUDED_MATCH_TYPE_TOKENS)) {
      reject("match_type_excluded");
      return;
    }
    if (hasToken(candidate.gameMode, EXCLUDED_MODE_TOKENS)) {
      reject("mode_excluded");
      return;
    }
    if (hasToken(candidate.mapName, EXCLUDED_MAP_TOKENS)) {
      reject("map_excluded");
      return;
    }

    const normalized = normalizedCandidate(candidate, canonicalId);
    const group = eligibleById.get(canonicalId);
    if (group) group.push(normalized);
    else eligibleById.set(canonicalId, [normalized]);
  });

  const winners: Array<RecentMatchCandidate<T> & {
    canonicalId: string;
    originalId: string;
  }> = [];
  for (const group of eligibleById.values()) {
    group.sort(stableCandidateTieBreak);
    const [winner, ...duplicates] = group;
    if (!winner) continue;
    winners.push(winner);
    duplicates.forEach((duplicate) => {
      rejected.push({
        id: duplicate.canonicalId,
        reason: "duplicate_id",
        candidate: { ...duplicate, id: duplicate.canonicalId },
        order: sourceIndex(duplicate),
      });
    });
  }

  winners.sort(compareCandidateDateThenSourceThenId);
  const selectedInternal = winners.slice(0, limit);
  winners.slice(limit).forEach((candidate) => {
    rejected.push({
      id: candidate.canonicalId,
      reason: "over_limit",
      candidate: { ...candidate, id: candidate.canonicalId },
      order: sourceIndex(candidate),
    });
  });

  // Keep implementation-only tie-break properties out of the public shape.
  const stripInternal = <V>(candidate: V & { canonicalId?: string; originalId?: string }): V => {
    const result = { ...candidate } as V & { canonicalId?: string; originalId?: string };
    delete result.canonicalId;
    delete result.originalId;
    return result as V;
  };

  return {
    selected: selectedInternal.map(stripInternal),
    rejected: rejected
      .sort((a, b) => a.order - b.order || compareLexical(a.reason, b.reason))
      .map(({ order: _order, ...rejection }) => ({
        ...rejection,
        candidate: stripInternal(rejection.candidate),
      })),
    selectionVersion,
  };
}

/**
 * Stable, order-independent identity for a selected set. IDs are canonicalized
 * before deduplication and lexical sorting; the selection algorithm's version
 * is part of the identity so a future policy change cannot reuse old AI text.
 */
export function buildMatchSelectionKey(
  ids: readonly unknown[],
  selectionVersion: string = RECENT_MATCH_SELECTION_VERSION,
): string {
  const canonicalIds = Array.from(new Set(
    ids.map(normalizeMatchId).filter((id): id is string => Boolean(id)),
  )).sort(compareLexical);
  return JSON.stringify({ selectionVersion, ids: canonicalIds });
}
