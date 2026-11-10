import { cookies } from "next/headers";
import { getLolPlatformStatus } from "@/lib/lol/status.server";
import { hasLolRiotAccess, LOL_PREVIEW_COOKIE } from "@/lib/lol/previewAccess";
import LolStatusBannerContent from "./LolStatusBannerContent";

export { LolStatusBannerContent };

export default async function LolStatusBanner({ admin = false }: { admin?: boolean }) {
  // 서버 상태는 Riot API 데이터라 운영 키 승인 전에는 미리보기 사용자에게만 보인다.
  if (!admin && !hasLolRiotAccess((await cookies()).get(LOL_PREVIEW_COOKIE)?.value)) return null;
  return <LolStatusBannerContent status={await getLolPlatformStatus()} admin={admin} />;
}
