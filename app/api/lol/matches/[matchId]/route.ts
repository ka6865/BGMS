import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { handleLolDetail } from "@/lib/lol/routes.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ matchId: string }> }) {
  const denied = await guardLolPublicRequest(request, "read");
  if (denied) return denied;
  return handleLolDetail(request, context);
}
