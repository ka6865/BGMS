import { NextResponse } from "next/server";
import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { isSameOriginLolRequest } from "@/lib/lol/http.server";
import { revalidateTag } from "next/cache";
import { getAugmentAdminData } from "@/lib/lol/augments/admin.server";
import { LOL_AUGMENT_CATALOG_TAG } from "@/lib/lol/augments/catalog.server";
import { publishLolAugmentPatch } from "@/lib/lol/augments/persistence.server";
import { validClientPatch } from "@/lib/lol/augments/ingest";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";

export const dynamic = "force-dynamic";
const response = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
export async function GET(request: Request) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  const patch = new URL(request.url).searchParams.get("patch") ?? undefined;
  if (patch && !validClientPatch(patch)) return response({ error: "패치를 확인해 주세요." }, 400);
  try { return response(await getAugmentAdminData(patch)); }
  catch { return response({ error: "증강 검토 자료를 불러오지 못했습니다." }, 503); }
}
export async function POST(request: Request) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  if (!isSameOriginLolRequest(request)) return response({ error: "요청 출처를 확인할 수 없습니다." }, 403);
  if (process.env.LOL_PERSISTENCE_ENABLED !== "true") return response({ error: "LoL 영속 저장이 비활성화되어 있습니다." }, 503);
  if (Number(request.headers.get("content-length")) > 2048) return response({ error: "요청이 너무 큽니다." }, 413);
  let body: { patch?: unknown; action?: unknown; confirm?: unknown; id?: unknown; runId?: unknown; status?: unknown };
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 2048) return response({ error: "요청이 너무 큽니다." }, 413);
    body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_body");
  } catch { return response({ error: "요청을 확인해 주세요." }, 400); }
  if (typeof body.patch !== "string" || !validClientPatch(body.patch) || body.confirm !== true) {
    return response({ error: "패치와 확인 항목을 확인해 주세요." }, 400);
  }
  try {
    if (body.action === "publish") {
      if (typeof body.runId !== "string" || !/^[0-9a-f-]{36}$/.test(body.runId)) {
        return response({ error: "검토한 수집 실행을 확인해 주세요." }, 400);
      }
      await publishLolAugmentPatch(body.patch, body.runId);
      revalidateTag(LOL_AUGMENT_CATALOG_TAG, "max");
      return response({ ok: true });
    }
    if (body.action !== "review" || typeof body.id !== "string" || !/^[0-9a-f-]{36}$/.test(body.id)
      || typeof body.runId !== "string" || !/^[0-9a-f-]{36}$/.test(body.runId)
      || (body.status !== "approved" && body.status !== "rejected")) return response({ error: "검토 항목을 확인해 주세요." }, 400);
    const db = createServiceRoleSupabase();
    const signal = AbortSignal.timeout(10_000);
    const [patch, runs] = await Promise.all([
      db.from("lol_game_patches").select("published_at").eq("client_patch", body.patch).abortSignal(signal).single(),
      db.from("lol_augment_ingestion_runs").select("id,status").eq("client_patch", body.patch).order("started_at", { ascending: false }).limit(1).abortSignal(signal),
    ]);
    if (patch.error || runs.error) throw new Error("database_error");
    if (patch.data.published_at || runs.data[0]?.id !== body.runId || !["review", "succeeded"].includes(runs.data[0]?.status)) {
      return response({ error: "수집 상태가 바뀌었습니다. 새로고침 후 검토해 주세요." }, 409);
    }
    const update = await db.from("lol_augment_patch_changes").update({ review_status: body.status }).eq("id", body.id)
      .eq("client_patch", body.patch).eq("review_status", "pending").select("id").abortSignal(signal);
    if (update.error) throw new Error("database_error");
    if (!update.data.length) return response({ error: "이미 처리되었거나 변경된 항목입니다." }, 409);
    return response({ ok: true });
  } catch { return response({ error: "처리하지 못했습니다. 검증 상태와 미검토 변경을 확인해 주세요." }, 503); }
}
