/**
 * Shared population boundary for PUBG match metadata.
 *
 * This module is deliberately pure. It never mutates or fills in metadata;
 * ordinary history/detail callers can keep every row while AI/benchmark
 * callers opt into the stricter human, standard battle-royale contract.
 */

export const KNOWN_BATTLE_ROYALE_MODES = [
  "solo", "solo-fpp", "duo", "duo-fpp", "squad", "squad-fpp",
] as const;

export type KnownBattleRoyaleMode = typeof KNOWN_BATTLE_ROYALE_MODES[number];
export type MatchEligibilityPurpose = "ai-summary" | "benchmark" | "ai" | "benchmark-persistence";
export type MatchEligibilityReason =
  | "eligible"
  | "missing_mode"
  | "unknown_mode"
  | "non_battle_royale_mode"
  | "conflicting_mode"
  | "tdm_mode"
  | "tdm_map"
  | "ai_or_bot"
  | "custom_match"
  | "event_mode"
  | "custom_mode_family"
  | "match_type_not_canonical"
  | "seasonal_match";

export type MatchEligibilityResult = {
  eligible: boolean;
  reason: MatchEligibilityReason;
  mode: KnownBattleRoyaleMode | null;
  matchType: "official" | "competitive" | null;
  /** Alias kept for diagnostics callers that use the explicit terminology. */
  rejectionReason?: MatchEligibilityReason;
};

export type MatchMetadata = {
  matchType?: unknown;
  match_type?: unknown;
  gameMode?: unknown;
  game_mode?: unknown;
  mode?: unknown;
  mapName?: unknown;
  map_name?: unknown;
  map?: unknown;
  attributes?: unknown;
  telemetry?: unknown;
  fullResult?: unknown;
  matchInfo?: unknown;
  [key: string]: unknown;
};

type PlainRecord = Record<string, unknown>;

const BR_MODE_SET = new Set<string>(KNOWN_BATTLE_ROYALE_MODES);
const TDM_MAPS = new Set(["pillarcompound_main", "italy_tdm_main"]);
const CUSTOM_MODE_FAMILIES = ["normal", "war", "zombie", "conquest", "esports"] as const;
const CANONICAL_MATCH_TYPES = new Set(["official", "competitive"]);

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function compact(value: string): string {
  return value.replace(/[^a-z0-9]+/g, "");
}

function getNested(input: MatchMetadata | null | undefined): PlainRecord[] {
  if (!isRecord(input)) return [];
  const result: PlainRecord[] = [];
  const queue: Array<{ value: PlainRecord; depth: number }> = [{ value: input, depth: 0 }];
  const seen = new Set<PlainRecord>();
  const nestedKeys = [
    "matchInfo",
    "match_info",
    "matchInfoEvidence",
    "match_info_evidence",
    "metadataEvidence",
    "metadata_evidence",
    "attributes",
    "matchAttributes",
    "match_attributes",
    "telemetryFlags",
    "telemetry_flags",
    "LogMatchStart",
    "logMatchStart",
    "data",
    "fullResult",
  ];
  const enqueueNested = (nested: unknown, depth: number) => {
    if (isRecord(nested)) {
      queue.push({ value: nested, depth });
    } else if (Array.isArray(nested)) {
      nested.forEach((item) => {
        if (isRecord(item)) queue.push({ value: item, depth });
      });
    }
  };
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.value)) continue;
    seen.add(current.value);
    result.push(current.value);
    if (current.depth >= 3) continue;
    for (const key of nestedKeys) {
      const nested = current.value[key];
      enqueueNested(nested, current.depth + 1);
    }
  }
  return result;
}

function allValues(input: MatchMetadata | null | undefined, keys: readonly string[]): unknown[] {
  return getNested(input).flatMap((record) => keys.map((key) => record[key]));
}

function hasTruthyFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string") return ["true", "1", "yes", "y"].includes(normalize(value));
  return false;
}

function hasFalseFlag(value: unknown): boolean {
  if (value === false || value === 0) return true;
  if (typeof value === "string") return ["false", "0", "no", "n"].includes(normalize(value));
  return false;
}

