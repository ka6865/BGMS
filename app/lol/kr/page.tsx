import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { LOL_KEY_RENEWAL_MESSAGE } from "@/lib/lol/keyNotice";
import LolSearchPanel from "@/components/lol/LolSearchPanel";

export default function LolPublicPage() {
  requireLolPublicPage();
  return <LolSearchPanel publicView initialError={process.env.RIOT_API_KEY?.trim() ? undefined : LOL_KEY_RENEWAL_MESSAGE} />;
}
