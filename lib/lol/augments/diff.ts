import type { Augment, AugmentPoolEntry } from "./extract";

type Snapshot = AugmentPoolEntry & Partial<Pick<Augment, "ko" | "en" | "enabled" | "rootSpell">>;
export type ChangedField = "name" | "description" | "values" | "rarity" | "enabled";
type Change<T> = { before: T; after: T; fields: ChangedField[] };
type Bucket<T> = { added: T[]; removed: T[]; changed: Change<T>[] };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function diffAugments<T extends Snapshot>(previous: readonly T[], current: readonly T[]): Bucket<T> & { internal: Bucket<T> } {
  const normal: Bucket<T> = { added: [], removed: [], changed: [] };
  const internal: Bucket<T> = { added: [], removed: [], changed: [] };
  const index = (entries: readonly T[]) => {
    const map = new Map(entries.map(entry => [entry.platformId, entry]));
    if (map.size !== entries.length) throw new Error("증강 diff 입력 ID가 중복됩니다.");
    return map;
  };
  const before = index(previous);
  const after = index(current);
  for (const entry of current) {
    const old = before.get(entry.platformId);
    const bucket = entry.isInternal || old?.isInternal ? internal : normal;
    if (!old) { bucket.added.push(entry); continue; }
    const fields: ChangedField[] = [];
    if (old.ko?.name !== entry.ko?.name || old.en?.name !== entry.en?.name) fields.push("name");
    if (old.ko?.description !== entry.ko?.description || old.en?.description !== entry.en?.description
      || old.ko?.tooltip !== entry.ko?.tooltip || old.en?.tooltip !== entry.en?.tooltip) fields.push("description");
    const orderedValues = (augment: T) => augment.rootSpell?.dataValues.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (stable(orderedValues(old)) !== stable(orderedValues(entry))
      || stable(old.rootSpell?.calculations) !== stable(entry.rootSpell?.calculations)) fields.push("values");
    if (old.rarity !== entry.rarity) fields.push("rarity");
    if (old.enabled !== entry.enabled) fields.push("enabled");
    if (fields.length) bucket.changed.push({ before: old, after: entry, fields });
  }
  for (const entry of previous) {
    if (!after.has(entry.platformId)) (entry.isInternal ? internal : normal).removed.push(entry);
  }
  return { ...normal, internal };
}