function telemetryEvents(input: MatchMetadata | null | undefined): PlainRecord[] {
  const values = allValues(input, [
    "telemetry",
    "events",
    "telemetryEvents",
    "telemetry_events",
    "telemetryFlags",
    "telemetry_flags",
    "matchAttributes",
    "match_attributes",
  ]);
  const result: PlainRecord[] = [];
  const appendRecord = (event: PlainRecord) => {
    result.push(event);
    const matchStart = event.LogMatchStart;
    if (isRecord(matchStart)) result.push(matchStart);
  };
  for (const value of values) {
    if (Array.isArray(value)) {
      value.forEach((event) => { if (isRecord(event)) appendRecord(event); });
    } else if (isRecord(value)) {
      appendRecord(value);
    }
  }
  return result;
}

function hasExplicitFlag(input: MatchMetadata | null | undefined, keys: readonly string[]): boolean {
  if (allValues(input, keys).some(hasTruthyFlag)) return true;
  return telemetryEvents(input).some((event) => keys.some((key) => hasTruthyFlag(event[key])));
}

function hasExplicitFalseFlag(input: MatchMetadata | null | undefined, keys: readonly string[]): boolean {
  return allValues(input, keys).some(hasFalseFlag)
    || telemetryEvents(input).some((event) => keys.some((key) => hasFalseFlag(event[key])));
}

function hasToken(value: unknown, tokens: readonly string[]): boolean {
  const text = normalize(value);
  if (!text) return false;
  const segments = text.split(/[^a-z0-9]+/).filter(Boolean);
  // Match complete tokens only.  Substring checks (for example, `customary`
  // or `eventual`) turn otherwise unknown metadata into false custom/event
  // evidence.  Compact values are accepted only when the complete value is a
  // known token (e.g. `TDM` or `AIROYALE`).
  const compactText = compact(text);
  const compactAliases: Record<string, readonly string[]> = {
    event: ["eventmode", "eventmatch"],
    arcade: ["arcademode", "arcadematch"],
    training: ["trainingmode", "trainingroom"],
    custom: ["custommode", "custommatch"],
    tdm: ["teamdeathmatch"],
  };
  return tokens.some((token) => (
    segments.includes(token)
    || compactText === token
    || compactAliases[token]?.includes(compactText) === true
  ));
}

function aiOrBotLabel(value: unknown): boolean {
  const text = normalize(value);
  if (!text) return false;
  const segments = text.split(/[^a-z0-9]+/).filter(Boolean);
  if (segments.some((segment) => ["ai", "aimatch", "airoyale", "bot", "botmatch"].includes(segment))) return true;
  const compactText = compact(text);
  return ["ai", "aimatch", "airoyale", "bot", "botmatch"].includes(compactText);
}

