import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { handleLolMore } from "@/lib/lol/routes.server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  return handleLolMore(request);
}
