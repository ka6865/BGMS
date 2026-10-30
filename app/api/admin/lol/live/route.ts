import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { handleLolLive } from "@/lib/lol/liveRoutes.server";

export const dynamic = "force-dynamic";

// 관리자 확인 화면은 LOL_LIVE_ENABLED와 무관하게 기존 관리자 가드(LOL_DEV_ENABLED + 관리자 권한)만 확인한다.
export async function POST(request: Request) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  return handleLolLive(request);
}
