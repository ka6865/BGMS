export type WeaponMasteryCategory =
  | "AR"
  | "SMG"
  | "DMR"
  | "SR"
  | "샷건"
  | "LMG"
  | "권총"
  | "투척류"
  | "근접/특수"
  | "기타";

export type ParsedWeaponMastery = {
  weaponId: string;
  level: number;
  xp: number;
  kills: number;
  damagePlayer: number;
  headShots: number;
  longestDefeat: number;
  mostDefeatsInAGame: number;
  rankKills: number;
  rankDamagePlayer: number;
  rankHeadShots: number;
  rankLongestDefeat: number;
  rankMostDefeatsInAGame: number;
  category: WeaponMasteryCategory;
};

const CATEGORY_MATCHERS: Array<{
  category: WeaponMasteryCategory;
  ids: string[];
}> = [
  {
    category: "AR",
    ids: ["hk416", "ace32", "beryl", "m762", "akm", "ak47", "scar", "g36c", "qbz", "aug", "groza", "m16a4", "mk47", "mk47mutant", "mutant", "famas", "k2"]
  },
  {
    category: "SMG",
    ids: ["vector", "ump", "ump45", "bizon", "mp5k", "mp9", "p90", "thompson", "tommy", "uzi", "js9"]
  },
  {
    category: "DMR",
    ids: ["mk12", "mini14", "fnfal", "slr", "sks", "vss", "mk14", "qbu", "dragunov"]
  },
  {
    category: "SR",
    ids: ["awm", "kar98", "m24", "win94", "win1894", "lynx", "l6", "mosin"]
  },
  {
    category: "샷건",
    ids: ["shotgun", "s12k", "saiga12", "dbs", "dp12", "o12", "origins12", "s686", "berreta686", "beretta686", "s1897", "winchester", "sawedoff", "sawnoff"]
  },
  {
    category: "LMG",
    ids: ["m249", "dp28", "mg3"]
  },
  {
    category: "권총",
    ids: ["pistol", "g18", "p18", "m9", "m1911", "p1911", "p92", "r1895", "nagant", "nagantm1895", "r45", "deagle", "deserteagle", "skorpion", "rhino"]
  },
  {
    category: "투척류",
    ids: ["grenade", "molotov", "smokebomb", "smoke", "flashbang", "c4", "bluezonegrenade", "decoy", "spikestrip"]
  },
  {
    category: "근접/특수",
    ids: ["panzerfaust", "mortar", "m79", "crossbow", "pan_", "pan_c", "sickle", "machete", "crowbar", "melee"]
  }
];

export function parseWeaponMasteryResponse(masteryJson: any): ParsedWeaponMastery[] {
  const summaries: Record<string, any> = masteryJson?.data?.attributes?.weaponSummaries ?? {};

  return Object.entries(summaries)
    .map(([weaponId, data]: [string, any]) => {
      const official = data?.OfficialStatsTotal ?? data?.StatsTotal ?? {};
      const competitive = data?.CompetitiveStatsTotal ?? {};

      return {
        weaponId,
        level: numberValue(data?.LevelCurrent),
        xp: numberValue(data?.XPTotal),
        kills: numberValue(official?.Kills),
        damagePlayer: numberValue(official?.DamagePlayer),
        headShots: numberValue(official?.HeadShots),
        longestDefeat: numberValue(official?.LongestKill ?? official?.LongestDefeat),
        mostDefeatsInAGame: numberValue(official?.MostKillsInAGame ?? official?.MostDefeatsInAGame),
        rankKills: numberValue(competitive?.Kills),
        rankDamagePlayer: numberValue(competitive?.DamagePlayer),
        rankHeadShots: numberValue(competitive?.HeadShots),
        rankLongestDefeat: numberValue(competitive?.LongestKill ?? competitive?.LongestDefeat),
        rankMostDefeatsInAGame: numberValue(competitive?.MostKillsInAGame ?? competitive?.MostDefeatsInAGame),
        category: getWeaponMasteryCategory(weaponId)
      };
    })
    .sort(sortWeaponMastery);
}

export function normalizeWeaponMasteryItems(items: any[]): ParsedWeaponMastery[] {
  return items.map((item) => ({
    weaponId: String(item?.weaponId || ""),
    level: numberValue(item?.level),
    xp: numberValue(item?.xp),
    kills: numberValue(item?.kills),
    damagePlayer: numberValue(item?.damagePlayer),
    headShots: numberValue(item?.headShots),
    longestDefeat: numberValue(item?.longestDefeat),
    mostDefeatsInAGame: numberValue(item?.mostDefeatsInAGame),
    rankKills: numberValue(item?.rankKills),
    rankDamagePlayer: numberValue(item?.rankDamagePlayer),
    rankHeadShots: numberValue(item?.rankHeadShots),
    rankLongestDefeat: numberValue(item?.rankLongestDefeat),
    rankMostDefeatsInAGame: numberValue(item?.rankMostDefeatsInAGame),
    category: normalizeCachedCategory(item?.category, String(item?.weaponId || ""))
  })).sort(sortWeaponMastery);
}

export function sortWeaponMastery(a: ParsedWeaponMastery, b: ParsedWeaponMastery) {
  const totalKillsA = (a.kills ?? 0) + (a.rankKills ?? 0);
  const totalKillsB = (b.kills ?? 0) + (b.rankKills ?? 0);
  if (totalKillsB !== totalKillsA) return totalKillsB - totalKillsA;
  if ((b.level ?? 0) !== (a.level ?? 0)) return (b.level ?? 0) - (a.level ?? 0);
  return (b.xp ?? 0) - (a.xp ?? 0);
}

export function getWeaponMasteryCategory(weaponId: string): WeaponMasteryCategory {
  const normalized = normalizeWeaponId(weaponId);
  const match = CATEGORY_MATCHERS.find((item) =>
    item.ids.some((id) => normalized.includes(id))
  );

  return match?.category ?? "기타";
}

function normalizeWeaponId(weaponId: string) {
  return String(weaponId || "")
    .replace(/^Item_Weapon_/i, "")
    .replace(/_C$/i, "")
    .replace(/[_-]/g, "")
    .toLowerCase();
}

function normalizeCachedCategory(category: unknown, weaponId: string) {
  if (category && category !== "기타") return category as WeaponMasteryCategory;
  return getWeaponMasteryCategory(weaponId);
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
