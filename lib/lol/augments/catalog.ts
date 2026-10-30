import type { AugmentCatalog } from "./persistence.server";

export const LOL_AUGMENT_ICON_PATH = /^assets\/ux\/(kiwi|cherry)\/augments\/icons\/[a-z0-9_-]+\.png$/;
export const LOL_AUGMENT_RARITIES = ["prismatic", "gold", "silver"] as const;
export type LolAugmentRarity = typeof LOL_AUGMENT_RARITIES[number];
export const LOL_AUGMENT_RARITY_LABELS: Record<LolAugmentRarity, string> = { prismatic: "프리즘", gold: "골드", silver: "실버" };

export type LolMayhemAugment = {
  id: number; name: string; nameEn: string | null; rarity: LolAugmentRarity;
  icon: string | null; text: string; notice: string | null; isNew: boolean;
};
export type LolMayhemCatalog = {
  clientPatch: string; displayPatch: string; releasedAt: string; notesUrl: string | null;
  augments: LolMayhemAugment[]; removed: string[];
};

// 작은 아이콘은 회색 실루엣이라 색이 있는 큰 아이콘을 우선하고, 큰 아이콘 경로가 해시뿐인 증강만 작은 아이콘을 쓴다.
export function preferredAugmentIcon(large: string | null, small: string | null): string | null {
  return [large, small].find(path => path && LOL_AUGMENT_ICON_PATH.test(path)) ?? null;
}

// 수집기가 남긴 검토용 머리말을 빼고 공식 노트의 삭제 이름만 화면에 쓴다.
function removedNames(summary: string): string[] {
  const list = summary.match(/^공식 노트 삭제 목록(?:\([^)]*\))?:\s*(.+)$/);
  return list ? list[1].split(",").map(name => name.trim()).filter(Boolean) : [summary.replace(/:\s*삭제$/, "")];
}

// 도감에는 지금 게임에 나오는 일반 증강만 싣는다. 내부 증강(헤드라이너 전용)과 비활성 증강은 개수에서도 뺀다.
export function toLolMayhemCatalog(catalog: AugmentCatalog): LolMayhemCatalog {
  const added = new Set(catalog.changes.filter(change => change.changeType === "added").map(change => change.platformId));
  const order = (rarity: LolAugmentRarity) => LOL_AUGMENT_RARITIES.indexOf(rarity);
  const augments = catalog.augments
    .filter(augment => !augment.isInternal && augment.enabled && augment.inPool)
    .map(augment => {
      const ko = augment.localizations.ko_kr;
      return {
        id: augment.platformId, name: ko.name ?? augment.localizations.en_us.name ?? `증강 ${augment.platformId}`,
        nameEn: augment.localizations.en_us.name, rarity: augment.rarity, icon: preferredAugmentIcon(augment.iconLargePath, augment.iconSmallPath),
        text: ko.text, notice: ko.notice, isNew: added.has(augment.platformId),
      };
    })
    .sort((a, b) => order(a.rarity) - order(b.rarity) || a.name.localeCompare(b.name, "ko"));
  return {
    clientPatch: catalog.clientPatch, displayPatch: catalog.displayPatch, releasedAt: catalog.releasedAt, notesUrl: catalog.notesUrlKo, augments,
    removed: catalog.changes.filter(change => change.changeType === "removed").flatMap(change => removedNames(change.summaryKo)),
  };
}

// 아이콘 경로의 허용 목록이다. 관리자 미리보기와 같은 규칙으로 내부·비활성 증강까지 모두 포함한다.
export function lolAugmentIcons(rows: Array<{ large: string | null; small: string | null }>): string[] {
  return [...new Set(rows.map(row => preferredAugmentIcon(row.large, row.small)).filter((icon): icon is string => icon !== null))];
}

export function filterLolMayhemAugments(augments: LolMayhemAugment[], query: string, rarity: LolAugmentRarity | null, newOnly: boolean): LolMayhemAugment[] {
  const needle = query.trim().toLocaleLowerCase("ko");
  return augments.filter(augment => (!rarity || augment.rarity === rarity) && (!newOnly || augment.isNew)
    && (!needle || [augment.name, augment.nameEn ?? "", augment.text].some(value => value.toLocaleLowerCase("ko").includes(needle))));
}
