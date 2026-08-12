import { WEAPON_NAMES } from "./constants";

export interface WeaponBurstStat {
  weaponName: string;
  category: string;
  totalDamage: number;
  hitCount: number;
  firstSecHits: number;
  sustainedHits: number;
  sustainedBurstCount: number;
}

export function categorizeWeapon(rawName: string): string {
  const clean = (rawName || "").replace(/Item_Weapon_|Weap|_C|_Projectile/gi, "").toUpperCase();
  if (clean.includes("M249") || clean.includes("DP28") || clean.includes("MG3") || clean.includes("RPD")) return "LMG";
  if (clean.includes("BERYL") || clean.includes("HK416") || clean.includes("AK47") || clean.includes("AUG") || clean.includes("GROZA") || clean.includes("SCAR") || clean.includes("G36") || clean.includes("K2") || clean.includes("ACE32") || clean.includes("FAMAS")) return "AR";
  if (clean.includes("SKS") || clean.includes("MK12") || clean.includes("SLR") || clean.includes("MINI14") || clean.includes("DRAGUNOV") || clean.includes("QBU") || clean.includes("VSS") || clean.includes("MK14")) return "DMR";
  if (clean.includes("KAR98") || clean.includes("M24") || clean.includes("AWM") || clean.includes("MOSIN")) return "SR";
  if (clean.includes("S12K") || clean.includes("S686") || clean.includes("S1897") || clean.includes("DBS") || clean.includes("O12")) return "SG";
  if (clean.includes("UZI") || clean.includes("UMP") || clean.includes("VECTOR") || clean.includes("BIZON") || clean.includes("MP5K") || clean.includes("JS9")) return "SMG";
  return "OTHERS";
}

export function calculateWeaponBurstStats(events: any[], playerAccountId: string): Map<string, WeaponBurstStat> {
  const result = new Map<string, WeaponBurstStat>();
  const groggyVictims = new Set<string>();
  const pvpHits = (events || [])
    .slice()
    .sort((left, right) => new Date(left._D).getTime() - new Date(right._D).getTime())
    .filter((event) => {
      if (event._T === "LogPlayerMakeGroggy" || event._T === "LogPlayerMakeDBNO") {
        if (event.victim?.accountId) groggyVictims.add(event.victim.accountId);
        return false;
      }

      const weaponRaw = event.damageCauserName || event.damageCauser?.itemId || event.weaponId || "Unknown";
      const sameTeam = event.attacker?.teamId != null && event.attacker.teamId === event.victim?.teamId;
      return event._T === "LogPlayerTakeDamage"
        && event.attacker?.accountId === playerAccountId
        && event.victim?.accountId
        && event.victim.accountId !== playerAccountId
        && !sameTeam
        && !groggyVictims.has(event.victim.accountId)
        && categorizeWeapon(weaponRaw) !== "OTHERS"
        && (event.damage || 0) > 0;
    });

  const targetGroups = new Map<string, any[]>();
  for (const ev of pvpHits) {
    const weaponRaw = ev.damageCauserName || ev.damageCauser?.itemId || ev.weaponId || "Unknown";
    const groupKey = `${ev.victim.accountId}:${weaponRaw}`;
    const group = targetGroups.get(groupKey) || [];
    group.push(ev);
    targetGroups.set(groupKey, group);
  }

  for (const [groupKey, hitEvents] of targetGroups.entries()) {
    const weaponRaw = groupKey.split(":")[1];
    const cleanName = WEAPON_NAMES[weaponRaw] || weaponRaw.replace(/Item_Weapon_|Weap|_C|_Projectile/gi, "");
    const category = categorizeWeapon(weaponRaw);

    let stat = result.get(cleanName);
    if (!stat) {
      stat = {
        weaponName: cleanName,
        category,
        totalDamage: 0,
        hitCount: 0,
        firstSecHits: 0,
        sustainedHits: 0,
        sustainedBurstCount: 0,
      };
      result.set(cleanName, stat);
    }

    hitEvents.sort((a, b) => new Date(a._D).getTime() - new Date(b._D).getTime());
    let burstStartTs = 0;
    let lastTs = 0;
    let recordedSustainedBurst = false;

    for (const ev of hitEvents) {
      const ts = new Date(ev._D).getTime();
      stat.totalDamage += Number(ev.damage || 0);
      stat.hitCount += 1;

      if (!burstStartTs || ts - lastTs > 1500) {
        burstStartTs = ts;
        recordedSustainedBurst = false;
      }

      const elapsedMs = ts - burstStartTs;
      if (elapsedMs <= 1000) {
        stat.firstSecHits += 1;
      } else {
        stat.sustainedHits += 1;
        if (elapsedMs > 1000 && elapsedMs <= 3000 && !recordedSustainedBurst) {
          stat.sustainedBurstCount += 1;
          recordedSustainedBurst = true;
        }
      }
      lastTs = ts;
    }
  }

  return result;
}
