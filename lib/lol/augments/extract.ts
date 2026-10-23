import { lookupString, parseStringTable, type StringTable } from "./stringTable";

export type Rarity = "silver" | "gold" | "prismatic";
export type DataValue = { name: string; values: number[] };
export type Calculations = Record<string, unknown>;
export type AugmentPoolEntry = { platformId: number; nameId: string; rarity: Rarity; isInternal: boolean };
export type AugmentText = { name: string | null; description: string | null; tooltip: string | null };
export type Augment = AugmentPoolEntry & {
  ko: AugmentText;
  en: AugmentText;
  icons: { small: string | null; large: string | null };
  enabled: boolean;
  quest: boolean;
  ability: boolean;
  buildTags: number;
  augmentTags: number;
  rarityEvidence: { cherry: Rarity; bin: Rarity | null };
  rootSpell: { path: string; dataValues: DataValue[]; calculations: Calculations; spellSlot?: string };
};

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} 문자열이 없습니다.`);
  return value;
}

const RARITIES = { kSilver: "silver", kGold: "gold", kPrismatic: "prismatic" } as const;

export function extractAugmentPool(augmentLists: unknown, cherryAugments: unknown): AugmentPoolEntry[] {
  if (!Array.isArray(augmentLists) || !Array.isArray(cherryAugments)) throw new Error("증강 목록은 배열이어야 합니다.");
  const lists = augmentLists.map(asRecord).filter(list => list.modeName === "KIWI");
  if (lists.length !== 1 || !Array.isArray(lists[0].augmentList)) throw new Error("KIWI 풀 하나가 필요합니다.");
  const byName = new Map<string, Record<string, unknown>>();
  const allIds = new Set<number>();
  for (const value of cherryAugments) {
    const entry = asRecord(value);
    const name = requiredString(entry.augmentNameId, "augmentNameId").toLowerCase();
    if (!Number.isSafeInteger(entry.id) || Number(entry.id) < 1 || allIds.has(Number(entry.id)) || byName.has(name)) {
      throw new Error("cherry 증강 ID가 잘못되었거나 중복됩니다.");
    }
    allIds.add(Number(entry.id));
    byName.set(name, entry);
  }
  const ids = new Set<number>();
  return lists[0].augmentList.map(path => {
    const name = requiredString(path, "augmentList 경로").split("/").at(-1)!;
    const entry = byName.get(name.toLowerCase());
    if (!entry) throw new Error(`cherry 증강 매핑이 없습니다: ${name}`);
    const rarity = typeof entry.rarity === "string" && Object.hasOwn(RARITIES, entry.rarity)
      ? RARITIES[entry.rarity as keyof typeof RARITIES] : null;
    if (!rarity) throw new Error(`KIWI 증강 등급이 잘못되었습니다: ${name}`);
    const platformId = Number(entry.id);
    if (ids.has(platformId)) throw new Error(`KIWI 증강 ID가 중복됩니다: ${platformId}`);
    ids.add(platformId);
    const nameId = String(entry.augmentNameId);
    return { platformId, nameId, rarity, isInternal: nameId.startsWith("GoH_") };
  }).sort((left, right) => left.platformId - right.platformId);
}

export function normalizeIconPath(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const path = value.toLowerCase().replace(/^\/lol-game-data\/assets\//, "").replace(/\.tex$/, ".png");
  return /^assets\/[a-z0-9_./-]+\.png$/.test(path) && !path.split("/").includes("..") ? path : null;
}

function localizedText(entry: Record<string, unknown>, table: StringTable): AugmentText {
  const find = (field: string) => typeof entry[field] === "string" ? lookupString(table, entry[field]) : null;
  return { name: find("NameTra"), description: find("DescriptionTra"), tooltip: find("AugmentTooltipTra") };
}

export function extractAugments(input: {
  augmentLists: unknown;
  cherryAugments: unknown;
  kiwiBin: unknown;
  stringTableKo: unknown;
  stringTableEn: unknown;
}): Augment[] {
  const pool = extractAugmentPool(input.augmentLists, input.cherryAugments);
  const ko = parseStringTable(input.stringTableKo);
  const en = parseStringTable(input.stringTableEn);
  const bin = asRecord(input.kiwiBin);
  const byId = new Map<number, Record<string, unknown>>();
  for (const value of Object.values(bin)) {
    const entry = asRecord(value);
    if (entry.__type !== "AugmentData") continue;
    const id = entry.AugmentPlatformId;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || byId.has(id)) throw new Error("kiwi 증강 ID가 잘못되었거나 중복됩니다.");
    byId.set(id, entry);
  }
  return pool.map(member => {
    const entry = byId.get(member.platformId);
    if (!entry || entry.AugmentNameId !== member.nameId) throw new Error(`kiwi 증강 매핑이 일치하지 않습니다: ${member.platformId}`);
    for (const field of ["Enabled", "IsAbilityAugment"]) {
      if (entry[field] !== undefined && typeof entry[field] !== "boolean") throw new Error(`${field} 형식이 잘못되었습니다: ${member.platformId}`);
    }
    for (const field of ["mBuildTags", "mAugmentTags"]) {
      if (entry[field] !== undefined && (typeof entry[field] !== "number" || !Number.isSafeInteger(entry[field]) || entry[field] < 0)) {
        throw new Error(`${field} 비트마스크가 잘못되었습니다: ${member.platformId}`);
      }
    }
    const path = requiredString(entry.RootSpell, "RootSpell");
    const spellObject = asRecord(bin[path]);
    if (spellObject.__type !== "SpellObject") throw new Error(`RootSpell을 찾지 못했습니다: ${member.platformId}`);
    const spell = asRecord(spellObject.mSpell);
    const rawValues = spell.DataValues ?? [];
    if (!Array.isArray(rawValues)) throw new Error(`DataValues가 배열이 아닙니다: ${member.platformId}`);
    const dataValues = rawValues.map(value => {
      const data = asRecord(value);
      const name = requiredString(data.name, "DataValue.name");
      const values = data.values === undefined ? [] : data.values;
      if (!Array.isArray(values) || !values.every(item => typeof item === "number" && Number.isFinite(item))) {
        throw new Error(`DataValue.values가 잘못되었습니다: ${member.platformId}/${name}`);
      }
      return { name, values: [...values] as number[] };
    });
    const cooldown = spell.cooldownTime ?? asRecord(spell.Cooldown).values;
    if (cooldown !== undefined) {
      if (!Array.isArray(cooldown) || !cooldown.every(value => typeof value === "number" && Number.isFinite(value))) {
        throw new Error(`cooldownTime 형식이 잘못되었습니다: ${member.platformId}`);
      }
      if (!dataValues.some(value => value.name.toLowerCase() === "cooldown")) dataValues.push({ name: "Cooldown", values: [...cooldown] });
    }
    const questData = typeof entry.QuestData === "string" ? asRecord(bin[entry.QuestData]) : asRecord(entry.QuestData);
    const quest = typeof questData.Quest === "string" ? asRecord(bin[questData.Quest]) : asRecord(questData.Quest);
    // 퀘스트 설명은 최초 달성 조건이며, 이후 단계의 누적 목표를 섞지 않는다.
    const requirement = Array.isArray(quest.Milestones) ? asRecord(quest.Milestones[0])["{7fec0982}"] : undefined;
    if (typeof requirement === "number" && Number.isFinite(requirement)
      && !dataValues.some(value => value.name.toLowerCase() === "questrequirement")) {
      dataValues.push({ name: "QuestRequirement", values: [requirement] });
    }
    const slots = dataValues.flatMap(value => /^([QWER])AbilityHaste$/i.exec(value.name)?.[1].toUpperCase() ?? []);
    const spellSlot = slots.length === 1 ? slots[0] : /^GoH_PentakillAug_([QWER])$/.exec(member.nameId)?.[1];
    const calculations = spell.mSpellCalculations === undefined ? {} : spell.mSpellCalculations;
    if (!calculations || typeof calculations !== "object" || Array.isArray(calculations)) {
      throw new Error(`Calculations 형식이 잘못되었습니다: ${member.platformId}`);
    }
    const binRarity = entry.rarity === undefined || entry.rarity === 0 ? "silver" : entry.rarity === 1 ? "gold" : entry.rarity === 2 ? "prismatic" : null;
    return {
      ...member, ko: localizedText(entry, ko), en: localizedText(entry, en),
      icons: { small: normalizeIconPath(entry.AugmentSmallIconPath), large: normalizeIconPath(entry.AugmentLargeIconPath) },
      enabled: entry.Enabled !== false, quest: entry.QuestData !== undefined && entry.QuestData !== null,
      ability: entry.IsAbilityAugment === true,
      buildTags: typeof entry.mBuildTags === "number" ? entry.mBuildTags : 0,
      augmentTags: typeof entry.mAugmentTags === "number" ? entry.mAugmentTags : 0,
      rarityEvidence: { cherry: member.rarity, bin: binRarity },
      rootSpell: { path, dataValues, calculations: asRecord(calculations), ...(spellSlot ? { spellSlot } : {}) },
    };
  });
}
