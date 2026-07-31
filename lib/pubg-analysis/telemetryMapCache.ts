import "server-only";
import { randomUUID } from "node:crypto";
import {
  buildTelemetryCacheKey,
  buildTelemetryPublicIdentity,
} from "./telemetryCacheKey.server";
import {
  parseTelemetryPayload,
  type TelemetryPayload,
} from "./telemetryPayload";
import type { TelemetryIdentity } from "./telemetryIdentity";
import { TelemetryRegistryError } from "./telemetryRegistry.server";

export type TelemetryMapCacheDependencies = {
  isConfigured: () => boolean;
  download: (key: string) => Promise<string | null>;
  upload: (key: string, body: string, contentType: string) => Promise<void>;
  sign: (key: string, expiresInSeconds: number) => Promise<string>;
  claim: (row: TelemetryMapCacheRegistryRow) => Promise<boolean>;
  release: (row: TelemetryMapCacheRegistryRow) => Promise<void>;
  finalize: (row: TelemetryMapCacheRegistryRow) => Promise<void>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
};

export type TelemetryMapCacheRegistryRow = {
  match_id: string;
  platform: string;
  player_id: string;
  mode: string;
  telemetry_version: number;
  storage_path: string;
  status: "pending" | "ready";
  lease_expires_at: string | null;
  lease_token: string | null;
  updated_at: string;
};

export type TelemetryMapCacheWriteOptions = {
  reservedRow?: TelemetryMapCacheRegistryRow;
};

export type TelemetryCacheHit = {
  payload: TelemetryPayload;
  downloadUrl: string;
  storagePath: string;
};

const WRITE_LEASE_DURATION_MS = 15 * 60 * 1_000;
const RETRY_DELAYS_MS = [250, 750] as const;
const PENDING_RECHECK_DELAYS_MS = [200, 400, 800] as const;

export class TelemetryMapCacheBusyError extends Error {
  constructor() {
    super("telemetry-map-cache-write-in-progress");
    this.name = "TelemetryMapCacheBusyError";
  }
}

export type TelemetryMapCacheClaimResult =
  | { kind: "hit"; cache: TelemetryCacheHit }
  | { kind: "claimed"; row: TelemetryMapCacheRegistryRow }
  | { kind: "pending" };

function isTransientTelemetryRegistryError(error: unknown): boolean {
  return error instanceof TelemetryRegistryError
    && (
      error.code === "57014"
      || error.code === "55P03"
      || error.code === "40001"
      || (error.status ?? 0) >= 500
    );
}

function withTelemetryRegistryRetryCount(
  error: TelemetryRegistryError,
  retryCount: number,
): TelemetryRegistryError {
  return new TelemetryRegistryError(error.operation, {
    code: error.code,
    status: error.status,
    retryCount,
  });
}

async function retryTelemetryRegistryWrite<T>(
  operation: () => Promise<T>,
  deps: Pick<TelemetryMapCacheDependencies, "sleep" | "random">,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (!isTransientTelemetryRegistryError(error) || delay === undefined) {
        if (error instanceof TelemetryRegistryError) {
          throw withTelemetryRegistryRetryCount(error, attempt);
        }
        throw error;
      }
      const jitter = Math.floor(deps.random() * 151);
      await deps.sleep(delay + jitter);
    }
  }
}

function buildRegistryRow(
  identity: TelemetryIdentity,
  storagePath: string,
  status: TelemetryMapCacheRegistryRow["status"],
  now: Date,
): TelemetryMapCacheRegistryRow {
  return {
    match_id: identity.matchId,
    platform: identity.platform,
    player_id: identity.playerId,
    mode: identity.mode,
    telemetry_version: identity.telemetryVersion,
    storage_path: storagePath,
    status,
    lease_expires_at: status === "pending"
      ? new Date(now.getTime() + WRITE_LEASE_DURATION_MS).toISOString()
      : null,
    lease_token: status === "pending" ? randomUUID() : null,
    updated_at: now.toISOString(),
  };
}

