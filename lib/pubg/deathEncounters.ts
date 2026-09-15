import {
  isCanonicalMatchId,
  type TelemetryPlatform,
} from "@/lib/pubg-analysis/telemetryIdentity";
import { isBanAccountId, isBanPlatform, type BanPlatform } from "./banStatus";

/**
 * A server-verified death relationship.  The account ids in this type are
 * intentionally kept out of public telemetry payloads; callers should only
 * construct it from a private/original telemetry source.
 */
export type DeathEncounter = {
  matchId: string;
  platform: BanPlatform;
  subjectAccountId: string;
  targetAccountId: string;
  eventAt: string;
  role: "killer" | "finisher" | "knocker";
  eventKind?: "knock" | "death";
  nicknameAtMatch: string;
  weapon: string | null;
};

export type ExtractDeathEncountersInput = {
  matchId: string;
  platform: TelemetryPlatform;
  subjectAccountId: string;
  events: readonly unknown[];
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRecord(...values: unknown[]): RecordValue | null {
  return values.find(isRecord) || null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result ? result : null;
}

/**
 * Public replay payloads use a 32-character lower-case hex hash for account
 * ids.  Such a value is not acceptable evidence for a ban lookup.
 */
function isPseudonymAccountId(value: string): boolean {
  return /^[a-f0-9]{32}$/u.test(value);
}

function actorAccountId(actor: unknown): string | null {
  if (typeof actor === "string") return null;
  if (!isRecord(actor)) return null;

  // Some projected fixtures retain an `accountId: ""` alias alongside the
  // canonical playerId.  Prefer the non-empty canonical value in either slot.
  const candidates = [actor.accountId, actor.playerId, actor.accountID, actor.playerID];
  for (const candidate of candidates) {
    const value = text(candidate);
    if (value && isBanAccountId(value) && !isPseudonymAccountId(value)) return value;
  }

  // Official wrappers occasionally put the actor below `character` or
  // `player`; recurse only through those known actor wrappers.
  for (const nested of [actor.character, actor.player]) {
    const value = actorAccountId(nested);
    if (value) return value;
  }
  return null;
}

function actorName(actor: unknown): string | null {
  if (typeof actor === "string") return text(actor);
  if (!isRecord(actor)) return null;
  for (const candidate of [actor.name, actor.characterName, actor.nickname, actor.playerName]) {
    const value = text(candidate);
    if (value) return value;
  }
  for (const nested of [actor.character, actor.player]) {
    const value = actorName(nested);
    if (value) return value;
  }
  return null;
}

function actorTeamId(actor: unknown): string | null {
  if (!isRecord(actor)) return null;
  for (const candidate of [actor.teamId, actor.teamID, actor.teamNumber, actor.team_id]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
    const value = text(candidate);
    if (value) return value;
  }
  for (const nested of [actor.character, actor.player]) {
    const value = actorTeamId(nested);
    if (value) return value;
  }
  return null;
}

function parseEventAt(event: RecordValue): string | null {
  const candidates = [event._D, event.eventAt, event.timestamp, event.time, event.occurredAt];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      const date = new Date(candidate);
      if (Number.isFinite(date.getTime())) return date.toISOString();
      continue;
    }
    const value = text(candidate);
    if (!value) continue;
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}

function isTruthyFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes", "y"].includes(value.trim().toLowerCase());
}

function hasTeamKillMarker(event: RecordValue, targetAccountId: string): boolean {
  for (const key of ["isTeamKill", "teamKill", "isTeamKilled", "team_kill"]) {
    if (isTruthyFlag(event[key])) return true;
  }
  for (const key of ["teamKillers_AccountId", "teamKillerAccountIds", "teamKillersAccountIds"]) {
    const values = event[key];
    if (!Array.isArray(values)) continue;
    if (values.some((value) => {
      if (typeof value === "string") return value.trim() === targetAccountId;
      return actorAccountId(value) === targetAccountId;
    })) return true;
  }
  return false;
}

function weaponText(value: unknown): string | null {
  const direct = text(value);
  if (direct) return direct;
  if (!isRecord(value)) return null;
  for (const key of ["itemId", "weaponId", "damageCauserName", "name", "id", "className"]) {
    const nested = text(value[key]);
    if (nested) return nested;
  }
  for (const key of ["weapon", "item", "damageCauser", "weaponItem"]) {
    const nested = weaponText(value[key]);
    if (nested) return nested;
  }
  return null;
}

function eventWeapon(event: RecordValue, role: DeathEncounter["role"]): string | null {
  // V2 can carry a separate damage record for every credited role. Resolve
  // that record first so a finisher/knocker is never shown with the killer's
  // weapon merely because a common `weapon` field exists on the event.
  const roleSpecificKeys: Record<DeathEncounter["role"], string[]> = {
    killer: ["killerDamageInfo", "killerWeapon", "killerWeaponId"],
    finisher: ["finishDamageInfo", "finisherDamageInfo", "finishWeapon", "finisherWeapon", "finishWeaponId", "finisherWeaponId"],
    knocker: ["dBNODamageInfo", "DBNODamageInfo", "dBNOMakerDamageInfo"],
  };
  for (const key of [...roleSpecificKeys[role], "weapon", "weaponId", "damageCauserName", "damageCauser"]) {
    const value = weaponText(event[key]);
    if (value) return value;
  }
  return null;
}

