import { open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CalculationUpgradeManifest } from "./calculation_upgrade_batch";

export async function saveCalculationUpgradeCheckpointAtomic(path: string, manifest: CalculationUpgradeManifest): Promise<void> {
  const target = resolve(path);
  const temporary = resolve(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export type CalculationUpgradeCheckpointLock = { release: () => Promise<void> };

export async function acquireCalculationUpgradeCheckpointLock(path: string): Promise<CalculationUpgradeCheckpointLock> {
  const lockPath = `${resolve(path)}.lock`;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error: any) {
    if (error?.code === "EEXIST") throw new Error("calculation_upgrade_checkpoint_locked");
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
    throw error;
  }
  return {
    async release() {
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    },
  };
}
