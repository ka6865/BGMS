import { NextResponse } from "next/server";
import { requireLolDevAdmin } from "@/lib/lol/access.server";

export async function GET(): Promise<NextResponse> {
  const access = await requireLolDevAdmin();
  const response = access.ok ? NextResponse.json({ ok: true }) : access.error;
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
