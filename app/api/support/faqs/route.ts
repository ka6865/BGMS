import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

const FAQ_CATEGORIES = new Set(["stats", "account", "community", "feature"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const category = url.searchParams.get("category")?.trim() ?? "";
  const search = url.searchParams.get("q")?.trim().slice(0, 100) ?? "";
  if (category && !FAQ_CATEGORIES.has(category)) {
    return NextResponse.json({ error: "FAQ 카테고리가 올바르지 않습니다." }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    let query = (supabase as any)
      .from("support_faqs")
      .select("id,category,question,answer,sort_order,updated_at")
      .eq("is_published", true);
    if (category) query = query.eq("category", category);
    if (search) {
      const escaped = search.replace(/[\\%_]/g, "\\$&");
      query = query.ilike("question", `%${escaped}%`);
    }
    const { data, error } = await query
      .order("sort_order", { ascending: true })
      .order("updated_at", { ascending: false });
    if (error) return NextResponse.json({ error: "FAQ를 불러오지 못했습니다." }, { status: 503 });
    return NextResponse.json({ faqs: data ?? [] }, { headers: { "cache-control": "public, max-age=60" } });
  } catch {
    return NextResponse.json({ error: "FAQ를 불러오지 못했습니다." }, { status: 503 });
  }
}
