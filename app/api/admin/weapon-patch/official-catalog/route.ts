import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";
import { recordAdminAudit } from "@/lib/server/adminAudit";
import { parseOfficialCatalog } from "@/lib/patch-notes/officialCatalog";

const SOURCES = {
  weapons: "https://pubg.com/ko/game-info/weapons/etc",
  vehicles: "https://pubg.com/ko/game-info/vehicles/land",
} as const;

async function fetchSources() {
  return Promise.all(Object.entries(SOURCES).map(async ([category, url]) => {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!response.ok) throw new Error("공식 도감을 읽지 못했습니다.");
    return { category, url, items: parseOfficialCatalog(await response.text()) };
  }));
}
function fingerprint(categories: Awaited<ReturnType<typeof fetchSources>>) {
  return createHash("sha256").update(JSON.stringify(categories)).digest("hex");
}

export async function GET() {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;
  try {
    const sources = await fetchSources();
    const categories = await Promise.all(sources.map(async (source) => {
      const query = await admin.supabaseAdmin.from(source.category).select(source.category === "weapons" ? "id,name,ammo,damage,bullet_speed" : "id,name,trunk_capacity").is("removed_at", null).limit(1000);
      if (query.error) throw new Error("BGMS 데이터를 읽지 못했습니다.");
      const rows = (query.data ?? []) as unknown as { id: string; name: string; [key: string]: unknown }[];
      return { ...source, items: source.items.map((item) => {
        const matches = rows.filter((row) => row.name.trim().toLocaleLowerCase() === item.name.trim().toLocaleLowerCase());
        return { ...item, current: matches.length === 1 ? matches[0] : null };
      }) };
    }));
    return NextResponse.json({ categories, fingerprint: fingerprint(sources) });
  } catch {
    return NextResponse.json({ error: "공식 도감 비교를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;
  const body = await request.json().catch(() => null);
  if (typeof body?.fingerprint !== "string") return NextResponse.json({ error: "먼저 공식 도감을 불러와 확인해 주세요." }, { status: 400 });
  try {
    const sources = await fetchSources();
    if (fingerprint(sources) !== body.fingerprint) return NextResponse.json({ error: "공식 정보가 바뀌었습니다. 다시 불러와 확인해 주세요." }, { status: 409 });
    const fetchedAt = new Date().toISOString();
    const { error } = await admin.supabaseAdmin.from("official_game_catalog").upsert(sources.map((source) => ({ category: source.category, source_url: source.url, fetched_at: fetchedAt, items: source.items })));
    if (error) throw error;
    await recordAdminAudit(admin.supabaseAdmin, { actorId: admin.user.id, action: "official_game_catalog.publish", targetType: "official_game_catalog", targetId: "all", phase: "succeeded", detail: { counts: sources.map((source) => ({ category: source.category, count: source.items.length })) } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "공식 도감을 저장하지 못했습니다." }, { status: 500 });
  }
}