function unwrapActor(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (actorAccountId(value) || actorName(value)) return value;
  return firstRecord(value.character, value.player, value.actor) || value;
}

function isExcludedSelfOrEnvironment(
  event: RecordValue,
  victim: unknown,
  target: unknown,
  subjectAccountId: string,
): boolean {
  const targetAccountId = actorAccountId(target);
  if (!targetAccountId || targetAccountId === subjectAccountId) return true;
  if (/^(?:ai\.|bot(?:\.|$))/iu.test(targetAccountId)) return true;
  if (["isSuicide", "suicide", "isSuicideKill"].some((key) => isTruthyFlag(event[key]))) return true;
  const victimTeam = actorTeamId(victim);
  const targetTeam = actorTeamId(target);
  if (victimTeam && targetTeam && victimTeam === targetTeam) return true;
  if (hasTeamKillMarker(event, targetAccountId)) return true;
  return false;
}

function encounterFor(
  input: ExtractDeathEncountersInput,
  event: RecordValue,
  victim: unknown,
  target: unknown,
  role: DeathEncounter["role"],
): DeathEncounter | null {
  const targetAccountId = actorAccountId(target);
  const targetName = actorName(target);
  const eventAt = parseEventAt(event);
  if (!targetAccountId || !targetName || !eventAt || isExcludedSelfOrEnvironment(event, victim, target, input.subjectAccountId)) {
    return null;
  }
  return {
    matchId: input.matchId,
    platform: input.platform,
    subjectAccountId: input.subjectAccountId,
    targetAccountId,
    eventAt,
    role,
    nicknameAtMatch: targetName,
    weapon: eventWeapon(event, role),
  };
}

/**
 * Extract each role independently.  A single LogPlayerKillV2 can therefore
 * produce up to three encounters and a repeated event is idempotent by its
 * match/time/target/role identity.
 */
export function extractDeathEncounters(input: ExtractDeathEncountersInput): DeathEncounter[] {
  if (!isCanonicalMatchId(input.matchId)) throw new Error("death-encounter-invalid-match");
  if (!isBanPlatform(input.platform)) throw new Error("death-encounter-invalid-platform");
  if (!isBanAccountId(input.subjectAccountId) || isPseudonymAccountId(input.subjectAccountId)) {
    throw new Error("death-encounter-invalid-subject");
  }
  if (!Array.isArray(input.events)) throw new Error("death-encounter-invalid-events");

  const result: DeathEncounter[] = [];
  // Direct knock events preserve knocks followed by a successful revive.
  for (const raw of input.events) {
    if (!isRecord(raw) || !["LogPlayerMakeGroggy", "LogPlayerMakeDBNO"].includes(String(raw._T || raw.type))) continue;
    const victim = unwrapActor(raw.victim);
    if (actorAccountId(victim) !== input.subjectAccountId) continue;
    const encounter = encounterFor(input, raw, victim, unwrapActor(raw.attacker), "knocker");
    if (encounter && !result.some(e => e.targetAccountId === encounter.targetAccountId && e.eventAt === encounter.eventAt)) {
      result.push({ ...encounter, eventKind: "knock" });
    }
  }
  const hasDirectKnocks = result.length > 0;
  const seen = new Set<string>();
  for (const rawEvent of input.events) {
    if (!isRecord(rawEvent)) continue;
    const eventType = text(rawEvent._T) || text(rawEvent.type);
    if (eventType !== "LogPlayerKillV2" && eventType !== "LogPlayerKill") continue;

    const victim = unwrapActor(rawEvent.victim);
    if (actorAccountId(victim) !== input.subjectAccountId) continue;
    const eventAt = parseEventAt(rawEvent);
    if (!eventAt) continue;

    const candidates: Array<{ role: DeathEncounter["role"]; actor: unknown }> = eventType === "LogPlayerKillV2"
      ? [
        { role: "killer", actor: rawEvent.killer },
        { role: "finisher", actor: rawEvent.finisher },
        { role: "knocker", actor: rawEvent.dBNOMaker },
      ]
      : [{ role: "killer", actor: rawEvent.killer }];

    for (const candidate of candidates) {
      // Death metadata repeats the last knock and supplies the death timestamp,
      // not a second knock. Use it only for legacy sources lacking direct knocks.
      if (candidate.role === "knocker" && hasDirectKnocks) continue;
      const encounter = encounterFor(input, rawEvent, victim, unwrapActor(candidate.actor), candidate.role);
      if (!encounter) continue;
      const key = `${encounter.role}\u0000${encounter.targetAccountId}\u0000${eventAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...encounter, eventKind: "death" });
    }
  }
  return result;
}