export async function claimTelemetryMapCacheRow(
  identity: TelemetryIdentity,
  deps: Pick<
    TelemetryMapCacheDependencies,
    "isConfigured" | "claim" | "now" | "sleep" | "random"
  >,
): Promise<TelemetryMapCacheRegistryRow | null> {
  if (!deps.isConfigured()) {
    throw new Error("텔레메트리 캐시 저장소가 설정되지 않았습니다.");
  }
  const storagePath = buildTelemetryCacheKey(identity);
  const row = buildRegistryRow(identity, storagePath, "pending", deps.now());
  const claimed = await retryTelemetryRegistryWrite(() => deps.claim(row), deps);
  return claimed ? row : null;
}

export async function claimOrWaitForTelemetryMapCache(
  identity: TelemetryIdentity,
  deps: TelemetryMapCacheDependencies,
): Promise<TelemetryMapCacheClaimResult> {
  const cached = await readTelemetryMapCache(identity, deps);
  if (cached) return { kind: "hit", cache: cached };

  const claimedRow = await claimTelemetryMapCacheRow(identity, deps);
  if (claimedRow) return { kind: "claimed", row: claimedRow };

  for (const delay of PENDING_RECHECK_DELAYS_MS) {
    await deps.sleep(delay);
    const retryCached = await readTelemetryMapCache(identity, deps);
    if (retryCached) return { kind: "hit", cache: retryCached };

    const retryClaimedRow = await claimTelemetryMapCacheRow(identity, deps);
    if (retryClaimedRow) return { kind: "claimed", row: retryClaimedRow };
  }

  return { kind: "pending" };
}

export async function releaseTelemetryMapCacheRow(
  row: TelemetryMapCacheRegistryRow,
  deps: Pick<TelemetryMapCacheDependencies, "release" | "sleep" | "random">,
): Promise<void> {
  await retryTelemetryRegistryWrite(() => deps.release(row), deps);
}

export async function readTelemetryMapCache(
  identity: TelemetryIdentity,
  deps: TelemetryMapCacheDependencies,
): Promise<TelemetryCacheHit | null> {
  const storagePath = buildTelemetryCacheKey(identity);
  const body = await deps.download(storagePath);
  if (!body) return null;

  let payload: TelemetryPayload;
  try {
    payload = parseTelemetryPayload(JSON.parse(body), buildTelemetryPublicIdentity(identity));
  } catch {
    return null;
  }

  const readyRow = buildRegistryRow(identity, storagePath, "ready", deps.now());
  await retryTelemetryRegistryWrite(() => deps.finalize(readyRow), deps);

  return {
    payload,
    downloadUrl: await deps.sign(storagePath, 1800),
    storagePath,
  };
}

export async function writeTelemetryMapCache(
  identity: TelemetryIdentity,
  value: TelemetryPayload,
  deps: TelemetryMapCacheDependencies,
  options: TelemetryMapCacheWriteOptions = {},
): Promise<TelemetryCacheHit> {
  if (!deps.isConfigured()) {
    throw new Error("텔레메트리 캐시 저장소가 설정되지 않았습니다.");
  }

  const payload = parseTelemetryPayload(value, buildTelemetryPublicIdentity(identity));
  const reservedRow = options.reservedRow ?? await claimTelemetryMapCacheRow(identity, deps);
  if (!reservedRow) {
    throw new TelemetryMapCacheBusyError();
  }
  const storagePath = reservedRow.storage_path;
  await deps.upload(storagePath, JSON.stringify(payload), "application/json");
  await retryTelemetryRegistryWrite(
    () => deps.finalize({
      ...reservedRow,
      status: "ready",
      lease_expires_at: null,
    }),
    deps,
  );

  return {
    payload,
    storagePath,
    downloadUrl: await deps.sign(storagePath, 1800),
  };
}
