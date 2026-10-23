import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import LolSearchPanel from "@/components/lol/LolSearchPanel";

export default function LolPublicPage() {
  requireLolPublicPage();
  return <LolSearchPanel publicView />;
}
