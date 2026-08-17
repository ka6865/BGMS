import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fetchAndIngestBasicMatchSummary } from "../lib/pubg/playerMatchesIngest";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const DEFAULT_LIMIT = 300;
const REQUEST_DELAY_MS = 1_000;
export const UNKNOWN_MATCH_TYPE_BACKFILL_ORDER = { column: "played_at", ascending: false } as const;

type UnknownMatchRow = {
  match_id: string;
  player_id: string;
  platform: string;
};

export function parseUnknownMatchTypeBackfillArgs(args: string[]): { limit: number; delayMs: number } {
  const limitIndex = args.indexOf("--limit");
  const requestedLimit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : NaN;
  return {
    limit: Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, DEFAULT_LIMIT) : DEFAULT_LIMIT,
    delayMs: REQUEST_DELAY_MS,
  };
}

export function shouldStopUnknownMatchTypeBackfill(status: number): boolean {
  return status === 429;
}

export function getUnknownMatchTypeBackfillDisposition(status: number, updated: boolean): "updated" | "unavailable" | "rate_limited" | "retry" {
  if (updated) return "updated";
  if (status === 404) return "unavailable";
  if (status === 429) return "rate_limited";
  return "retry";
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runUnknownMatchTypeBackfill() {
  const { limit, delayMs } = parseUnknownMatchTypeBackfillArgs(process.argv.slice(2));
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];
  if (!supabaseUrl || !serviceKey || !apiKey) throw new Error("Missing Supabase or PUBG API credentials");

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data, error } = await supabase
    .from("pubg_player_matches")
    .select("match_id, player_id, platform")
    .eq("match_type", "unknown")
    .order(UNKNOWN_MATCH_TYPE_BACKFILL_ORDER.column, { ascending: UNKNOWN_MATCH_TYPE_BACKFILL_ORDER.ascending })
    .limit(limit);
  if (error) throw new Error(`Failed to load unknown match types: ${error.message}`);

  const candidates = (data || []) as UnknownMatchRow[];
  let updated = 0;
  let unresolved = 0;
  let unavailable = 0;
  let rateLimited = false;
  console.log(`[MATCH-TYPE BACKFILL] candidates=${candidates.length} limit=${limit} delayMs=${delayMs}`);

  for (const candidate of candidates) {
    let status = 0;
    const record = await fetchAndIngestBasicMatchSummary(
      supabase,
      candidate.match_id,
      candidate.player_id,
      candidate.platform,
      apiKey,
      (responseStatus) => { status = responseStatus; },
    );
    const disposition = getUnknownMatchTypeBackfillDisposition(status, Boolean(record));
    if (disposition === "updated") updated += 1;
    if (disposition === "unavailable") {
      unavailable += 1;
      const { error: updateError } = await supabase
        .from("pubg_player_matches")
        .update({ match_type: "unavailable" })
        .eq("match_id", candidate.match_id)
        .eq("player_id", candidate.player_id)
        .eq("platform", candidate.platform)
        .eq("match_type", "unknown");
      if (updateError) throw new Error(`Failed to mark unavailable match: ${updateError.message}`);
    }
    if (disposition === "retry") unresolved += 1;
    if (disposition === "rate_limited") {
      rateLimited = true;
      console.warn("[MATCH-TYPE BACKFILL] PUBG API rate limited; stopping safely.");
      break;
    }
    await wait(delayMs);
  }

  const result = { candidates: candidates.length, updated, unavailable, unresolved, rateLimited };
  console.log(`[MATCH-TYPE BACKFILL] ${JSON.stringify(result)}`);
  return result;
}

if (process.argv[1]?.includes("backfill_unknown_match_types")) {
  runUnknownMatchTypeBackfill().catch((error) => {
    console.error("[MATCH-TYPE BACKFILL] failed", error);
    process.exitCode = 1;
  });
}
