import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { isSameOriginLolRequest } from "@/lib/lol/http.server";
import { validClientPatch } from "@/lib/lol/augments/ingest";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import { getMayhemDatasetAdmin, getMayhemSnapshotFile, MAYHEM_DATASET_TAG } from "@/lib/lol/mayhemDatasetStore.server";
import { ingestMayhemDataset } from "@/lib/lol/mayhemIngest.server";
import { MAYHEM_EXTERNAL_ID_PATTERN } from "@/lib/lol/mayhemDatasetView";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const validId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;

export async function GET(request: Request) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  try {
    const params = new URL(request.url).searchParams;
    if (params.has("download")) {
      const id = Number(params.get("download")); const kind = params.get("kind");
      if (!validId(id) || (kind !== "augments" && kind !== "combos")) return reply({ error: "다운로드 대상을 확인해 주세요." }, 400);
      return new Response(await getMayhemSnapshotFile(id, kind), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Content-Disposition": `attachment; filename="mayhem-${id}-${kind}.json"`, "X-Content-Type-Options": "nosniff" } });
    }
    return reply(await getMayhemDatasetAdmin());
  } catch { return reply({ error: "데이터셋 검토 자료를 불러오지 못했습니다." }, 503); }
}

export async function POST(request: Request) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  if (!isSameOriginLolRequest(request)) return reply({ error: "요청 출처를 확인해 주세요." }, 403);
  if (process.env.LOL_PERSISTENCE_ENABLED !== "true") return reply({ error: "영속 저장이 꺼져 있습니다." }, 503);
  let body: Record<string, unknown>;
  try {
    if (Number(request.headers.get("content-length")) > 4096) return reply({ error: "요청이 너무 큽니다." }, 413);
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 4096) return reply({ error: "요청이 너무 큽니다." }, 413);
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_body");
  } catch { return reply({ error: "요청을 확인해 주세요." }, 400); }
  if (body.confirm !== true || !access.userId) return reply({ error: "검토 확인이 필요합니다." }, 400);
  try {
    if (body.action === "sync") return reply({ ok: true, ...await ingestMayhemDataset({ apply: true }) });
    const db = createServiceRoleSupabase();
    if (body.action === "map") {
      if (typeof body.patch !== "string" || !validClientPatch(body.patch) || typeof body.externalId !== "string" || !MAYHEM_EXTERNAL_ID_PATTERN.test(body.externalId)
        || !validId(body.platformId) || typeof body.evidence !== "string" || body.evidence.trim().length < 10 || body.evidence.length > 2048) return reply({ error: "매핑 ID와 검토 근거를 확인해 주세요." }, 400);
      const result = await db.rpc("review_lol_mayhem_mapping", { p_external_id: body.externalId, p_patch: body.patch,
        p_platform_id: body.platformId, p_evidence: { note: body.evidence.trim() }, p_reviewed_by: access.userId }).abortSignal(AbortSignal.timeout(10_000));
      if (result.error) throw new Error("database_error");
      return reply({ ok: true });
    }
    if (!["approve", "reject", "publish", "rollback"].includes(String(body.action)) || !validId(body.id)
      || !(body.expectedPublication === null || validId(body.expectedPublication))) return reply({ error: "검토한 버전과 현재 공개본을 확인해 주세요." }, 400);
    const reason = typeof body.reason === "string" ? body.reason.trim() : null;
    if (body.action === "reject" && (!reason || reason.length < 10 || reason.length > 2048)) return reply({ error: "후보 제외 사유를 10~2048자로 남겨 주세요." }, 400);
    const result = await db.rpc("review_lol_mayhem_dataset", { p_id: body.id, p_action: body.action,
      p_expected_publication: body.expectedPublication, p_reviewed_by: access.userId, p_reason: reason }).abortSignal(AbortSignal.timeout(10_000));
    if (result.error) return reply({ error: "검토 또는 공개 상태가 바뀌었습니다. 미매핑 항목과 패치를 다시 확인해 주세요." }, 409);
    if (body.action === "publish" || body.action === "rollback") revalidateTag(MAYHEM_DATASET_TAG, "max");
    return reply({ ok: true });
  } catch { return reply({ error: "처리하지 못했습니다. 기존 공개본은 유지됩니다." }, 503); }
}
