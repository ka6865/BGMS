/**
 * Deterministic selection of the recent matches that are eligible for the
 * multi-match AI summary.  This module intentionally has no database, route,
 * or AI dependencies so that the selection identity can be tested in
 * isolation and reused by callers that have different match storage shapes.
 */

export const RECENT_MATCH_SELECTION_VERSION = "recent-valid-10-v1";
export const BEST_MATCH_SELECTION_LIMIT = 5;

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

export type BestMatchSelectionOptions = {
  /** Optional lower ceiling for callers that need fewer than five matches. */
  limit?: number;
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

/**
 * Normalize a benchmark score for both sorting and cache identity. The
 * benchmark payload is persisted JSON, but older rows can contain strings,
 * nullish values, or non-finite numeric values. Treat every value whose
 * numeric representation is not finite as zero, without allowing an unusual
 * value (for example a Symbol) to throw during selection.
 */
export function normalizeBenchmarkScore(value: unknown): number {
  let score: number;
  try {
    score = Number(value);
  } catch {
    return 0;
  }
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, score));
}

function benchmarkScoreForCandidate(candidate: RecentMatchCandidate<unknown>): number {
  if (!candidate.value || typeof candidate.value !== "object") return 0;
  const benchmark = (candidate.value as { benchmark?: unknown }).benchmark;
  if (!benchmark || typeof benchmark !== "object") return 0;
  return normalizeBenchmarkScore((benchmark as { score?: unknown }).score);
}

function canonicalCandidateId(candidate: RecentMatchCandidate<unknown>): string {
  return normalizeMatchId(candidate.id) ?? String(candidate.id ?? "").trim();
}

function compareBestCandidates(
  a: RecentMatchCandidate<unknown>,
  b: RecentMatchCandidate<unknown>,
): number {
  const aScore = benchmarkScoreForCandidate(a);
  const bScore = benchmarkScoreForCandidate(b);
  if (aScore !== bScore) return bScore > aScore ? 1 : -1;

  return compareCandidateDateThenSourceThenId(
    { ...a, canonicalId: canonicalCandidateId(a) },
    { ...b, canonicalId: canonicalCandidateId(b) },
  );
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

/**
 * Build a deterministic, JSON-like representation for a duplicate payload.
 * Match rows are normally plain JSON, but callers can hand this selector
 * cyclic objects, BigInts, symbols, or throwing accessors. Never call the
 * payload's `toJSON`/`toString` while walking objects and keep each operation
 * guarded so a malformed payload cannot abort selection.
 */
function stablePayloadKey(value: unknown, ancestors: WeakSet<object> = new WeakSet<object>()): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string":
      try { return `string:${JSON.stringify(value)}`; } catch { return "string:[unserializable]"; }
    case "boolean":
      return `boolean:${value ? "true" : "false"}`;
    case "number":
      return Number.isFinite(value) ? `number:${String(value)}` : `number:${String(value)}`;
    case "bigint":
      try { return `bigint:${value.toString()}`; } catch { return "bigint:[unserializable]"; }
    case "symbol":
      try { return `symbol:${String(value)}`; } catch { return "symbol:[unserializable]"; }
    case "function":
      try { return `function:${String(value)}`; } catch { return "function:[unserializable]"; }
    default:
      break;
  }

  const objectValue = value as object;
  try {
    if (ancestors.has(objectValue)) return "[Circular]";
    ancestors.add(objectValue);
  } catch {
    return "object:[unserializable]";
  }

  try {
    if (objectValue instanceof Date) {
      const timestamp = objectValue.getTime();
      return Number.isFinite(timestamp) ? `date:${new Date(timestamp).toISOString()}` : "date:Invalid";
    }

    if (objectValue instanceof RegExp) {
      return `regexp:${objectValue.source}/${objectValue.flags}`;
    }

    if (Array.isArray(objectValue)) {
      return `array:[${objectValue.map((item) => stablePayloadKey(item, ancestors)).join(",")}]`;
    }

    if (objectValue instanceof Map) {
      const entries = Array.from(objectValue.entries())
        .map(([key, entryValue]) => [stablePayloadKey(key, ancestors), stablePayloadKey(entryValue, ancestors)] as const)
        .sort(([aKey, aValue], [bKey, bValue]) => compareLexical(`${aKey}:${aValue}`, `${bKey}:${bValue}`));
      return `map:{${entries.map(([key, entryValue]) => `${key}:${entryValue}`).join(",")}}`;
    }

    if (objectValue instanceof Set) {
      const entries = Array.from(objectValue.values())
        .map((entryValue) => stablePayloadKey(entryValue, ancestors))
        .sort(compareLexical);
      return `set:{${entries.join(",")}}`;
    }

    let keys: string[];
    try {
      keys = Object.keys(objectValue).sort(compareLexical);
    } catch {
      return "object:[unserializable]";
    }

    const entries: string[] = [];
    for (const key of keys) {
      let child: unknown;
      try {
        child = (objectValue as Record<string, unknown>)[key];
      } catch {
        child = "[getter threw]";
      }
      let serializedKey: string;
      try {
        serializedKey = JSON.stringify(key);
      } catch {
        serializedKey = `"${key}"`;
      }
      entries.push(`${serializedKey}:${stablePayloadKey(child, ancestors)}`);
    }
    return `object:{${entries.join(",")}}`;
  } catch {
    return "object:[unserializable]";
  } finally {
    try { ancestors.delete(objectValue); } catch { /* ignore malformed proxies */ }
  }
}

