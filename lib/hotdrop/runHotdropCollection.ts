const PUBG_BASE = "https://api.pubg.com/shards/steam";
const GRID_DIVISIONS = 256;

class PubgHttpError extends Error {
  constructor(readonly status: number) {
    super(`PUBG API error ${status}`);
  }
}

function isPubgAccessBlocked(error: unknown): boolean {
  return error instanceof PubgHttpError && [401, 403, 429].includes(error.status);
}

const MAP_SLUG: Record<string, string> = {
  Baltic_Main: "erangel",
  Erangel_Main: "erangel",
  Desert_Main: "miramar",
  Tiger_Main: "taego",
  Neon_Main: "rondo",
  Savage_Main: "sanhok",
  Summer_Main: "sanhok",
  DihorOtok_Main: "vikendi",
  Kiki_Main: "deston",
};

const MAP_SIZES: Record<string, number> = {
  erangel: 819200,
  miramar: 819200,
  taego: 819200,
  deston: 819200,
  rondo: 819200,
  vikendi: 819200,
  sanhok: 409600,
  paramo: 307200,
  karakin: 204800,
  haven: 102400,
};

export interface HotdropJobConfig {
  maxRankers: number;
  matchesPerPlayer: number;
  sampleMatchLimit: number;
  maxMatchesPerRun: number;
  rateLimitMs: number;
  maxTelemetryCompressedBytes: number;
  maxTelemetryDecompressedBytes: number;
}

export interface HotdropSupabaseAdapter {
  rpc(name: string, params: Record<string, unknown>): PromiseLike<{ error: unknown }>;
  from(table: string): {
    delete(): { neq(column: string, value: string): PromiseLike<{ error: unknown }> };
    upsert(
      row: Record<string, unknown>,
      options: { onConflict: string },
    ): PromiseLike<{ error: unknown }>;
  };
}

export interface HotdropDependencies {
  fetchFn: typeof fetch;
  supabase: HotdropSupabaseAdapter;
  sleep(milliseconds: number): Promise<void>;
  now(): string;
}

export interface HotdropJobResult {
  season: string;
  source: "leaderboard" | "samples";
  totalLandings: number;
  processedMatches: number;
  skippedMatches: number;
}

const CONFIG_RULES = {
  HOTDROP_MAX_RANKERS: { fallback: 1, min: 1, max: 20 },
  HOTDROP_MATCHES_PER_PLAYER: { fallback: 2, min: 1, max: 10 },
  HOTDROP_SAMPLE_MATCH_LIMIT: { fallback: 3, min: 1, max: 20 },
  HOTDROP_MAX_MATCHES_PER_RUN: { fallback: 3, min: 1, max: 20 },
  HOTDROP_RATE_LIMIT_MS: { fallback: 6500, min: 6500, max: 60000 },
  HOTDROP_MAX_TELEMETRY_COMPRESSED_BYTES: {
    fallback: 50 * 1024 * 1024,
    min: 1024 * 1024,
    max: 100 * 1024 * 1024,
  },
  HOTDROP_MAX_TELEMETRY_DECOMPRESSED_BYTES: {
    fallback: 100 * 1024 * 1024,
    min: 1024 * 1024,
    max: 200 * 1024 * 1024,
  },
} as const;

function parseBoundedInteger(
  env: Record<string, string | undefined>,
  key: keyof typeof CONFIG_RULES,
): number {
  const rule = CONFIG_RULES[key];
  const raw = env[key];
  const value = raw === undefined || raw.trim() === "" ? rule.fallback : Number(raw);
  if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
    throw new Error(`${key}는 ${rule.min}~${rule.max} 범위의 정수여야 합니다.`);
  }
  return value;
}