function normalizeMode(value: unknown): string {
  return normalize(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function canonicalBattleRoyaleMode(value: string): string {
  return value;
}

function rawValues(input: MatchMetadata | null | undefined, keys: readonly string[]): unknown[] {
  return allValues(input, keys).filter((value) => value !== undefined && value !== null);
}

function normalizeMatchType(value: unknown): string {
  return normalize(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function canonicalMatchType(value: string): "official" | "competitive" | null {
  if (value === "official") return "official";
  if (
    value === "competitive"
    || value === "ranked"
    || value === "ranked-fpp"
    || value === "ranked-tpp"
  ) return "competitive";
  return null;
}

function modeFamilyReason(mode: string): MatchEligibilityReason | null {
  if (!mode) return "missing_mode";
  if (hasToken(mode, ["unknown", "unavailable", "null"])) return "unknown_mode";
  if (hasToken(mode, ["seasonal"])) return "seasonal_match";
  if (hasToken(mode, ["tdm"])) return "tdm_mode";
  if (hasToken(mode, ["event", "arcade", "training"])) return "event_mode";
  if (hasToken(mode, ["custom"])) return "custom_mode_family";

  // PUBG custom game mode families are normal/war/zombie/conquest/esports;
  // perspective/party suffixes are intentionally ignored here.  A family
  // token anywhere in a compound mode is evidence; checking only the first
  // segment would let values such as `squad-fpp-war` through.
  const segments = mode.split(/[^a-z0-9]+/).filter(Boolean);
  if (CUSTOM_MODE_FAMILIES.some((family) => segments.includes(family) || compact(mode) === family)) {
    return "custom_mode_family";
  }
  return null;
}

export function normalizeBenchmarkMatchType(input: MatchMetadata | null | undefined): "official" | "competitive" | null {
  const result = evaluateMatchEligibility(input, "benchmark");
  return result.eligible ? result.matchType : null;
}

export function evaluateMatchEligibility(
  input: MatchMetadata | null | undefined,
  purpose: MatchEligibilityPurpose = "ai-summary",
): MatchEligibilityResult {
  const primaryModeValues = rawValues(input, ["gameMode", "game_mode", "gameModeName", "game_mode_name"]);
  const secondaryModeValues = rawValues(input, ["mode"]);
  const modeValues = primaryModeValues.length > 0 ? primaryModeValues : secondaryModeValues;
  const typeValues = rawValues(input, ["matchType", "match_type"]);
  const modeTexts = modeValues.map(normalizeMode);
  const canonicalModes = modeTexts.map((mode) => primaryModeValues.length > 0 ? canonicalBattleRoyaleMode(mode) : mode);
  const modeText = canonicalModes.find(Boolean) || "";
  const secondaryTypeTexts = secondaryModeValues.map(normalizeMatchType);
  const matchTypeTexts = typeValues.map(normalizeMatchType);
  const normalizedTypes = matchTypeTexts.map(canonicalMatchType).filter((value): value is "official" | "competitive" => value !== null);
  const normalizedSecondaryTypes = secondaryTypeTexts
    .map(canonicalMatchType)
    .filter((value): value is "official" | "competitive" => value !== null);
  const normalizedType = normalizedTypes.includes("competitive") || normalizedSecondaryTypes.includes("competitive")
    ? "competitive"
    : normalizedTypes[0] || normalizedSecondaryTypes[0] || null;

  if (
    rawValues(input, ["matchType", "match_type", "gameMode", "game_mode", "mode"]).some(aiOrBotLabel)
    || hasExplicitFlag(input, [
      "isBotMatch", "is_bot_match", "isBot", "is_bot",
      "isAiMatch", "is_ai_match", "isAI", "is_ai",
      "isAiroyale", "is_airoyale", "bot", "ai",
    ])
    || hasExplicitFalseFlag(input, ["isHuman", "is_human", "human"])
  ) {
    return { eligible: false, reason: "ai_or_bot", mode: null, matchType: normalizedType };
  }
  if (matchTypeTexts.some((value) => value === "seasonal" || value.startsWith("seasonal-"))) {
    return { eligible: false, reason: "seasonal_match", mode: null, matchType: normalizedType };
  }
  if (matchTypeTexts.some((value) => hasToken(value, ["tdm"]))) {
    return { eligible: false, reason: "tdm_mode", mode: null, matchType: normalizedType };
  }
  if (matchTypeTexts.some((value) => hasToken(value, ["custom"]))) {
    return { eligible: false, reason: "custom_match", mode: null, matchType: normalizedType };
  }
  if (matchTypeTexts.some((value) => hasToken(value, ["event", "arcade", "training"]))) {
    return { eligible: false, reason: "event_mode", mode: null, matchType: normalizedType };
  }
  if (hasExplicitFlag(input, ["isCustomMatch", "is_custom_match", "customMatch", "custom_match", "isCustomGame", "is_custom_game"])) {
    return { eligible: false, reason: "custom_match", mode: null, matchType: normalizedType };
  }
  if (hasExplicitFlag(input, ["isEventMode", "is_event_mode", "eventMode", "event_mode"])) {
    return { eligible: false, reason: "event_mode", mode: null, matchType: normalizedType };
  }

  if (modeValues.length === 0 || modeValues.some((value) => typeof value !== "string" || !normalize(value))) {
    return { eligible: false, reason: "missing_mode", mode: null, matchType: normalizedType };
  }
  for (const candidateMode of modeTexts) {
    const modeReason = modeFamilyReason(candidateMode);
    if (modeReason) return { eligible: false, reason: modeReason, mode: null, matchType: normalizedType };
  }
  // `matchInfo.mode` is used by older persistence code as a match-type alias
  // (`ranked`, `normal`, ...). Preserve it for diagnostics but do not let that
  // alias override a canonical top-level gameMode. Real event/custom/TDM or
  // explicit unknown evidence still fails closed.
  if (primaryModeValues.length > 0) {
    for (const secondary of secondaryModeValues.map(normalizeMode)) {
      if (["ranked", "ranked-fpp", "ranked-tpp", "official", "competitive"].includes(secondary)) continue;
      const secondaryReason = modeFamilyReason(secondary);
      if (secondaryReason) return { eligible: false, reason: secondaryReason, mode: null, matchType: normalizedType };
      if (secondary === "unknown" || secondary === "unavailable") {
        return { eligible: false, reason: "unknown_mode", mode: null, matchType: normalizedType };
      }
    }
  }

  const mapTexts = rawValues(input, ["mapName", "map_name", "map", "mapId", "map_id"]).map(normalize);
  if (mapTexts.some((mapText) => TDM_MAPS.has(compact(mapText)) || TDM_MAPS.has(mapText))) {
    return { eligible: false, reason: "tdm_map", mode: null, matchType: normalizedType };
  }

  const uniqueModes = Array.from(new Set(canonicalModes.filter(Boolean)));
  if (uniqueModes.length > 1 && uniqueModes.some((value) => BR_MODE_SET.has(value))) {
    return { eligible: false, reason: "conflicting_mode", mode: null, matchType: normalizedType };
  }
  if (!BR_MODE_SET.has(modeText as KnownBattleRoyaleMode)) {
    return {
      eligible: false,
      reason: modeText ? "non_battle_royale_mode" : "missing_mode",
      mode: null,
      matchType: normalizedType,
    };
  }

  const unsupportedType = matchTypeTexts.some((value) => value && !canonicalMatchType(value) && value !== "unknown");
  const isBenchmarkPurpose = purpose === "benchmark" || purpose === "benchmark-persistence";
  if (unsupportedType || (isBenchmarkPurpose && !CANONICAL_MATCH_TYPES.has(normalizedType || ""))) {
    return {
      eligible: false,
      reason: "match_type_not_canonical",
      mode: modeText as KnownBattleRoyaleMode,
      matchType: normalizedType,
    };
  }

  return {
    eligible: true,
    reason: "eligible",
    mode: modeText as KnownBattleRoyaleMode,
    matchType: normalizedType,
  };
}

export function isAiSummaryEligibleMatch(input: MatchMetadata | null | undefined): boolean {
  return evaluateMatchEligibility(input, "ai-summary").eligible;
}

export const isEligibleForAiSummary = isAiSummaryEligibleMatch;

export function isBenchmarkEligibleMatch(input: MatchMetadata | null | undefined): boolean {
  return evaluateMatchEligibility(input, "benchmark").eligible;
}

export const getMatchEligibility = evaluateMatchEligibility;
export const checkMatchEligibility = evaluateMatchEligibility;
export const isEligibleForBenchmark = isBenchmarkEligibleMatch;

/** Return true when metadata identifies an AI, bot, or AI-royale match. */
export function isAiOrBotMatch(input: MatchMetadata | null | undefined): boolean {
  const reason = evaluateMatchEligibility(input, "ai-summary").reason;
  return reason === "ai_or_bot" || reason === "seasonal_match";
}

/** Benchmark persistence gate; raw/history persistence intentionally bypasses it. */
export function isStandardBenchmarkMatch(input: MatchMetadata | null | undefined): boolean {
  return evaluateMatchEligibility(input, "benchmark").eligible;
}
