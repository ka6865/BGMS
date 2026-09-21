import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";

const CATEGORIES = new Set(["stats", "account", "community", "feature"]);

export async function GET() {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;
  try {
    const { data, error } = await (admin.supabaseAdmin as any).from("support_faqs")
      .select("id,category,question,answer,sort_order,is_published,created_by,updated_by,created_at,updated_at")
      .order("sort_order", { ascending: true }).order("updated_at", { ascending: false });
    if (error) return NextResponse.json({ error: "FAQ를 불러오지 못했습니다." }, { status: 503 });
    return NextResponse.json({ faqs: data ?? [] });
  } catch { return NextResponse.json({ error: "FAQ를 불러오지 못했습니다." }, { status: 503 }); }
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;
  const parsed = await parseFaqBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const { data, error } = await (admin.supabaseAdmin as any).from("support_faqs").insert({
      category: parsed.value.category,
      question: plainText(parsed.value.question),
      answer: plainText(parsed.value.answer),
      sort_order: parsed.value.sortOrder,
      is_published: parsed.value.isPublished,
      created_by: admin.user.id,
      updated_by: admin.user.id,
    }).select("*").single();
    if (error) return NextResponse.json({ error: "FAQ를 저장하지 못했습니다." }, { status: 503 });
    return NextResponse.json({ faq: data }, { status: 201 });
  } catch { return NextResponse.json({ error: "FAQ를 저장하지 못했습니다." }, { status: 503 }); }
}

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;
  const body = await parseBody(request);
  if (!body || typeof body.id !== "string" || !body.id || !(await parseFaqRecord(body)).ok) {
    return NextResponse.json({ error: "FAQ 입력값이 올바르지 않습니다." }, { status: 400 });
  }
  const parsed = await parseFaqRecord(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const { data, error } = await (admin.supabaseAdmin as any).from("support_faqs").update({
      category: parsed.value.category,
      question: plainText(parsed.value.question),
      answer: plainText(parsed.value.answer),
      sort_order: parsed.value.sortOrder,
      is_published: parsed.value.isPublished,
      updated_by: admin.user.id,
    }).eq("id", body.id).select("*").single();
    if (error || !data) return NextResponse.json({ error: "FAQ를 찾을 수 없습니다." }, { status: 404 });
    return NextResponse.json({ faq: data });
  } catch { return NextResponse.json({ error: "FAQ를 저장하지 못했습니다." }, { status: 503 }); }
}

export async function DELETE(request: Request) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;
  const body = await parseBody(request);
  if (!body || typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "FAQ ID가 올바르지 않습니다." }, { status: 400 });
  try {
    const { data, error } = await (admin.supabaseAdmin as any).from("support_faqs").update({ is_published: false, updated_by: admin.user.id }).eq("id", body.id).select("*").single();
    if (error || !data) return NextResponse.json({ error: "FAQ를 찾을 수 없습니다." }, { status: 404 });
    return NextResponse.json({ faq: data });
  } catch { return NextResponse.json({ error: "FAQ를 숨기지 못했습니다." }, { status: 503 }); }
}

type FaqInput = { category: string; question: string; answer: string; sortOrder: number; isPublished: boolean };
async function parseFaqBody(request: Request) {
  const body = await parseBody(request);
  return parseFaqRecord(body);
}
async function parseFaqRecord(body: Record<string, unknown> | null): Promise<{ ok: true; value: FaqInput } | { ok: false; error: string }> {
  if (!body || typeof body.category !== "string" || !CATEGORIES.has(body.category)
    || typeof body.question !== "string" || !body.question.trim() || body.question.length > 200
    || typeof body.answer !== "string" || !body.answer.trim() || body.answer.length > 5000
    || typeof body.sortOrder !== "number" || !Number.isInteger(body.sortOrder) || body.sortOrder < 0 || body.sortOrder > 100000
    || typeof body.isPublished !== "boolean") return { ok: false, error: "FAQ 입력값이 올바르지 않습니다." };
  return { ok: true, value: { category: body.category, question: body.question.trim(), answer: body.answer.trim(), sortOrder: body.sortOrder, isPublished: body.isPublished } };
}
function plainText(value: string): string { return value.replace(/<[^>]*>/g, "").trim(); }
async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  try { const value: unknown = await request.json(); return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}
