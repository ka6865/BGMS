export const MAX_RETENTION_BATCH_OBJECTS = 50;
export const MAX_RETENTION_BATCH_BYTES = 32 * 1024 * 1024;
export const RETENTION_SCAN_LIMIT = 1000;
export const RETENTION_SCAN_TIME_MS = 120_000;

export function selectRetentionBatchObjects<T extends { sizeBytes: number }>(
  objects: T[],
  options: { maxObjects?: number; maxBytes?: number } = {},
): T[] {
  const maxObjects = options.maxObjects ?? MAX_RETENTION_BATCH_OBJECTS;
  const maxBytes = options.maxBytes ?? MAX_RETENTION_BATCH_BYTES;
  if (!Number.isSafeInteger(maxObjects) || maxObjects <= 0 || maxObjects > MAX_RETENTION_BATCH_OBJECTS
    || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_RETENTION_BATCH_BYTES) {
    throw new Error("retention-batch-options-invalid");
  }

  const selected: T[] = [];
  let selectedBytes = 0;
  for (const object of objects) {
    if (!Number.isSafeInteger(object.sizeBytes) || object.sizeBytes <= 0) {
      throw new Error("retention-batch-object-size-invalid");
    }
    if (selected.length >= maxObjects) break;
    if (object.sizeBytes > maxBytes - selectedBytes) continue;
    selected.push(object);
    selectedBytes += object.sizeBytes;
  }
  return selected;
}
