import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { isLolLiveEnabled } from "@/lib/lol/liveGame";
import { LOL_KEY_RENEWAL_MESSAGE } from "@/lib/lol/keyNotice";
import LolSearchPanel from "@/components/lol/LolSearchPanel";

export default function LolPublicPage() {
  requireLolPublicPage();
  return <LolSearchPanel publicView liveEnabled={isLolLiveEnabled()} initialError={process.env.RIOT_API_KEY?.trim() ? undefined : LOL_KEY_RENEWAL_MESSAGE} />;
}
