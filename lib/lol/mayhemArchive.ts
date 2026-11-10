import type { LolAugmentRarity } from "./augments/catalog";
export const MAYHEM_AVAILABILITY = ["active", "disabled", "removed", "unverified"] as const;
export type MayhemAvailability = typeof MAYHEM_AVAILABILITY[number];
export const MAYHEM_AVAILABILITY_LABELS = { active: "사용 중", disabled: "비활성", removed: "삭제", unverified: "확인 중" } as const;
export type ArchiveAugment = { key: string; officialId: number | null; externalIds: string[]; name: string; nameEn: string | null; sourceName: string | null; rarity: LolAugmentRarity | null; status: MayhemAvailability; removedPatch: string | null; reason: string; text: string; sourceUrl: string | null };
export type ArchiveCombo = { id: number; championId: number; augments: string[]; status: MayhemAvailability; types: string[]; sourceUrl: string };
export type MayhemArchive = { schemaVersion: 1; patch: string; augments: ArchiveAugment[]; combos: ArchiveCombo[] };
export type AvailabilityCounts = Record<MayhemAvailability, number>;
export type ArchiveSummary = { augments: AvailabilityCounts; combos: AvailabilityCounts; sourceRates: number; sourceCombos: number };
export type ArchiveComboRow = Omit<ArchiveCombo, "augments"> & { augments: Pick<ArchiveAugment, "key" | "officialId" | "name" | "nameEn" | "status">[] };
export type MayhemArchivePage = { patch: string; publishedAt: string; counts: AvailabilityCounts; total: number; offset: number; pageSize: number } & ({ kind: "augments"; rows: ArchiveAugment[] } | { kind: "combos"; rows: ArchiveComboRow[]; typeCounts: Record<string, number> });
export const availabilityCounts = (rows: { status: MayhemAvailability }[]): AvailabilityCounts => Object.fromEntries(MAYHEM_AVAILABILITY.map(status => [status, rows.filter(row => row.status === status).length])) as AvailabilityCounts;
export const comboAvailability = (statuses: MayhemAvailability[]): MayhemAvailability => (["removed", "disabled", "unverified"] as const).find(status => statuses.includes(status)) ?? "active";
export const isMayhemAvailability = (value: unknown): value is MayhemAvailability => typeof value === "string" && MAYHEM_AVAILABILITY.includes(value as MayhemAvailability);
const record = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid_mayhem_archive"); return v as Record<string, unknown>; };
const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const validId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const sourceUrl = (v: unknown) => { if (!text(v, 2048)) return false; try { const u = new URL(v as string); return u.origin === "https://arammayhem.com" && !u.username && !u.password && !u.hash; } catch { return false; } };

export function parseMayhemArchive(value: unknown, patch: string): MayhemArchive {
  const root = record(value);
  if (root.schemaVersion !== 1 || root.patch !== patch || !Array.isArray(root.augments) || root.augments.length > 2000 || !Array.isArray(root.combos) || root.combos.length > 5000) throw new Error("invalid_mayhem_archive");
  const keys = new Set<string>(), ids = new Set<number>();
  for (const item of root.augments) {
    const a = record(item);
    if (typeof a.key !== "string" || !/^(official:[1-9][0-9]*|external:[a-z0-9][a-z0-9_!-]{0,127})$/i.test(a.key) || keys.has(a.key)
      || !(a.officialId === null || (validId(a.officialId) && a.key === `official:${a.officialId}`)) || (a.officialId === null && !a.key.startsWith("external:"))
      || !Array.isArray(a.externalIds) || a.externalIds.length > 64 || a.externalIds.some(id => typeof id !== "string" || !/^[a-z0-9][a-z0-9_!-]{0,127}$/i.test(id)) || new Set(a.externalIds).size !== a.externalIds.length
      || !text(a.name, 256) || !(a.name as string).trim() || !(a.nameEn === null || text(a.nameEn, 256)) || !(a.sourceName === null || text(a.sourceName, 256))
      || !(a.rarity === null || ["silver", "gold", "prismatic"].includes(String(a.rarity))) || !isMayhemAvailability(a.status)
      || !(a.removedPatch === null || (typeof a.removedPatch === "string" && /^(25|26)\.[1-9][0-9]?$/.test(a.removedPatch)))
      || !text(a.reason, 2048) || !text(a.text, 32768) || !(a.sourceUrl === null || sourceUrl(a.sourceUrl))) throw new Error("invalid_mayhem_archive");
    if (a.status === "active" && a.officialId === null) throw new Error("invalid_mayhem_archive");
    keys.add(a.key);
  }
  const statuses = new Map((root.augments as ArchiveAugment[]).map(a => [a.key, a.status]));
  for (const item of root.combos) {
    const c = record(item);
    if (!validId(c.id) || ids.has(c.id) || !validId(c.championId) || c.championId > 100000 || !Array.isArray(c.augments) || !c.augments.length || c.augments.length > 64
      || new Set(c.augments).size !== c.augments.length || c.augments.some(key => typeof key !== "string" || !keys.has(key))
      || !Array.isArray(c.types) || c.types.length > 16 || c.types.some(t => typeof t !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(t))
      || !isMayhemAvailability(c.status) || c.status !== comboAvailability(c.augments.map(key => statuses.get(key as string)!)) || !sourceUrl(c.sourceUrl)) throw new Error("invalid_mayhem_archive");
    ids.add(c.id);
  }
  return root as unknown as MayhemArchive;
}

export function archivePage(archive: MayhemArchive, options: { kind: "augments" | "combos"; status: MayhemAvailability | "all"; query: string; championId: number | null; offset: number; type?: string | null }, publishedAt: string): MayhemArchivePage {
  const names = new Map(archive.augments.map(a => [a.key, a]));
  const q = options.query.normalize("NFKC").trim().toLocaleLowerCase("ko");
  const matches = (a: ArchiveAugment) => [a.name, a.nameEn, a.sourceName, a.text].some(t => t?.normalize("NFKC").toLocaleLowerCase("ko").includes(q));
  const pageSize = 50;
  const base = { patch: archive.patch, publishedAt, offset: options.offset, pageSize };
  if (options.kind === "augments") {
    const all = archive.augments.filter(a => !q || matches(a));
    const filtered = all.filter(a => options.status === "all" || a.status === options.status);
    return { ...base, kind: "augments", counts: availabilityCounts(all), total: filtered.length, rows: filtered.slice(options.offset, options.offset + pageSize) };
  }
  const all = archive.combos.filter(c => (!options.championId || c.championId === options.championId) && (!q || c.augments.some(key => matches(names.get(key)!))));
  const inStatus = all.filter(c => options.status === "all" || c.status === options.status);
  const typeCounts: Record<string, number> = {};
  for (const c of inStatus) for (const t of c.types) typeCounts[t] = (typeCounts[t] ?? 0) + 1;
  const filtered = options.type ? inStatus.filter(c => c.types.includes(options.type!)) : inStatus;
  return { ...base, kind: "combos", counts: availabilityCounts(all), typeCounts, total: filtered.length,
    rows: filtered.slice(options.offset, options.offset + pageSize).map(c => ({ ...c, augments: c.augments.map(key => { const { officialId, name, nameEn, status } = names.get(key)!; return { key, officialId, name, nameEn, status }; }) })) };
}
