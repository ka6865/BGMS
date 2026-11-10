import { requireLolDevPageAdmin } from "@/lib/lol/access.server";
import { getCachedLolAugmentCatalog } from "@/lib/lol/augments/catalog.server";
import MayhemOfferRulesPanel from "./MayhemOfferRulesPanel";

export default async function MayhemOfferRulesPage() {
  await requireLolDevPageAdmin();
  const catalog = await getCachedLolAugmentCatalog(null).catch(() => null);
  return <MayhemOfferRulesPanel augments={(catalog?.view.augments ?? []).map(({ id, name, rarity }) => ({ id, name, rarity }))} />;
}
