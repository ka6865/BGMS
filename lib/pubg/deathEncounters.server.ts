import "server-only";

import {
  containsTelemetryAccountEvidence,
  parseOrdinaryTelemetryUrl,
  relationshipBoundTelemetryAsset,
  hasMatchingTelemetryDefinition,
} from "@/lib/pubg-analysis/telemetrySource";
import { filterTelemetryEvents } from "@/lib/pubg-analysis/telemetryContract";
import { TELEMETRY_VERSION } from "@/lib/pubg-analysis/constants";
import {
  buildTelemetryAnalyzeCacheKey,
  parseTelemetryAnalyzeCacheEnvelope,
} from "@/lib/pubg-analysis/telemetryCacheKey.server";
import { downloadFromR2 } from "@/lib/pubg-analysis/r2Service";
import {
  createTelemetryIdentity,
  hasMatchingUpstreamMatchId,
  isCanonicalMatchId,
} from "@/lib/pubg-analysis/telemetryIdentity";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { isBanAccountId, isBanPlatform, type BanPlatform } from "./banStatus";
import {
  extractDeathEncounters,
  type DeathEncounter,
} from "./deathEncounters";

export type DeathEncounterSourceKind = "r2" | "upstream" | "unavailable";

export type DeathEncounterSource = {
  kind: DeathEncounterSourceKind;
  matchId: string;
  platform: BanPlatform;
  /** The participant account verified against the official match payload. */
  verifiedSubjectAccountId: string;
  /** Match nickname observed with the verified subject account, when available. */
  verifiedSubjectNicknameAtMatch?: string;
  checkedAt: string;
  reason?: string;
};

export type DeathEncounterLoadInput = {
  matchId: string;
  platform: BanPlatform;
  subjectAccountId?: string;
  nickname?: string;
};

export type DeathEncounterLoadResult = {
  encounters: DeathEncounter[];
  source: DeathEncounterSource;
};

type VerifiedTelemetry = {
  events: readonly unknown[];
  subjectAccountId: string;
  nicknameAtMatch?: string | null;
};

export type DeathEncounterLoaderDeps = {
  /** Injected in tests; production uses the private R2 reader. */
  downloadFromR2?: (key: string) => Promise<string | null>;
  /** Injected in tests; production uses the native fetch implementation. */
  fetch?: typeof fetch;
  /** Optional strict source adapter used by tests or a deployment-specific R2 gateway. */
  loadVerifiedUpstreamTelemetry?: (
    input: DeathEncounterLoadInput,
  ) => Promise<VerifiedTelemetry>;
  /** Backward-compatible alias for the adapter above. */
  loadVerifiedTelemetry?: (
    input: DeathEncounterLoadInput,
  ) => Promise<VerifiedTelemetry>;
  now?: () => Date;
};

const ACCOUNT_PSEUDONYM = /^[a-f0-9]{32}$/u;
const VERIFIED_SOURCE_TTL_MS = 60_000;
const VERIFIED_SOURCE_MAX_ENTRIES = 128;
const verifiedSourceCache = new Map<string, { result: DeathEncounterLoadResult; expiresAt: number }>();

function isRawAccountId(value: unknown): value is string {
  return isBanAccountId(value) && !ACCOUNT_PSEUDONYM.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result || null;
}

function participantAccountId(participant: Record<string, unknown>): string | null {
  const attributes = isRecord(participant.attributes) ? participant.attributes : null;
  const stats = attributes && isRecord(attributes.stats) ? attributes.stats : null;
  for (const value of [
    stats?.playerId,
    stats?.accountId,
    attributes?.accountId,
    participant.accountId,
    participant.playerId,
  ]) {
    if (isRawAccountId(value)) return value;
  }
  return null;
}

function participantName(participant: Record<string, unknown>): string | null {
  const attributes = isRecord(participant.attributes) ? participant.attributes : null;
  const stats = attributes && isRecord(attributes.stats) ? attributes.stats : null;
  return text(stats?.name) || text(attributes?.name);
}

function participantStats(participant: Record<string, unknown>): Record<string, unknown> | null {
  const attributes = isRecord(participant.attributes) ? participant.attributes : null;
  return attributes && isRecord(attributes.stats) ? attributes.stats : null;
}

