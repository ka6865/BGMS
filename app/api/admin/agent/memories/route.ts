import { NextResponse } from "next/server";
import { approvalCreationFailedResponse, createApprovalRequest, verifyAdminRole } from "@/lib/admin-agent/logging";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function GET(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;

  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category");
  const queryText = String(searchParams.get("q") || "").trim().toLowerCase();
  const includeInactive = searchParams.get("includeInactive") === "true";
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 50), 1), 100);

  let query = supabase
    .from("agent_memories")
    .select("id, category, title, body, metadata, created_at, updated_at")
    .order("updated_at", { ascending: false });

  if (category) query = query.eq("category", category);
  query = query.limit(limit);

  const { data, error } = await query;
  if (error) {
    console.error("[ADMIN-AGENT] Memory list failed:", error.message || error);
    return NextResponse.json({ error: "운영 기억 목록을 불러오지 못했습니다." }, { status: 500 });
  }

  const activeFiltered = includeInactive
    ? data || []
    : (data || []).filter((memory: any) => memory.metadata?.active !== false);
  const memories = queryText
    ? activeFiltered.filter((memory: any) => memoryMatchesQuery(memory, queryText))
    : activeFiltered;

  return NextResponse.json({
    memories,
    filters: {
      category: category || "all",
      q: queryText,
      includeInactive,
      limit
    },
    facets: buildMemoryFacets(activeFiltered),
    summary: buildMemorySummary(data || [])
  });
}

function memoryMatchesQuery(memory: any, queryText: string) {
  const tags = Array.isArray(memory.metadata?.tags) ? memory.metadata.tags.join(" ") : "";
  const haystack = `${memory.title || ""} ${memory.body || ""} ${memory.category || ""} ${tags}`.toLowerCase();
  return haystack.includes(queryText);
}

function buildMemoryFacets(memories: any[]) {
  return memories.reduce((acc: Record<string, number>, memory: any) => {
    const key = memory.category || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildMemorySummary(memories: any[]) {
  const active = memories.filter((memory: any) => memory.metadata?.active !== false).length;
  return {
    total: memories.length,
    active,
    inactive: memories.length - active,
    byCategory: buildMemoryFacets(memories),
    latestUpdatedAt: memories[0]?.updated_at || null
  };
}

export async function POST(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;

  const body = await request.json();
  const category = String(body.category || "incident").trim();
  const title = String(body.title || "").trim();
  const memoryBody = String(body.body || "").trim();

  if (!title || !memoryBody) {
    return NextResponse.json({ error: "title과 body가 필요합니다." }, { status: 400 });
  }

  const approvalId = await createApprovalRequest(supabase, {
    requestedBy: user.id,
    toolName: "request_agent_memory",
    actionType: "save_agent_memory",
    payload: {
      category,
      title,
      body: memoryBody,
      metadata: {
        ...(body.metadata || {}),
        source: body.metadata?.source || "manual-admin",
        active: true
      }
    }
  });

  if (!approvalId) return approvalCreationFailedResponse("운영 기억 저장");

  return NextResponse.json({ success: true, approvalId });
}
