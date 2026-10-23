import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { handleLolSearch } from "@/lib/lol/routes.server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await guardLolPublicRequest(request, "search");
  if (denied) return denied;
  return handleLolSearch(request);
}
