import { NextResponse } from "next/server";
import { createCommunityStore, resolveCommunityActor } from "@/lib/community-agent/auth";

export const maxDuration = 60;

function hasBody(request: Request): boolean {
  const length = request.headers.get("content-length");
  return request.body !== null || (length !== null && length !== "0");
}

/** A fixed retention operation for the admin or dedicated community worker. */
export async function POST(request: Request) {
  const actor = await resolveCommunityActor(request);
  if (actor instanceof Response) return actor;
  if (hasBody(request)) return NextResponse.json({ code: "invalid_request" }, { status: 400 });

  try {
    const { store } = createCommunityStore();
    return NextResponse.json({ result: await store.cleanup() });
  } catch {
    return NextResponse.json({ code: "storage_unavailable" }, { status: 503 });
  }
}
