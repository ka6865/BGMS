import type { Metadata } from "next";
import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { getCachedLolAugmentCatalog } from "@/lib/lol/augments/catalog.server";
import LolMayhemView from "@/components/lol/LolMayhemView";

export const metadata: Metadata = { title: { absolute: "BGMS | LoL 증바람 증강" } };

export default async function LolAramMayhemPage() {
  requireLolPublicPage();
  // 조회 실패(undefined)와 아직 게시본이 없는 상태(null)의 안내를 나눈다.
  const catalog = await getCachedLolAugmentCatalog(null).catch(() => undefined);
  return <LolMayhemView catalog={catalog?.view ?? null} error={catalog === undefined} />;
}
