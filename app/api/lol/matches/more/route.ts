import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { handleLolMore } from "@/lib/lol/routes.server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = guardLolPublicRequest(request, "read");
  if (denied) return denied;
  return handleLolMore(request);
}
