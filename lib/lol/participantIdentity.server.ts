import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { getLolAccountNamesByPuuids, isLolPersistenceEnabled } from "./persistence.server";
import { summarizeRecentMatches } from "./summary";
import type { LolChallenges } from "./challenges";
import type { LolMatchDetails, LolRecentMatch, LolSearchResult, LolParticipantIdentity } from "./types";

export type ServerLolMatchDetails = Omit<LolMatchDetails, "teams"> & {
  teams: Array<Omit<LolMatchDetails["teams"][number], "participants"> & {
    participants: Array<LolMatchDetails["teams"][number]["participants"][number] & { puuid?: string }>;
  }>;
};
export type ServerLolRecentMatch = Omit<LolRecentMatch, "details" | "teammates"> & {
  challenges?: LolChallenges;
  details?: Pick<ServerLolMatchDetails, "teams">;
  teammates?: Array<LolParticipantIdentity & { puuid?: string; riotId: string; win: boolean | null }>;
};
export type ServerLolSearchResult = Omit<LolSearchResult, "matches"> & { matches: ServerLolRecentMatch[] };

function secret(): string | undefined {
  return process.env.LOL_PARTICIPANT_REF_SECRET?.trim() || undefined;
}

export function lolParticipantPlayerKey(puuid: string): string | undefined {
  const value = secret();
  return value ? createHmac("sha256", value).update(puuid).digest("hex").slice(0, 32) : undefined;
}

export function sealLolParticipantRef(puuid: string): string | undefined {
  const value = secret();
  if (!value) return undefined;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(puuid)) throw new Error("invalid participant identifier");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(value).digest(), iv);
  cipher.setAAD(Buffer.from("lol-participant:v1"));
  const encrypted = Buffer.concat([cipher.update(puuid, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function openLolParticipantRef(ref: string): string | null {
  const value = secret();
  if (!value || !/^[A-Za-z0-9_-]{40,210}$/.test(ref)) return null;
  try {
    const bytes = Buffer.from(ref, "base64url");
    if (bytes.toString("base64url") !== ref || bytes[0] !== 1) return null;
    const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(value).digest(), bytes.subarray(1, 13));
    decipher.setAAD(Buffer.from("lol-participant:v1"));
    decipher.setAuthTag(bytes.subarray(13, 29));
    const puuid = Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString("utf8");
    return /^[A-Za-z0-9_-]{1,128}$/.test(puuid) ? puuid : null;
  } catch {
    return null;
  }
}

type ParticipantDto<T> = T extends Array<infer Item> ? ParticipantDto<Item>[]
  : T extends object ? { [Key in keyof T as Key extends "puuid" | "challenges" ? never : Key]: ParticipantDto<T[Key]> }
    & (T extends { riotId: string } ? LolParticipantIdentity : unknown) : T;

export async function lolParticipantDto<T>(input: T): Promise<ParticipantDto<T>> {
  const puuids = new Set<string>();
  function collect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    const row = value as Record<string, unknown>;
    if (typeof row.riotId === "string" && typeof row.puuid === "string" && row.puuid) puuids.add(row.puuid);
    Object.values(row).forEach(collect);
  }
  collect(input);
  const names = new Map<string, string>();
  if (puuids.size && process.env.LOL_PARTICIPANT_NAME_MODE !== "match_time" && isLolPersistenceEnabled()) {
    const ids = [...puuids];
    for (let offset = 0; offset < ids.length; offset += 100) {
      for (const row of await getLolAccountNamesByPuuids(ids.slice(offset, offset + 100)))
        names.set(row.puuid, `${row.game_name}#${row.tag_line}`);
    }
  }
  if (puuids.size && !secret()) console.warn("[lol-participant] fallback", { reasonCode: "missing_participant_ref_secret" });
  const identities = new Map([...puuids].map((puuid) => [puuid, {
    playerKey: lolParticipantPlayerKey(puuid), ref: sealLolParticipantRef(puuid),
  }]));
  function convert(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(convert);
    const row = value as Record<string, unknown>;
    const result = Object.fromEntries(Object.entries(row).filter(([key]) => key !== "puuid" && key !== "challenges").map(([key, item]) => [key, convert(item)]));
    if (typeof row.riotId === "string" && typeof row.puuid === "string") {
      result.riotId = names.get(row.puuid) ?? row.riotId;
      const identity = identities.get(row.puuid);
      if (identity?.ref) Object.assign(result, identity);
      else { delete result.ref; delete result.playerKey; }
    }
    return result;
  }
  return convert(input) as ParticipantDto<T>;
}

export async function lolSearchResultDto(input: ServerLolSearchResult): Promise<LolSearchResult> {
  const result = await lolParticipantDto(input);
  return { ...result, summaries: summarizeRecentMatches(result.matches, `${result.account.gameName}#${result.account.tagLine}`) };
}
