import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelemetryMapCacheRegistryRow } from "./telemetryMapCache";

const TELEMETRY_REGISTRY_TIMEOUT_MS = 5_000;

async function executeRegistryQuery<T>(query: any): Promise<T> {
  const withoutRetry = typeof query?.retry === "function" ? query.retry(false) : query;
  const request = typeof withoutRetry?.abortSignal === "function"
    ? withoutRetry.abortSignal(AbortSignal.timeout(TELEMETRY_REGISTRY_TIMEOUT_MS))
    : withoutRetry;
  return await request as T;
}

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
  const { data, error, status } = await executeRegistryQuery<any>(supabase.rpc("claim_telemetry_cache_write", {
    p_match_id: row.match_id,
    p_platform: row.platform,
    p_player_id: row.player_id,
    p_mode: row.mode,
    p_telemetry_version: row.telemetry_version,
    p_storage_path: row.storage_path,
    p_lease_expires_at: row.lease_expires_at,
    p_lease_token: row.lease_token,
    p_updated_at: row.updated_at,
  }));
  if (error) {
    throw new TelemetryRegistryError("claim", { code: error.code, status });
  }
  return data === true;
}

/**
 * Recovery-only claim.  Unlike the ordinary cache claim, this path never
 * reclaims or replaces an existing v61 registry row: the database unique key
 * and `ON CONFLICT DO NOTHING` make the refusal atomic with respect to a
 * concurrent ready/pending writer.  A false result is therefore an
 * ambiguity that the caller must reconcile, not a retryable stale lease.
 */
export async function claimTelemetryMapCacheRecoveryReservation(
  supabase: SupabaseClient,
  row: TelemetryMapCacheRegistryRow,
): Promise<boolean> {
  const { data, error, status } = await executeRegistryQuery<any>(supabase.rpc("claim_telemetry_cache_recovery_write", {
    p_match_id: row.match_id,
    p_platform: row.platform,
    p_player_id: row.player_id,
    p_mode: row.mode,
    p_telemetry_version: row.telemetry_version,
    p_storage_path: row.storage_path,
    p_lease_expires_at: row.lease_expires_at,
    p_lease_token: row.lease_token,
    p_updated_at: row.updated_at,
  }));
  if (error) {
    throw new TelemetryRegistryError("claim", { code: error.code, status });
  }
  return data === true;
}

export async function releaseTelemetryMapCacheReservation(
  supabase: SupabaseClient,
  row: TelemetryMapCacheRegistryRow,
): Promise<void> {
  const { error, status } = await executeRegistryQuery<any>(supabase.rpc("release_telemetry_cache_write", {
    p_match_id: row.match_id,
    p_platform: row.platform,
    p_player_id: row.player_id,
    p_mode: row.mode,
    p_telemetry_version: row.telemetry_version,
    p_lease_token: row.lease_token,
  }));
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
  const { error, status } = await executeRegistryQuery<any>(supabase.rpc("finalize_telemetry_cache_write", {
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
  }));
  if (error) {
    throw new TelemetryRegistryError("finalize", { code: error.code, status });
  }
}

export type RecoveryProcessedGuard = {
  matchId: string;
  playerId: string;
  platform: string;
  resultVersion: number;
  accountId: string;
};

/**
 * Keep the RPC boundary type-only and independent from the persistence module.
 * The route still obtains this guard from the shared benchmark-row flow; this
 * duplicate structural shape avoids making the registry helper a persistence
 * consumer (and therefore preserves the one-way route dependency boundary).
 */
export type RecoveryBenchmarkGuard = {
  id?: number | string;
  matchId: string;
  playerId: string;
  platform: string;
  gameMode: string;
  matchType: "official" | "competitive";
  tier: string;
  filterVersion: number | null;
  populationEvidenceVersion: number | null;
};

export type RecoveryFinalizeRows = {
  master: {
    match_id: string;
    map_name: string;
    game_mode: string;
    telemetry_version: number;
    storage_path: string;
  };
  processed: {
    match_id: string;
    platform: string;
    player_id: string;
    data: unknown;
    updated_at: string;
  };
  benchmark: Record<string, unknown>;
};

export type RecoveryFinalizeInput = {
  lease: TelemetryMapCacheRegistryRow;
  processedGuard: RecoveryProcessedGuard;
  benchmarkGuard: RecoveryBenchmarkGuard;
  rows: RecoveryFinalizeRows;
};

export type RecoveryFinalizeResult = {
  ok: boolean;
  code: string;
  message?: string;
};

/**
 * Finalize a strict recovery as one database transaction. The SQL function
 * owns all compare-and-swap checks; this wrapper deliberately treats a
 * structured `{ ok: false }` response as a normal stale-worker result so the
 * caller can compensate only an object uploaded by this request.
 */
export async function finalizeRecoveryAtomically(
  supabase: SupabaseClient,
  input: RecoveryFinalizeInput,
): Promise<RecoveryFinalizeResult> {
  const rpcArgs = {
    p_match_id: input.lease.match_id,
    p_platform: input.lease.platform,
    p_player_id: input.lease.player_id,
    p_mode: input.lease.mode,
    p_telemetry_version: input.lease.telemetry_version,
    p_storage_path: input.lease.storage_path,
    p_lease_token: input.lease.lease_token,
    p_processed_guard: input.processedGuard,
    p_benchmark_guard: input.benchmarkGuard,
    p_rows: input.rows,
  };

  const call = async (): Promise<RecoveryFinalizeResult> => {
    const { data, error, status } = await executeRegistryQuery<any>(
      supabase.rpc("finalize_telemetry_cache_recovery", rpcArgs),
    );
    if (error) {
      throw new TelemetryRegistryError("finalize", { code: error.code, status });
    }

    const payload = Array.isArray(data) && data.length === 1 ? data[0] : data;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TelemetryRegistryError("finalize", { code: "RECOVERY_FINALIZE_INVALID_RESPONSE", status });
    }
    const code = typeof payload.code === "string" && payload.code.trim()
      ? payload.code
      : payload.ok === true ? "finalized" : "recovery_finalize_failed";
    return {
      ok: payload.ok === true,
      code,
      ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    };
  };

  try {
    return await call();
  } catch (error) {
    // PostgreSQL validation/constraint errors are known to have rolled back
    // the transaction and may be compensated by the route.  A transport or
    // malformed-response failure is ambiguous: retry the idempotent RPC once
    // so a committed transaction can report `already_finalized` instead of
    // causing unsafe R2 deletion.
    const code = error instanceof TelemetryRegistryError ? error.code : null;
    const knownRollback = Boolean(code && (/^(?:22|23|40)/.test(code) || code === "PGRST116"));
    if (knownRollback) throw error;
    try {
      const reconciled = await call();
      // A second structured response that still reports a guard/lease
      // rejection does not prove whether the first request committed before
      // its response was lost.  Keep the result ambiguous so the recovery
      // route cannot delete a possibly committed object.
      if (!reconciled.ok) {
        throw new TelemetryRegistryError("finalize", {
          code: "RECOVERY_FINALIZE_RECONCILIATION_FAILED",
          retryCount: 1,
        });
      }
      return reconciled;
    } catch {
      throw new TelemetryRegistryError("finalize", {
        code: "RECOVERY_FINALIZE_RECONCILIATION_FAILED",
        status: error instanceof TelemetryRegistryError ? error.status : null,
        retryCount: 1,
      });
    }
  }
}
