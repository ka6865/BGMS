import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseLegacyCopyManifest, readLegacyCopyRecords } from "../lib/pubg-analysis/legacyCopyManifest";
import { readObjectForVerification } from "../lib/pubg-analysis/r2Service";
import { hasObservedPlayerMatchValues, upsertPlayerMatches, type PlayerMatchRecord } from "../lib/pubg/playerMatches";

type RestoreOptions = { aliasKey: string; apply?: boolean };
type MatchRow = Record<string, unknown>;
const ALIAS_KEY = /^telemetry-source\/legacy-aliases\/v1\/[a-f0-9]{64}\.enc$/;
const SELECT_FIELDS = "player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,ranking_eligible,knocks,survival_time";

export function playerMatchRecordMatchesLiveRow(expected: PlayerMatchRecord, row: MatchRow): boolean {
  const dateMatches = typeof row.played_at === "string" && Number.isFinite(Date.parse(row.played_at))
    && Date.parse(row.played_at) === Date.parse(expected.played_at);
  const optionalNumberMatches = (field: "knocks" | "survival_time") =>
    (row[field] === null || row[field] === undefined ? undefined : row[field]) === expected[field];
  return hasObservedPlayerMatchValues(row)
    && row.player_id === expected.player_id
    && row.platform === expected.platform
    && row.match_id === expected.match_id
    && row.account_id === expected.account_id
    && dateMatches
    && row.game_mode === expected.game_mode
    && row.map_name === expected.map_name
    && row.kills === expected.kills
    && row.damage === expected.damage
    && row.win_place === expected.win_place
    && row.match_type === expected.match_type
    && (row.ranking_eligible ?? undefined) === expected.ranking_eligible
    && optionalNumberMatches("knocks")
    && optionalNumberMatches("survival_time");
}

function loadCredentials(): { url: string; serviceKey: string; recoverySecret: string } {
  dotenv.config({ path: process.env.BGMS_ENV_FILE || ".env.local", quiet: true });
  if (process.env.BGMS_RECOVERY_ENV_FILE) {
    dotenv.config({ path: process.env.BGMS_RECOVERY_ENV_FILE, quiet: true });
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const recoverySecret = process.env.R2_RECOVERY_ARCHIVE_KEY ?? "";
  if (!url || !serviceKey) throw new Error("legacy-copy-database-credentials-missing");
  if (!recoverySecret.trim()) throw new Error("legacy-copy-recovery-secret-missing");
  return { url, serviceKey, recoverySecret };
}

export async function runRestoreLegacyPlayerMatches(options: RestoreOptions): Promise<{
  dryRun: boolean; verifiedRecords: number; existingRecords: number; plannedInserts: number; restoredRecords: number;
}> {
  if (!ALIAS_KEY.test(options.aliasKey)) throw new Error("legacy-copy-alias-key-invalid");
  const { url, serviceKey, recoverySecret } = loadCredentials();
  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }) },
  });

  const encryptedAlias = await readObjectForVerification(options.aliasKey);
  if (!encryptedAlias) throw new Error("legacy-copy-alias-missing");
  const manifest = parseLegacyCopyManifest(encryptedAlias.body, recoverySecret);
  const sourceObject = await readObjectForVerification(manifest.sourceKey);
  if (!sourceObject) throw new Error("legacy-copy-source-missing");
  const records = readLegacyCopyRecords(encryptedAlias.body, sourceObject.body, recoverySecret);

  const missing: PlayerMatchRecord[] = [];
  let existingRecords = 0;
  for (const record of records) {
    const { data, error } = await db.from("pubg_player_matches")
      .select(SELECT_FIELDS)
      .eq("platform", manifest.platform)
      .eq("match_id", manifest.matchId)
      .eq("account_id", record.account_id)
      .maybeSingle();
    if (error) throw new Error("legacy-copy-live-record-read-failed");
    if (data) {
      if (!playerMatchRecordMatchesLiveRow(record, data as MatchRow)) {
        throw new Error("legacy-copy-live-record-conflict");
      }
      existingRecords++;
      continue;
    }

    const { data: identityRows, error: identityError } = await db.from("pubg_player_matches")
      .select("player_id,account_id")
      .eq("platform", manifest.platform)
      .eq("match_id", manifest.matchId)
      .eq("player_id", record.player_id);
    if (identityError) throw new Error("legacy-copy-live-identity-read-failed");
    if ((identityRows ?? []).length) throw new Error("legacy-copy-live-identity-conflict");
    missing.push(record);
  }

  if (!options.apply || missing.length === 0) {
    return { dryRun: !options.apply, verifiedRecords: records.length, existingRecords, plannedInserts: missing.length, restoredRecords: 0 };
  }
  if (!await upsertPlayerMatches(db, missing, { ignoreDuplicates: true })) {
    throw new Error("legacy-copy-upsert-rejected");
  }

  let restoredRecords = 0;
  for (const record of missing) {
    const { data, error } = await db.from("pubg_player_matches")
      .select(SELECT_FIELDS)
      .eq("platform", manifest.platform)
      .eq("match_id", manifest.matchId)
      .eq("account_id", record.account_id)
      .maybeSingle();
    if (error) throw new Error("legacy-copy-post-write-read-failed");
    if (!data || !playerMatchRecordMatchesLiveRow(record, data as MatchRow)) {
      throw new Error("legacy-copy-post-write-record-mismatch");
    }
    restoredRecords++;
  }
  return { dryRun: false, verifiedRecords: records.length, existingRecords, plannedInserts: missing.length, restoredRecords };
}

export async function main(args = process.argv.slice(2)) {
  const apply = args.includes("--apply");
  const filtered = args.filter((arg) => arg !== "--apply");
  if (filtered.length !== 2 || filtered[0] !== "--alias-key") throw new Error("legacy-copy-arguments-invalid");
  const result = await runRestoreLegacyPlayerMatches({ aliasKey: filtered[1], apply });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof Error && /^legacy-copy-[a-z-]+$/.test(error.message)
      ? error.message : "legacy-copy-restore-failed";
    console.error(`Legacy player match restore failed (${code}).`);
    process.exitCode = 1;
  });
}
