import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelemetryMapCacheRegistryRow } from "./telemetryMapCache";

export class TelemetryRegistryError extends Error {
  readonly operation: "claim" | "release" | "finalize";
  readonly code: string | null;
  readonly status: number | null;
  readonly retryCount: number;

  constructor(
    operation: "claim" | "release" | "finalize",
    error: {
      code?: string | null;
      status?: number | null;
      retryCount?: number;
    },
  ) {
    super(`telemetry-cache-${operation}-failed`);
    this.name = "TelemetryRegistryError";
    this.operation = operation;
    this.code = error.code ?? null;
    this.status = error.status ?? null;
    this.retryCount = error.retryCount ?? 0;
  }
}

export async function claimTelemetryMapCacheReservation(
  supabase: SupabaseClient,
  row: TelemetryMapCacheRegistryRow,
): Promise<boolean> {
  const { data, error, status } = await supabase.rpc("claim_telemetry_cache_write", {
    p_match_id: row.match_id,
    p_platform: row.platform,
    p_player_id: row.player_id,
    p_mode: row.mode,
    p_telemetry_version: row.telemetry_version,
    p_storage_path: row.storage_path,
    p_lease_expires_at: row.lease_expires_at,
    p_lease_token: row.lease_token,
    p_updated_at: row.updated_at,
  });
  if (error) {
    throw new TelemetryRegistryError("claim", { code: error.code, status });
  }
  return data === true;
}

export async function releaseTelemetryMapCacheReservation(
  supabase: SupabaseClient,
  row: TelemetryMapCacheRegistryRow,
): Promise<void> {
  const { error, status } = await supabase.rpc("release_telemetry_cache_write", {
    p_match_id: row.match_id,
    p_platform: row.platform,
    p_player_id: row.player_id,
    p_mode: row.mode,
    p_telemetry_version: row.telemetry_version,
    p_lease_token: row.lease_token,
  });
  if (error) {
    throw new TelemetryRegistryError("release", { code: error.code, status });
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
    p_cache_lease_token: input.row.lease_token,
    p_processed_player_id: processed?.playerId ?? null,
    p_processed_platform: processed?.platform ?? null,
    p_processed_data: processed?.data ?? null,
    p_processed_updated_at: processed?.updatedAt ?? null,
  });
  if (error) {
    throw new TelemetryRegistryError("finalize", { code: error.code, status });
  }
}
