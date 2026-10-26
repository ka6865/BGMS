import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { handleLolBuild } from "@/lib/lol/routes.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ matchId: string }> }) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  return handleLolBuild(request, context);
}