function stableCandidateTieBreak(
  a: RecentMatchCandidate<unknown> & { canonicalId: string; originalId: string },
  b: RecentMatchCandidate<unknown> & { canonicalId: string; originalId: string },
): number {
  const base = compareCandidateDateThenSourceThenId(a, b);
  if (base !== 0) return base;

  // Canonical IDs are equal within this duplicate group. Preserve the trimmed
  // raw ID as a final lexical key so `shard:x` and `x` resolve identically no
  // matter which row arrived first. If those metadata keys are also equal,
  // compare a canonical payload representation. This is only an exact-tie
  // stabilizer: benchmark score/placement are never parsed or preferred, so
  // duplicate winner policy remains metadata-first while differing payloads
  // no longer depend on the arrival order. The serializer is cycle/odd-value
  // safe and cannot throw on malformed data.
  const rawIdDelta = compareLexical(a.originalId, b.originalId);
  if (rawIdDelta !== 0) return rawIdDelta;
  return compareLexical(stablePayloadKey(a.value), stablePayloadKey(b.value));
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
      .map(({ order: _order, ...rejection }) => {
        void _order;
        return {
          ...rejection,
          candidate: stripInternal(rejection.candidate),
        };
      }),
    selectionVersion,
  };
}

/**
 * Select the best five matches from an already-selected latest-match pool.
 * This helper deliberately does not perform validity filtering or de-duping:
 * callers must pass the output of `selectRecentMatches`, so an older or
 * otherwise invalid high-scoring match cannot enter the AI population.
 *
 * Scores are finite `Number(value.benchmark.score)` values in descending
 * order. Equal (including normalized zero) scores use the same deterministic
 * metadata ordering as the latest-match selector: parseable dates newest
 * first, then source index ascending, then canonical ID lexical ascending.
 */
export function selectBestMatches<T>(
  candidates: readonly RecentMatchCandidate<T>[],
  options: BestMatchSelectionOptions = {},
): Array<RecentMatchCandidate<T>> {
  const requestedLimit = options.limit === undefined ? BEST_MATCH_SELECTION_LIMIT : Number(options.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit >= 0
    ? Math.min(BEST_MATCH_SELECTION_LIMIT, Math.floor(requestedLimit))
    : BEST_MATCH_SELECTION_LIMIT;

  return [...candidates]
    .sort((a, b) => compareBestCandidates(a, b))
    .slice(0, limit);
}

/**
 * Build an ordered identity for the effective best-match population. Unlike
 * `buildMatchSelectionKey`, this key intentionally preserves order and stores
 * each candidate's normalized benchmark score so changing a score invalidates
 * an AI summary even when the latest-ten ID set is unchanged.
 */
export function buildBestMatchSelectionKey<T>(
  candidates: readonly RecentMatchCandidate<T>[],
): string {
  return JSON.stringify({
    matches: candidates.map((candidate) => ({
      id: canonicalCandidateId(candidate),
      score: benchmarkScoreForCandidate(candidate),
    })),
  });
}

/**
 * Build the ordered identity for the complete latest-match population. The
 * latest-ten set drives basic metrics, maps, and trends, so every canonical ID
 * and normalized benchmark score must participate in the cache identity even
 * when a score belongs to a match outside the best-five AI population.
 */
export function buildMatchScoreSelectionKey<T>(
  candidates: readonly RecentMatchCandidate<T>[],
): string {
  return JSON.stringify({
    matches: candidates.map((candidate) => ({
      id: canonicalCandidateId(candidate),
      score: benchmarkScoreForCandidate(candidate),
    })),
  });
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