function sourceAt(now: () => Date): string {
  const date = now();
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function unavailableSource(input: DeathEncounterLoadInput, now: () => Date, reason: string): DeathEncounterSource {
  return {
    kind: "unavailable",
    matchId: input.matchId,
    platform: input.platform,
    verifiedSubjectAccountId: input.subjectAccountId || "",
    checkedAt: sourceAt(now),
    reason,
  };
}

export class DeathEncounterSourceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly source: DeathEncounterSource;

  constructor(
    message: string,
    source: DeathEncounterSource,
    status = 404,
    code = "PUBG_DEATH_ENCOUNTER_SOURCE_UNAVAILABLE",
  ) {
    super(message);
    this.name = "DeathEncounterSourceError";
    this.code = code;
    this.status = status;
    this.source = source;
  }
}

function invalidInput(input: DeathEncounterLoadInput, now: () => Date, reason: string): DeathEncounterSourceError {
  return new DeathEncounterSourceError(
    "제재 추적에 필요한 공식 매치 원본을 확인할 수 없습니다.",
    unavailableSource(input, now, reason),
    400,
    "PUBG_DEATH_ENCOUNTER_INVALID_INPUT",
  );
}

function unavailable(input: DeathEncounterLoadInput, now: () => Date, reason: string, status = 404): DeathEncounterSourceError {
  return new DeathEncounterSourceError(
    "선택한 매치의 공식 텔레메트리를 사용할 수 없어 제재 추적 후보를 확인할 수 없습니다.",
    unavailableSource(input, now, reason),
    status,
  );
}

function assertTelemetryEvidence(
  verified: VerifiedTelemetry,
  input: DeathEncounterLoadInput,
  now: () => Date,
): DeathEncounterLoadResult {
  if (!isRawAccountId(verified.subjectAccountId)) {
    throw invalidInput(input, now, "subject-account-id-unverified");
  }
  if (input.subjectAccountId && verified.subjectAccountId !== input.subjectAccountId) {
    throw invalidInput(input, now, "subject-account-id-mismatch");
  }
  if (!Array.isArray(verified.events) || verified.events.length === 0) {
    throw unavailable(input, now, "telemetry-empty");
  }
  if (!containsTelemetryAccountEvidence(verified.events, verified.subjectAccountId)) {
    throw unavailable(input, now, "telemetry-account-evidence-missing");
  }
  const extractionInput = {
    matchId: input.matchId,
    platform: input.platform,
    subjectAccountId: verified.subjectAccountId,
    events: verified.events,
  } as const;
  return {
    encounters: extractDeathEncounters(extractionInput),
    source: {
      kind: "upstream",
      matchId: input.matchId,
      platform: input.platform,
      verifiedSubjectAccountId: verified.subjectAccountId,
      ...(verified.nicknameAtMatch ? { verifiedSubjectNicknameAtMatch: verified.nicknameAtMatch } : {}),
      checkedAt: sourceAt(now),
    },
  };
}

function telemetryUrlFromAsset(
  matchData: Record<string, unknown>,
  input: DeathEncounterLoadInput,
  now: () => Date,
): { asset: Record<string, unknown>; id: string; url: string } {
  const binding = relationshipBoundTelemetryAsset(matchData);
  if (!binding || !isRecord(binding.asset.attributes)) {
    throw unavailable(input, now, "telemetry-asset-relationship-missing");
  }
  try {
    return {
      ...binding,
      url: parseOrdinaryTelemetryUrl(binding.asset.attributes.URL, binding.id),
    };
  } catch {
    throw unavailable(input, now, "telemetry-url-invalid");
  }
}

