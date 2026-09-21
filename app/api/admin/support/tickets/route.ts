import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";
import { listSupportTicketsForAdmin } from "@/lib/support/ticketStore.server";

const STATUSES = new Set(["new", "in_progress", "awaiting_user", "answered", "resolved", "rejected"]);
const CATEGORIES = new Set(["privacy", "account", "community", "bug", "other"]);

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;
  const url = new URL(request.url);
  const status = url.searchParams.get("status")?.trim() ?? "";
  const category = url.searchParams.get("category")?.trim() ?? "";
  const q = url.searchParams.get("q")?.trim().slice(0, 100) ?? "";
  if ((status && !STATUSES.has(status)) || (category && !CATEGORIES.has(category))) {
    return NextResponse.json({ error: "문의 필터가 올바르지 않습니다." }, { status: 400 });
  }
  try {
    const tickets = await listSupportTicketsForAdmin(admin.supabaseAdmin as any, {
      ...(status ? { status: status as any } : {}),
      ...(category ? { category: category as any } : {}),
      ...(q ? { q } : {}),
    });
    const requesterIds = [...new Set(tickets.map((ticket) => ticket.requester_id).filter((id): id is string => Boolean(id)))];
    const nicknameById = new Map<string, string>();
    if (requesterIds.length > 0) {
      const { data: profiles, error: profileError } = await (admin.supabaseAdmin as any)
        .from("profiles")
        .select("id,nickname")
        .in("id", requesterIds);
      if (profileError) return NextResponse.json({ error: "문의 요청자 정보를 불러오지 못했습니다." }, { status: 503 });
      for (const profile of profiles ?? []) {
        if (typeof profile.id === "string" && typeof profile.nickname === "string") nicknameById.set(profile.id, profile.nickname);
      }
    }
    const enriched = tickets.map((ticket) => ({
      ...ticket,
      requester_nickname: ticket.requester_id ? nicknameById.get(ticket.requester_id) ?? null : null,
    }));
    const normalizedQuery = q.toLowerCase();
    const filtered = normalizedQuery
      ? enriched.filter((ticket) => [ticket.subject, ticket.requester_nickname, ticket.target_nickname, ticket.target_account_id]
        .some((value) => typeof value === "string" && value.toLowerCase().includes(normalizedQuery)))
      : enriched;
    return privateJson({ tickets: filtered });
  } catch {
    return privateJson({ error: "문의 목록을 불러오지 못했습니다." }, 503);
  }
}

function privateJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "cache-control": "private, no-store" } });
}
