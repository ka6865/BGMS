import { NextResponse } from "next/server";
import { resolveSupportPlayerTarget, SupportPlayerLookupError } from "@/lib/support/playerTarget.server";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function POST(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const body = await parseBody(request);
  if (!body || !hasOnlyKeys(body, ["platform", "nickname"])
    || (body.platform !== "steam" && body.platform !== "kakao")
    || typeof body.nickname !== "string"
    || !body.nickname.trim()
    || body.nickname.trim().length > 100) {
    return NextResponse.json({ error: "플랫폼과 닉네임을 확인해 주세요." }, { status: 400 });
  }
  try {
    const target = await resolveSupportPlayerTarget({
      platform: body.platform,
      nickname: body.nickname,
      supabaseAdmin: auth.supabaseAdmin as any,
      signal: request.signal,
    });
    return privateJson({ target });
  } catch (error) {
    const code = error instanceof SupportPlayerLookupError || isLookupError(error) ? (error as { code: string }).code : "unavailable";
    if (code === "not_found") return NextResponse.json({ error: "플레이어를 찾을 수 없습니다." }, { status: 404 });
    if (code === "rate_limited") return NextResponse.json({ error: "잠시 후 다시 시도해 주세요." }, { status: 429 });
    return NextResponse.json({ error: "플레이어를 확인하지 못했습니다." }, { status: 503 });
  }
}

function isLookupError(value: unknown): value is { code: "not_found" | "rate_limited" | "unavailable" } {
  return typeof value === "object" && value !== null
    && ["not_found", "rate_limited", "unavailable"].includes((value as { code?: unknown }).code as string);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function privateJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "cache-control": "private, no-store" } });
}

async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