function matchParticipant(
  matchData: Record<string, unknown>,
  input: DeathEncounterLoadInput,
  now: () => Date,
): { participant: Record<string, unknown>; subjectAccountId: string; nickname: string } {
  const included = Array.isArray(matchData.included) ? matchData.included : [];
  const participants = included.filter((item): item is Record<string, unknown> => (
    isRecord(item) && item.type === "participant" && participantStats(item) !== null
  ));
  const expectedAccount = input.subjectAccountId;
  const expectedNickname = text(input.nickname);
  const matched = expectedAccount
    ? participants.filter((participant) => participantAccountId(participant) === expectedAccount)
    : expectedNickname
      ? participants.filter((participant) => normalizeName(participantName(participant) || "") === normalizeName(expectedNickname))
      : [];
  if (matched.length !== 1) {
    throw invalidInput(input, now, matched.length === 0 ? "participant-not-found" : "participant-ambiguous");
  }
  const participant = matched[0];
  const subjectAccountId = participantAccountId(participant);
  const nickname = participantName(participant);
  if (!subjectAccountId || !nickname) throw invalidInput(input, now, "participant-identity-missing");
  return { participant, subjectAccountId, nickname };
}

function telemetryTeamContext(
  matchData: Record<string, unknown>,
  participant: Record<string, unknown>,
  subjectAccountId: string,
  nickname: string,
): { teamNames: Set<string>; teamAccountIds: Set<string> } {
  const included = Array.isArray(matchData.included) ? matchData.included : [];
  const participants = included.filter((item): item is Record<string, unknown> => (
    isRecord(item) && item.type === "participant"
  ));
  const rosters = included.filter((item): item is Record<string, unknown> => (
    isRecord(item) && item.type === "roster"
  ));
  const roster = rosters.find((item) => {
    const relationships = isRecord(item.relationships) ? item.relationships : null;
    const refs = relationships && isRecord(relationships.participants) ? relationships.participants.data : null;
    return Array.isArray(refs) && refs.some((ref) => isRecord(ref) && ref.id === participant.id);
  });
  const relationships = roster && isRecord(roster.relationships) ? roster.relationships : null;
  const refs = relationships && isRecord(relationships.participants) ? relationships.participants.data : null;
  const teamParticipants = Array.isArray(refs)
    ? refs
      .filter((ref): ref is Record<string, unknown> => isRecord(ref) && typeof ref.id === "string")
      .map((ref) => participants.find((candidate) => candidate.id === ref.id))
      .filter((value): value is Record<string, unknown> => Boolean(value))
    : [participant];
  if (!teamParticipants.some((candidate) => participantAccountId(candidate) === subjectAccountId)) {
    teamParticipants.push(participant);
  }
  const teamNames = new Set<string>(teamParticipants
    .map((candidate) => participantName(candidate))
    .filter((value): value is string => Boolean(value))
    .map(normalizeName));
  if (!teamNames.size) teamNames.add(normalizeName(nickname));
  const teamAccountIds = new Set<string>(teamParticipants
    .map(participantAccountId)
    .filter((value): value is string => Boolean(value)));
  teamAccountIds.add(subjectAccountId);
  return { teamNames, teamAccountIds };
}

async function loadFromPrivateR2(
  input: DeathEncounterLoadInput,
  now: () => Date,
  readR2: (key: string) => Promise<string | null>,
): Promise<DeathEncounterLoadResult | null> {
  if (!input.subjectAccountId || !isRawAccountId(input.subjectAccountId)) return null;
  let identity;
  try {
    identity = createTelemetryIdentity({
      matchId: input.matchId,
      platform: input.platform,
      playerId: input.subjectAccountId,
      mode: "lite",
      telemetryVersion: TELEMETRY_VERSION,
    });
  } catch {
    return null;
  }
  let fileText: string | null = null;
  try {
    fileText = await readR2(buildTelemetryAnalyzeCacheKey(identity));
  } catch {
    return null;
  }
  if (!fileText) return null;
  try {
    const events = parseTelemetryAnalyzeCacheEnvelope(JSON.parse(fileText), identity);
    if (!events || events.length === 0 || !containsTelemetryAccountEvidence(events, input.subjectAccountId)) return null;
    if (input.nickname) {
      const nickname = normalizeName(input.nickname);
      const hasName = events.some((event) => containsNameEvidence(event, input.subjectAccountId!, nickname));
      if (!hasName) return null;
    }
    const encounters = extractDeathEncounters({
      matchId: input.matchId,
      platform: input.platform,
      subjectAccountId: input.subjectAccountId,
      events,
    });
    return {
      encounters,
      source: {
        kind: "r2",
        matchId: input.matchId,
        platform: input.platform,
        verifiedSubjectAccountId: input.subjectAccountId,
        ...(input.nickname ? { verifiedSubjectNicknameAtMatch: input.nickname.trim() } : {}),
        checkedAt: sourceAt(now),
      },
    };
  } catch {
    return null;
  }
}

