import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { getLolPlatformStatus } from "@/lib/lol/status.server";
import LolStatusView from "@/components/lol/LolStatusView";

export default async function LolStatusPage() {
  requireLolPublicPage();
  return <LolStatusView status={await getLolPlatformStatus()} />;
}
