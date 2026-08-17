import type { MatchData } from "@/types/stat";
import { normalizeName } from "./utils";

type SquadWeaponStat = NonNullable<MatchData["squadWeaponStats"]>[string][number];

function hasOfficialWeaponStats(stat: SquadWeaponStat): boolean {
  return (stat.shots ?? 0) > 0 || (stat.holdingTime ?? 0) > 0;
}

function evidenceScore(stat: SquadWeaponStat): number {
  return ((stat.damage ?? 0) > 0 ? 1 : 0)
    + ((stat.hits ?? 0) > 0 ? 1 : 0)
    + ((stat.hitDetails?.length ?? 0) > 0 ? 1 : 0);
}

function pickPreferredWeaponStat(existing: SquadWeaponStat, candidate: SquadWeaponStat): SquadWeaponStat {
  const existingIsOfficial = hasOfficialWeaponStats(existing);
  const candidateIsOfficial = hasOfficialWeaponStats(candidate);

  if (existingIsOfficial !== candidateIsOfficial) {
    return candidateIsOfficial ? candidate : existing;
  }

  // 같은 출처로 보이는 중복도 합산하지 않는다. 높은 품질의 한 레코드만 유지한다.
  return evidenceScore(candidate) > evidenceScore(existing) ? candidate : existing;
}

/**
 * 과거 분석 결과에는 동일 팀원의 실시간 텔레메트리(소문자 키)와 경기 종료 공식 통계(원래 닉네임 키)가
 * 함께 저장된 경우가 있다. 같은 무기를 더하면 수치가 두 배가 되므로, 공식 통계를 우선하고 실시간 값은
 * 공식 목록에 없는 무기를 보완하는 용도로만 남긴다.
 */
export function normalizeSquadWeaponStats(
  squadWeaponStats: MatchData["squadWeaponStats"] | undefined,
): Record<string, SquadWeaponStat[]> {
  const playerMap = new Map<string, {
    displayName: string;
    hasCanonicalDisplayName: boolean;
    weapons: Map<string, SquadWeaponStat>;
  }>();

  Object.entries(squadWeaponStats || {}).forEach(([playerName, weapons]) => {
    const playerKey = normalizeName(playerName);
    if (!playerKey || !Array.isArray(weapons)) return;

    const isCanonicalDisplayName = playerName.trim() !== playerKey;
    const playerEntry = playerMap.get(playerKey) || {
      displayName: playerName,
      hasCanonicalDisplayName: isCanonicalDisplayName,
      weapons: new Map<string, SquadWeaponStat>(),
    };

    if (isCanonicalDisplayName && !playerEntry.hasCanonicalDisplayName) {
      playerEntry.displayName = playerName;
      playerEntry.hasCanonicalDisplayName = true;
    }

    weapons.forEach((weaponStat) => {
      const weaponKey = weaponStat.weapon || "unknown";
      const existing = playerEntry.weapons.get(weaponKey);
      playerEntry.weapons.set(
        weaponKey,
        existing ? pickPreferredWeaponStat(existing, weaponStat) : { ...weaponStat },
      );
    });

    playerMap.set(playerKey, playerEntry);
  });

  return Array.from(playerMap.values()).reduce<Record<string, SquadWeaponStat[]>>((acc, entry) => {
    acc[entry.displayName] = Array.from(entry.weapons.values());
    return acc;
  }, {});
}
