export const DEFAULT_SUPABASE_DATABASE_LIMIT_BYTES = 8 * 1024 * 1024 * 1024;
export const R2_FREE_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;

export function getSupabaseDatabaseLimitBytes(): number {
  const configured = Number(process.env.SUPABASE_DATABASE_LIMIT_BYTES);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_SUPABASE_DATABASE_LIMIT_BYTES;
}
