import "server-only";
import { getCachedLolAugmentCatalog } from "./augments/catalog.server";
import { getPublicChampionStats } from "./mayhemChampionDatasetStore.server";
import { buildObservationHistory, observationPatches, type ObservationSnapshot } from "./mayhemObservationHistory";

export async function getMayhemObservationHistory(patch: string, championId: number) {
  const patches = observationPatches(patch);
  const catalog = await getCachedLolAugmentCatalog(patch);
  if (!catalog) throw new Error("observation_catalog_unavailable");
  const snapshots = await Promise.all(patches.map(async (snapshotPatch): Promise<ObservationSnapshot> => {
    try {
      const dataset = await getPublicChampionStats(snapshotPatch, championId);
      if (!dataset) return { patch: snapshotPatch, dataset: null, augmentIds: [] };
      const official = snapshotPatch === patch ? catalog : await getCachedLolAugmentCatalog(snapshotPatch);
      if (!official) return { patch: snapshotPatch, dataset: null, augmentIds: [] };
      return { patch: snapshotPatch, dataset, augmentIds: official.view.augments.map(augment => augment.id) };
    } catch {
      return { patch: snapshotPatch, dataset: null, augmentIds: [] };
    }
  }));
  return buildObservationHistory(patch, championId, catalog.view.augments.map(augment => augment.id), snapshots);
}
