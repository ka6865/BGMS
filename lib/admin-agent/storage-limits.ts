export const DEFAULT_SUPABASE_DATABASE_LIMIT_BYTES = 8 * 1024 * 1024 * 1024;
export const R2_FREE_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;

export const PLAYER_CACHE_RETENTION_DAYS = 90;
export const PLAYER_CACHE_KEEP_RECENT = 150_000;
export const ADMIN_COMPACTION_BATCH_LIMIT = 1_000;
export const ADMIN_COMPACTION_MAX_BATCHES = 20;
export const ADMIN_COMPACTION_MAX_ROWS = ADMIN_COMPACTION_BATCH_LIMIT * ADMIN_COMPACTION_MAX_BATCHES;

export function getSupabaseDatabaseLimitBytes(): number {
  const configured = Number(process.env.SUPABASE_DATABASE_LIMIT_BYTES);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_SUPABASE_DATABASE_LIMIT_BYTES;
}
