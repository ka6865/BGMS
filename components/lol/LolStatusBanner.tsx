import { getLolPlatformStatus } from "@/lib/lol/status.server";
import LolStatusBannerContent from "./LolStatusBannerContent";

export { LolStatusBannerContent };

export default async function LolStatusBanner({ admin = false }: { admin?: boolean }) {
  return <LolStatusBannerContent status={await getLolPlatformStatus()} admin={admin} />;
}