export function parseHotdropConfig(
  env: Record<string, string | undefined>,
): HotdropJobConfig {
  return {
    maxRankers: parseBoundedInteger(env, "HOTDROP_MAX_RANKERS"),
    matchesPerPlayer: parseBoundedInteger(env, "HOTDROP_MATCHES_PER_PLAYER"),
    sampleMatchLimit: parseBoundedInteger(env, "HOTDROP_SAMPLE_MATCH_LIMIT"),
    maxMatchesPerRun: parseBoundedInteger(env, "HOTDROP_MAX_MATCHES_PER_RUN"),
    rateLimitMs: parseBoundedInteger(env, "HOTDROP_RATE_LIMIT_MS"),
    maxTelemetryCompressedBytes: parseBoundedInteger(
      env,
      "HOTDROP_MAX_TELEMETRY_COMPRESSED_BYTES",
    ),
    maxTelemetryDecompressedBytes: parseBoundedInteger(
      env,
      "HOTDROP_MAX_TELEMETRY_DECOMPRESSED_BYTES",
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireCurrentSeason(data: unknown): string {
  const rows = isRecord(data) && Array.isArray(data.data) ? data.data : [];
  const current = rows.find((row) => (
    isRecord(row)
      && typeof row.id === "string"
      && isRecord(row.attributes)
      && row.attributes.isCurrentSeason === true
  ));
  if (!current || typeof current.id !== "string" || current.id.trim() === "") {
    throw new Error("현재 PUBG 시즌을 확인할 수 없습니다.");
  }
  return current.id;
}

function relationshipIds(data: unknown, relationship: "players" | "matches"): string[] {
  if (!isRecord(data) || !isRecord(data.data) || !isRecord(data.data.relationships)) {
    return [];
  }
  const relation = data.data.relationships[relationship];
  if (!isRecord(relation) || !Array.isArray(relation.data)) return [];
  return relation.data.flatMap((row) => (
    isRecord(row) && typeof row.id === "string" && row.id.trim() !== "" ? [row.id] : []
  ));
}

async function pubgFetch(
  url: string,
  apiKey: string,
  dependencies: HotdropDependencies,
  rateLimitMs: number,
): Promise<unknown> {
  await dependencies.sleep(rateLimitMs);
  const response = await dependencies.fetchFn(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/vnd.api+json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new PubgHttpError(response.status);
  return response.json() as Promise<unknown>;
}

async function cleanupOldSeasons(
  season: string,
  supabase: HotdropSupabaseAdapter,
): Promise<void> {
  const { error } = await supabase
    .from("hotdrop_heatmap")
    .delete()
    .neq("season", season);
  if (error) throw new Error("hotdrop-season-cleanup-failed");
}

function matchMeta(data: unknown): { telemetryUrl: string; mapSlug: string } | null {
  if (!isRecord(data) || !isRecord(data.data) || !isRecord(data.data.attributes)) {
    return null;
  }
  const mapName = data.data.attributes.mapName;
  if (typeof mapName !== "string") return null;
  const mapSlug = MAP_SLUG[mapName];
  if (!mapSlug || !Array.isArray(data.included)) return null;
  const asset = data.included.find((row) => isRecord(row) && row.type === "asset");
  if (!isRecord(asset) || !isRecord(asset.attributes)) return null;
  const telemetryUrl = asset.attributes.URL;
  return typeof telemetryUrl === "string" && telemetryUrl.trim() !== ""
    ? { telemetryUrl, mapSlug }
    : null;
}

async function readTelemetryEvents(
  response: Response,
  config: HotdropJobConfig,
): Promise<unknown[]> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength)
    && declaredLength > config.maxTelemetryCompressedBytes) {
    throw new Error("telemetry-compressed-limit");
  }

  const chunks: Uint8Array[] = [];
  let compressedBytes = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        compressedBytes += value.byteLength;
        if (compressedBytes > config.maxTelemetryCompressedBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error("telemetry-compressed-limit");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = Buffer.concat(chunks, compressedBytes);
  const output = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? (await import("node:zlib")).gunzipSync(bytes, {
        maxOutputLength: config.maxTelemetryDecompressedBytes,
      })
    : bytes;
  if (output.byteLength > config.maxTelemetryDecompressedBytes) {
    throw new Error("telemetry-decompressed-limit");
  }
  const parsed: unknown = JSON.parse(output.toString("utf8"));
  if (!Array.isArray(parsed)) throw new Error("telemetry-invalid-root");
  return parsed;
}

function extractLandings(events: unknown[], mapSlug: string): Array<{ px: number; py: number }> {
  const mapSize = MAP_SIZES[mapSlug] ?? 816000;
  return events.flatMap((event) => {
    if (!isRecord(event)) return [];
    const type = event._T ?? event.Type;
    if (type !== "LogParachuteLanding" || !isRecord(event.character)) return [];
    const location = event.character.location;
    if (!isRecord(location)) return [];
    const x = typeof location.x === "number" ? location.x : 0;
    const y = typeof location.y === "number" ? location.y : 0;
    return [{
      px: (x / mapSize) * 8192,
      py: 8192 - (y / mapSize) * 8192,
    }];
  });
}

function buildHeatmapRows(
  mapSlug: string,
  season: string,
  landings: Array<{ px: number; py: number }>,
  updatedAt: string,
): Array<Record<string, unknown>> {
  const cellSize = 8192 / GRID_DIVISIONS;
  const cells = new Map<string, { gx: number; gy: number; count: number }>();
  for (const { px, py } of landings) {
    const gx = Math.min(Math.floor(px / cellSize), GRID_DIVISIONS - 1);
    const gy = Math.min(Math.floor(py / cellSize), GRID_DIVISIONS - 1);
    const key = `${gx}:${gy}`;
    const cell = cells.get(key);
    if (cell) cell.count += 1;
    else cells.set(key, { gx, gy, count: 1 });
  }
  return Array.from(cells.values(), ({ gx, gy, count }) => ({
    map_name: mapSlug,
    season,
    grid_x: gx,
    grid_y: gy,
    px: (gx + 0.5) * cellSize,
    py: (gy + 0.5) * cellSize,
    count,
    updated_at: updatedAt,
  }));
}

async function upsertHeatmap(
  rows: Array<Record<string, unknown>>,
  supabase: HotdropSupabaseAdapter,
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase.rpc("upsert_hotdrop_counts", {
    rows: JSON.stringify(rows),
  });
  if (!error) return;
  for (const row of rows) {
    const fallback = await supabase.from("hotdrop_heatmap").upsert(row, {
      onConflict: "map_name,season,grid_x,grid_y",
    });
    if (fallback.error) throw new Error("hotdrop-fallback-upsert-failed");
  }
}

async function collectMatchIds(
  apiKey: string,
  season: string,
  config: HotdropJobConfig,
  dependencies: HotdropDependencies,
): Promise<{ ids: string[]; source: "leaderboard" | "samples" }> {
  let rankerIds: string[] = [];
  try {
    const leaderboard = await pubgFetch(
      `${PUBG_BASE}/leaderboards/${season}/squad-fpp?page[number]=1&page[size]=20`,
      apiKey,
      dependencies,
      config.rateLimitMs,
    );
    rankerIds = relationshipIds(leaderboard, "players").slice(0, config.maxRankers);
  } catch (error) {
    if (isPubgAccessBlocked(error)) throw error;
    rankerIds = [];
  }

  if (rankerIds.length > 0) {
    const ids = new Set<string>();
    for (const accountId of rankerIds) {
      try {
        const player = await pubgFetch(
          `${PUBG_BASE}/players/${accountId}`,
          apiKey,
          dependencies,
          config.rateLimitMs,
        );
        for (const id of relationshipIds(player, "matches").slice(0, config.matchesPerPlayer)) {
          ids.add(id);
        }
      } catch (error) {
        if (isPubgAccessBlocked(error)) throw error;
        continue;
      }
    }
    if (ids.size > 0) {
      return { ids: Array.from(ids), source: "leaderboard" };
    }
  }

  const samples = await pubgFetch(
    `${PUBG_BASE}/samples`,
    apiKey,
    dependencies,
    config.rateLimitMs,
  );
  return {
    ids: relationshipIds(samples, "matches").slice(0, config.sampleMatchLimit),
    source: "samples",
  };
}

export async function runHotdropCollection(
  apiKey: string,
  config: HotdropJobConfig,
  dependencies: HotdropDependencies,
): Promise<HotdropJobResult> {
  const seasons = await pubgFetch(
    `${PUBG_BASE}/seasons`,
    apiKey,
    dependencies,
    config.rateLimitMs,
  );
  const season = requireCurrentSeason(seasons);
  await cleanupOldSeasons(season, dependencies.supabase);

  const collection = await collectMatchIds(apiKey, season, config, dependencies);
  const matchIds = collection.ids.slice(0, config.maxMatchesPerRun);
  let totalLandings = 0;
  let skippedMatches = 0;

  for (const matchId of matchIds) {
    let meta: ReturnType<typeof matchMeta>;
    let landings: Array<{ px: number; py: number }>;
    try {
      const rawMeta = await pubgFetch(
        `${PUBG_BASE}/matches/${matchId}`,
        apiKey,
        dependencies,
        config.rateLimitMs,
      );
      meta = matchMeta(rawMeta);
      if (!meta) {
        skippedMatches += 1;
        continue;
      }
      const telemetry = await dependencies.fetchFn(meta.telemetryUrl, {
        headers: { "Accept-Encoding": "gzip, deflate" },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!telemetry.ok) throw new Error(`telemetry-http-${telemetry.status}`);
      landings = extractLandings(await readTelemetryEvents(telemetry, config), meta.mapSlug);
    } catch (error) {
      if (isPubgAccessBlocked(error)) throw error;
      skippedMatches += 1;
      continue;
    }

    totalLandings += landings.length;
    const rows = buildHeatmapRows(meta.mapSlug, season, landings, dependencies.now());
    await upsertHeatmap(rows, dependencies.supabase);
  }

  return {
    season,
    source: collection.source,
    totalLandings,
    processedMatches: matchIds.length,
    skippedMatches,
  };
}
