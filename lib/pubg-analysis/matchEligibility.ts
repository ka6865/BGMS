/**
 * Match metadata eligibility shared by the stats classification and the
 * benchmark/AI summary boundaries.  AI and bot matches remain available for
 * ordinary detail/replay views; callers opt into this predicate only where
 * human battle-royale data is required.
 */

type MatchMetadata = {
  matchType?: unknown;
  match_type?: unknown;
  gameMode?: unknown;
  game_mode?: unknown;
  mode?: unknown;
  matchInfo?: {
    matchType?: unknown;
    gameMode?: unknown;
    mode?: unknown;
  } | null;
};

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isAiOrBotLabel(value: unknown): boolean {
  const text = normalized(value);
  if (!text) return false;

  // Keep token boundaries so labels such as `notairoyale` are not rejected by
  // an accidental substring, while accepting PUBG's separator/case variants
  // (`squad-ai`, `ai_match`, `BotMatch`, and similar forms).
  const segments = text.split(/[^a-z0-9]+/).filter(Boolean);
  if (segments.some((segment) => ["ai", "aimatch", "airoyale", "bot", "botmatch"].includes(segment))) {
    return true;
  }

  const compact = text.replace(/[\s_-]+/g, "");
  return compact === "ai" || compact === "aimatch" || compact === "airoyale" || compact === "bot" || compact === "botmatch";
}

function metadataValues(input: MatchMetadata | null | undefined): unknown[] {
  if (!input || typeof input !== "object") return [];
  return [
    input.matchType,
    input.match_type,
    input.matchInfo?.matchType,
    input.gameMode,
    input.game_mode,
    input.mode,
    input.matchInfo?.gameMode,
    input.matchInfo?.mode,
  ];
}

/** Return true when metadata identifies an AI, bot, or AI-royale match. */
export function isAiOrBotMatch(input: MatchMetadata | null | undefined): boolean {
  return metadataValues(input).some(isAiOrBotLabel);
}

/**
 * Global benchmark rows are human standard/competitive battle-royale samples.
 * This intentionally does not gate raw ingest, detail, or replay persistence.
 */
export function isStandardBenchmarkMatch(input: MatchMetadata | null | undefined): boolean {
  const matchType = normalized(input?.matchType ?? input?.match_type ?? input?.matchInfo?.matchType);
  const gameMode = normalized(input?.gameMode ?? input?.game_mode ?? input?.mode ?? input?.matchInfo?.gameMode ?? input?.matchInfo?.mode);
  return (matchType === "official" || matchType === "competitive")
    && !isAiOrBotMatch(input)
    && gameMode !== "tdm"
    && gameMode !== "trainingroom";
}
