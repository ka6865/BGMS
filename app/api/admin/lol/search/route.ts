import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { handleLolSearch } from "@/lib/lol/routes.server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  return handleLolSearch(request);
}
