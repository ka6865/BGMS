import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelemetryMapCacheRegistryRow } from "./telemetryMapCache";

export class TelemetryRegistryError extends Error {
  readonly operation: "reserve" | "finalize";
  readonly code: string | null;
  readonly status: number | null;

  constructor(
    operation: "reserve" | "finalize",
    error: { code?: string | null; status?: number | null },
  ) {
    super(`telemetry-cache-${operation}-failed`);
    this.name = "TelemetryRegistryError";
    this.operation = operation;
    this.code = error.code ?? null;
    this.status = error.status ?? null;
  }
}

export async function upsertTelemetryMapCacheReservation(
  supabase: SupabaseClient,
  row: TelemetryMapCacheRegistryRow,
): Promise<void> {
  const { error, status } = await supabase
    .from("telemetry_map_cache_entries")
    .upsert(row, { onConflict: "match_id,platform,player_id,mode,telemetry_version" });
  if (error) {
    throw new TelemetryRegistryError("reserve", { code: error.code, status });
  }
}

type FinalizeTelemetryMapCacheInput = {
  row: TelemetryMapCacheRegistryRow;
  mapName: string;
  gameMode: string;
  processed?: {
    playerId: string;
    platform: string;
    data: unknown;
    updatedAt: string;
  };
};

export async function finalizeTelemetryMapCacheLifecycle(
  supabase: SupabaseClient,
  input: FinalizeTelemetryMapCacheInput,
): Promise<void> {
  const processed = input.processed;
  const { error, status } = await supabase.rpc("finalize_telemetry_cache_write", {
    p_match_id: input.row.match_id,
    p_map_name: input.mapName,
    p_game_mode: input.gameMode,
    p_master_version: Math.floor(input.row.telemetry_version),
    p_storage_path: input.row.storage_path,
    p_platform: input.row.platform,
    p_player_id: input.row.player_id,
    p_mode: input.row.mode,
    p_cache_version: input.row.telemetry_version,
    p_cache_updated_at: input.row.updated_at,
    p_processed_player_id: processed?.playerId ?? null,
    p_processed_platform: processed?.platform ?? null,
    p_processed_data: processed?.data ?? null,
    p_processed_updated_at: processed?.updatedAt ?? null,
  });
  if (error) {
    throw new TelemetryRegistryError("finalize", { code: error.code, status });
  }
}
