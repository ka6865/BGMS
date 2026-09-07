/**
 * Bounded, read-only acquisition of official match + raw telemetry pairs.
 *
 * This is intentionally a one-shot operator helper: it fetches at most the
 * explicit candidates below, rejects redirects, and writes only local files
 * for a subsequent calculation-upgrade catalog. It never writes Supabase.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import {
  assertHttpsHost,
  RAW_SOURCE_MAX_BYTES,
  RAW_SOURCE_TOTAL_MAX_BYTES,
  readJsonBodyWithinLimit,
  validateMode,
  validateMatchIds,
  validatePlatform,
} from "./fetch_calculation_upgrade_raw_helpers";

dotenv.config({ path: ".env.local", quiet: true });

const { values } = parseArgs({ options: {
  "match-id": { type: "string", multiple: true },
  platform: { type: "string", default: "steam" },
  mode: { type: "string", default: "any" },
} });
const candidates = validateMatchIds((values["match-id"] ?? []).map((value) => String(value)));
const platform = validatePlatform(String(values.platform ?? "steam"));
const modeFilter = validateMode(String(values.mode ?? "any"));
const timeoutMs = 15_000;
const outputDir = resolve("tmp/calculation-upgrade-raw-fetch");
const apiKey = (process.env.PUBG_API_KEY ?? "").split(" ")[0];
if (!apiKey) throw new Error("PUBG_API_KEY missing");

async function getJson(url: URL, headers: Record<string, string>, label: string, remainingBytes?: number): Promise<{ value: any; bytes: number }> {
  const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location) assertHttpsHost(new URL(location, url).toString(), /(^|\.)pubg\.com$/i, `${label}_redirect`);
    throw new Error(`${label}_redirect_rejected`);
  }
  if (!response.ok) throw new Error(`${label}_http_${response.status}`);
  return readJsonBodyWithinLimit(response, { maxBytes: RAW_SOURCE_MAX_BYTES, remainingBytes, label });
}

await mkdir(outputDir, { recursive: true, mode: 0o700 });
const results: Array<Record<string, unknown>> = [];
let telemetryBytes = 0;
for (const matchId of candidates) {
  const matchUrl = assertHttpsHost(`https://api.pubg.com/shards/${platform}/matches/${matchId}`, /^api\.pubg\.com$/i, "match_api");
  const matchResponse = await getJson(matchUrl, {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/vnd.api+json",
  }, "match_api");
  const match = matchResponse.value;
  if (match?.data?.id !== matchId || match.data.attributes?.shardId !== platform
    || !["official", "competitive"].includes(String(match.data.attributes?.matchType).toLowerCase())
    || (modeFilter !== "any" && String(match.data.attributes?.gameMode).toLowerCase() !== modeFilter)) {
    throw new Error("match_identity_or_mode_rejected");
  }
  const assetId = match.data.relationships?.assets?.data?.[0]?.id;
  const asset = (match.included ?? []).find((item: any) => item?.type === "asset" && item.id === assetId);
  const telemetryUrl = assertHttpsHost(String(asset?.attributes?.URL ?? ""), /(^|\.)pubg\.com$/i, "telemetry_asset");
  const telemetryResponse = await getJson(telemetryUrl, { Accept: "application/json" }, "telemetry_asset", RAW_SOURCE_TOTAL_MAX_BYTES - telemetryBytes);
  telemetryBytes += telemetryResponse.bytes;
  const telemetry = telemetryResponse.value;
  if (!Array.isArray(telemetry)) throw new Error("telemetry_payload_not_array");
  await writeFile(resolve(outputDir, `${matchId}-match.json`), JSON.stringify(match), { mode: 0o600 });
  await writeFile(resolve(outputDir, `${matchId}-telemetry.json`), JSON.stringify(telemetry), { mode: 0o600 });
  results.push({ matchId, platform, gameMode: match.data.attributes.gameMode, matchType: match.data.attributes.matchType, telemetryEvents: telemetry.length });
}
console.log(JSON.stringify({ outputDir, pairs: results, officialMatchCalls: candidates.length, telemetryDownloads: candidates.length, telemetryBytes, providerCalls: 0, upstreamDownloads: candidates.length }, null, 2));