function containsNameEvidence(value: unknown, accountId: string, nickname: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsNameEvidence(item, accountId, nickname));
  if (!isRecord(value)) return false;
  const ownAccount = [value.accountId, value.playerId].some((candidate) => candidate === accountId);
  const ownName = [value.name, value.characterName, value.nickname, value.playerName]
    .some((candidate) => typeof candidate === "string" && normalizeName(candidate) === nickname);
  if (ownAccount && ownName) return true;
  return Object.values(value).some((nested) => containsNameEvidence(nested, accountId, nickname));
}

async function loadFromUpstream(
  input: DeathEncounterLoadInput,
  now: () => Date,
  fetchImpl: typeof fetch,
): Promise<DeathEncounterLoadResult> {
  const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];
  if (!apiKey) throw unavailable(input, now, "pubg-api-key-missing", 503);
  const matchUrl = `https://api.pubg.com/shards/${input.platform}/matches/${encodeURIComponent(input.matchId)}`;
  let matchResponse: Response;
  try {
    matchResponse = await fetchImpl(matchUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw unavailable(input, now, "match-fetch-failed", 503);
  }
  if (!matchResponse.ok) {
    throw unavailable(input, now, `match-http-${matchResponse.status}`, matchResponse.status === 404 ? 404 : 503);
  }
  let matchData: unknown;
  try {
    matchData = await matchResponse.json();
  } catch {
    throw unavailable(input, now, "match-json-invalid");
  }
  if (!isRecord(matchData) || !hasMatchingUpstreamMatchId(matchData, input.matchId)) {
    throw invalidInput(input, now, "match-id-mismatch");
  }
  const { participant, subjectAccountId, nickname } = matchParticipant(matchData, input, now);
  const { teamNames, teamAccountIds } = telemetryTeamContext(matchData, participant, subjectAccountId, nickname);
  const { url } = telemetryUrlFromAsset(matchData, input, now);

  let telemetryResponse: Response;
  try {
    telemetryResponse = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw unavailable(input, now, "telemetry-fetch-failed", 503);
  }
  // Native fetch always supplies the final URL. Test adapters may omit it;
  // redirect:error still keeps the production boundary fail-closed.
  if (telemetryResponse.url && telemetryResponse.url !== url) {
    throw invalidInput(input, now, "telemetry-response-url-mismatch");
  }
  if (!telemetryResponse.ok) throw unavailable(input, now, `telemetry-http-${telemetryResponse.status}`, 404);
  let rawTelemetry: unknown;
  try {
    rawTelemetry = await telemetryResponse.json();
  } catch {
    throw invalidInput(input, now, "telemetry-json-invalid");
  }
  if (!Array.isArray(rawTelemetry) || rawTelemetry.length === 0 || !hasMatchingTelemetryDefinition(rawTelemetry, input.matchId, input.platform)) {
    throw invalidInput(input, now, "telemetry-match-definition-mismatch");
  }
  const filtered = filterTelemetryEvents(rawTelemetry, { mode: "full", teamNames, teamAccountIds });
  if (filtered.length === 0 || !containsTelemetryAccountEvidence(filtered, subjectAccountId)) {
    throw invalidInput(input, now, "telemetry-account-evidence-missing");
  }
  return {
    encounters: extractDeathEncounters({
      matchId: input.matchId,
      platform: input.platform,
      subjectAccountId,
      events: filtered,
    }),
    source: {
      kind: "upstream",
      matchId: input.matchId,
      platform: input.platform,
      verifiedSubjectAccountId: subjectAccountId,
      verifiedSubjectNicknameAtMatch: nickname,
      checkedAt: sourceAt(now),
    },
  };
}

