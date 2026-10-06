import { describe, expect, it } from "vitest";
import {
  MAX_RETENTION_BATCH_BYTES,
  MAX_RETENTION_BATCH_OBJECTS,
  RETENTION_SCAN_LIMIT,
  RETENTION_SCAN_TIME_MS,
  selectRetentionBatchObjects,
} from "../lib/pubg-analysis/matchRetentionBatch";

describe("match retention batch selection", () => {
  it("keeps input order and fills remaining capacity with later smaller objects", () => {
    const objects = [
      { key: "first", sizeBytes: 20 },
      { key: "too-large-for-remainder", sizeBytes: 15 },
      { key: "second", sizeBytes: 10 },
      { key: "third", sizeBytes: 2 },
    ];

    expect(selectRetentionBatchObjects(objects, { maxObjects: 3, maxBytes: 32 }))
      .toEqual([objects[0], objects[2], objects[3]]);
  });

  it("uses the bounded defaults and exposes the scheduled scan bounds", () => {
    const objects = Array.from({ length: MAX_RETENTION_BATCH_OBJECTS + 1 }, (_, index) => ({
      key: String(index), sizeBytes: 1,
    }));
    expect(selectRetentionBatchObjects(objects)).toHaveLength(MAX_RETENTION_BATCH_OBJECTS);
    expect(MAX_RETENTION_BATCH_BYTES).toBe(32 * 1024 * 1024);
    expect(RETENTION_SCAN_LIMIT).toBe(1000);
    expect(RETENTION_SCAN_TIME_MS).toBe(120_000);
  });

  it.each([
    { maxObjects: 0 },
    { maxObjects: MAX_RETENTION_BATCH_OBJECTS + 1 },
    { maxObjects: Number.MAX_SAFE_INTEGER + 1 },
    { maxBytes: 0 },
    { maxBytes: MAX_RETENTION_BATCH_BYTES + 1 },
    { maxBytes: -1 },
  ])("rejects invalid or over-cap options: %o", (options) => {
    expect(() => selectRetentionBatchObjects([], options)).toThrow("retention-batch-options-invalid");
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, 1.5])("rejects invalid object size %s", (sizeBytes) => {
    expect(() => selectRetentionBatchObjects([{ sizeBytes }])).toThrow("retention-batch-object-size-invalid");
  });

  it("skips a single object above the batch byte cap", () => {
    const oversized = { key: "oversized", sizeBytes: MAX_RETENTION_BATCH_BYTES + 1 };
    const small = { key: "small", sizeBytes: 1 };
    expect(selectRetentionBatchObjects([oversized, small])).toEqual([small]);
  });
});
