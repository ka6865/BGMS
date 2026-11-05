import "server-only";
import { unstable_cache } from "next/cache";
import { lolAugmentIcons, preferredAugmentIcon, toLolMayhemCatalog } from "./catalog";
import { getLolAugmentCatalog } from "./persistence.server";

export const LOL_AUGMENT_CATALOG_TAG = "lol-augment-catalog";

// 게시본은 패치가 바뀔 때만 달라지므로 페이지 요청마다 DB를 읽지 않는다. 토큰을 뺀 화면용 값만 캐시해 항목 크기를 줄이고, 실패는 캐시하지 않는다.
export const getCachedLolAugmentCatalog = unstable_cache(async (patch: string | null) => {
  const catalog = await getLolAugmentCatalog(patch);
  return catalog && {
    view: toLolMayhemCatalog(catalog),
    icons: lolAugmentIcons(catalog.augments.map(augment => ({ large: augment.iconLargePath, small: augment.iconSmallPath }))),
    artwork: Object.fromEntries(catalog.augments.filter(augment => !augment.isInternal).map(augment => [augment.platformId, preferredAugmentIcon(augment.iconLargePath, augment.iconSmallPath)])),
  };
}, ["lol-augment-catalog-v2-artwork"], { revalidate: 3600, tags: [LOL_AUGMENT_CATALOG_TAG] });