function sourceCacheKey(input: DeathEncounterLoadInput): string | null {
  if (input.subjectAccountId && isRawAccountId(input.subjectAccountId)) return `${input.platform}:${input.matchId}:${input.subjectAccountId}`;
  const nickname = text(input.nickname);
  return nickname ? `${input.platform}:${input.matchId}:name:${normalizeName(nickname)}` : null;
}

function copyLoadResult(result: DeathEncounterLoadResult): DeathEncounterLoadResult {
  return {
    encounters: result.encounters.map((encounter) => ({ ...encounter })),
    source: { ...result.source },
  };
}

function readVerifiedSourceCache(input: DeathEncounterLoadInput, now = Date.now()): DeathEncounterLoadResult | null {
  const key = sourceCacheKey(input);
  if (!key) return null;
  const entry = verifiedSourceCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    verifiedSourceCache.delete(key);
    return null;
  }
  if (input.nickname && entry.result.source.verifiedSubjectNicknameAtMatch
    && normalizeName(input.nickname) !== normalizeName(entry.result.source.verifiedSubjectNicknameAtMatch)) return null;
  return copyLoadResult(entry.result);
}

function writeVerifiedSourceCache(result: DeathEncounterLoadResult, input: DeathEncounterLoadInput, now = Date.now()): void {
  if (result.source.kind !== "upstream") return;
  const expiresAt = now + VERIFIED_SOURCE_TTL_MS;
  const canonicalKey = `${result.source.platform}:${result.source.matchId}:${result.source.verifiedSubjectAccountId}`;
  const value = { result: copyLoadResult(result), expiresAt };
  verifiedSourceCache.set(canonicalKey, value);
  const nickname = result.source.verifiedSubjectNicknameAtMatch || text(input.nickname);
  if (nickname) verifiedSourceCache.set(`${result.source.platform}:${result.source.matchId}:name:${normalizeName(nickname)}`, value);
  while (verifiedSourceCache.size > VERIFIED_SOURCE_MAX_ENTRIES) {
    const first = verifiedSourceCache.keys().next().value;
    if (typeof first !== "string") break;
    verifiedSourceCache.delete(first);
  }
}

/**
 * Load death encounters from the private analyzed cache or, on a miss, the
 * relationship-bound official match asset. The caller supplies either a
 * verified account id or a nickname; a nickname is resolved to its account id
 * only after matching the official participant payload.
 */
export async function loadDeathEncounters(
  input: DeathEncounterLoadInput,
  deps: DeathEncounterLoaderDeps = {},
): Promise<DeathEncounterLoadResult> {
  const now = deps.now || (() => new Date());
  if (!isCanonicalMatchId(input.matchId)) throw invalidInput(input, now, "match-id-invalid");
  if (!isBanPlatform(input.platform)) throw invalidInput(input, now, "platform-invalid");
  if (input.subjectAccountId !== undefined && !isRawAccountId(input.subjectAccountId)) {
    throw invalidInput(input, now, "subject-account-id-invalid");
  }
  if (input.nickname !== undefined && (!text(input.nickname) || input.nickname.trim().length > 200)) {
    throw invalidInput(input, now, "nickname-invalid");
  }
  if (!input.subjectAccountId && !text(input.nickname)) throw invalidInput(input, now, "participant-identity-missing");

  const readR2 = deps.downloadFromR2 || downloadFromR2;
  const cached = await loadFromPrivateR2(input, now, readR2);
  if (cached) return cached;
  const memoryCached = readVerifiedSourceCache(input);
  if (memoryCached) return memoryCached;

  const adapter = deps.loadVerifiedUpstreamTelemetry || deps.loadVerifiedTelemetry;
  if (adapter) {
    try {
      const verified = await adapter(input);
      const result = assertTelemetryEvidence(verified, input, now);
      writeVerifiedSourceCache(result, input);
      return result;
    } catch (error) {
      if (error instanceof DeathEncounterSourceError) throw error;
      throw unavailable(input, now, "verified-source-adapter-failed", 503);
    }
  }

  const result = await loadFromUpstream(input, now, deps.fetch || globalThis.fetch);
  writeVerifiedSourceCache(result, input);
  return result;
}

export const loadDeathEncountersFromServer = loadDeathEncounters;
