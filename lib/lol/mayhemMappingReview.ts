import { MAYHEM_EXTERNAL_ID_PATTERN } from "./mayhemDatasetView";
import type { LolMayhemAugment, LolAugmentRarity } from "./augments/catalog";

export type MappingSource = { externalId: string; name: string | null; nameEn: string | null; rarity: LolAugmentRarity | null; conflict: boolean; uses: ("rates" | "combos")[] };
export type MappingPreview = {
  releaseId: number; sources: MappingSource[];
  patches: { patch: string; purpose: string; externalIds: string[]; augments: LolMayhemAugment[] }[];
  mappings: { external_id: string; client_patch: string; platform_id: number; status: string }[];
};
const normalized = (name: string) => name.normalize("NFKC").trim().toLocaleLowerCase("ko");
const invalid = () => new Error("invalid_mapping_preview");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const text = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  return value.trim();
};

export function mappingSources(augmentFile: unknown, comboFile: unknown, unknownIds: string[], releaseId: string): MappingSource[] {
  if (unknownIds.length > 10_000 || new Set(unknownIds).size !== unknownIds.length || unknownIds.some(id => typeof id !== "string" || !MAYHEM_EXTERNAL_ID_PATTERN.test(id))) throw invalid();
  const rows = (file: unknown) => {
    const root = object(file);
    if (root.schemaVersion !== 1 || root.licenseUrl !== "https://creativecommons.org/licenses/by/4.0/" || object(root.meta).releaseId !== releaseId
      || !Array.isArray(root.rows) || root.rows.length > 10_000) throw invalid();
    return root.rows;
  };
  const sources = new Map(unknownIds.map(externalId => [externalId, { externalId, name: null, nameEn: null, rarity: null, conflict: false, uses: [] } as MappingSource]));
  const merge = (id: unknown, names: unknown, use: "rates" | "combos", rarity?: unknown) => {
    if (typeof id !== "string" || !MAYHEM_EXTERNAL_ID_PATTERN.test(id)) throw invalid();
    const source = sources.get(id);
    if (!source) return;
    if (!source.uses.includes(use)) source.uses.push(use);
    const labels = names === undefined ? {} : object(names);
    for (const [field, locale] of [["name", "ko-KR"], ["nameEn", "en"]] as const) {
      const value = text(labels[locale]);
      if (source[field] && value && normalized(source[field]) !== normalized(value)) source.conflict = true;
      source[field] ??= value;
    }
    if (rarity !== undefined && !["silver", "gold", "prismatic"].includes(String(rarity))) throw invalid();
    if (source.rarity && rarity && source.rarity !== rarity) source.conflict = true;
    if (rarity !== undefined) source.rarity ??= rarity as LolAugmentRarity;
  };
  for (const value of rows(augmentFile)) { const row = object(value); merge(row.augmentId, row.name, "rates", row.rarity); }
  for (const value of rows(comboFile)) {
    const row = object(value);
    if (!Array.isArray(row.augmentIds) || row.augmentIds.length > 64 || (row.augmentNames !== undefined && (!Array.isArray(row.augmentNames) || row.augmentNames.length !== row.augmentIds.length))) throw invalid();
    row.augmentIds.forEach((id, index) => merge(id, (row.augmentNames as unknown[] | undefined)?.[index], "combos"));
  }
  return [...sources.values()].sort((a, b) => (a.name ?? a.nameEn ?? a.externalId).localeCompare(b.name ?? b.nameEn ?? b.externalId, "ko"));
}

export function suggestedMapping(source: MappingSource, augments: LolMayhemAugment[]): LolMayhemAugment | null {
  if (source.conflict) return null;
  const names = [source.name, source.nameEn].filter((name): name is string => !!name).map(normalized);
  const matches = augments.filter(row => [row.name, row.nameEn].some(name => name && names.includes(normalized(name))));
  if (matches.length !== 1 || (source.rarity && matches[0].rarity !== source.rarity)) return null;
  return matches[0];
}
