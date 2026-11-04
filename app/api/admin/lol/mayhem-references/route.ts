import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { isSameOriginLolRequest } from "@/lib/lol/http.server";
import { getReferenceAdmin, getReferenceFile, MAYHEM_REFERENCE_TAG, referencePersistenceEnabled, reviewReference } from "@/lib/lol/mayhemReferenceStore.server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store" };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export async function GET(request: Request) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  try {
    const params = new URL(request.url).searchParams;
    if (params.has("download")) {
      const id = Number(params.get("download")), kind = params.get("kind");
      if (params.getAll("download").length !== 1 || params.getAll("kind").length !== 1 || !validId(id) || (kind !== "raw" && kind !== "normalized")) return reply({ error: "다운로드 대상을 확인해 주세요." }, 400);
      return new Response(await getReferenceFile(id, kind), { headers: { ...headers, "Content-Type": "application/json", "Content-Disposition": `attachment; filename="mayhem-reference-${id}-${kind}.json"`, "X-Content-Type-Options": "nosniff" } });
    }
    return reply(await getReferenceAdmin());
  } catch { return reply({ error: "티어·아이템·과거 순위 검토 자료를 불러오지 못했습니다." }, 503); }
}

export async function POST(request: Request) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  if (!isSameOriginLolRequest(request)) return reply({ error: "요청 출처를 확인해 주세요." }, 403);
  let body: Record<string, unknown>;
  try {
    if (Number(request.headers.get("content-length")) > 4096) return reply({ error: "요청이 너무 큽니다." }, 413);
    const text = await request.text();
    if (Buffer.byteLength(text) > 4096) return reply({ error: "요청이 너무 큽니다." }, 413);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_body");
    body = value as Record<string, unknown>;
  } catch { return reply({ error: "요청을 확인해 주세요." }, 400); }
  if (body.confirm !== true || !access.userId || !validId(body.id)
    || !(body.expectedPublication === null || validId(body.expectedPublication))
    || !(body.action === "approve" || body.action === "reject" || body.action === "publish" || body.action === "rollback")) return reply({ error: "검토 대상과 공개 상태를 확인해 주세요." }, 400);
  const reason = typeof body.reason === "string" ? body.reason.trim() : null;
  if ((body.action === "reject" && (!reason || reason.length < 10)) || (reason !== null && reason.length > 2048)) return reply({ error: "후보 제외 사유를 10~2048자로 남겨 주세요." }, 400);
  if (!referencePersistenceEnabled()) return reply({ error: "영속 저장이 활성화되지 않았습니다." }, 503);
  try {
    await reviewReference({ id: body.id, action: body.action, expectedPublication: body.expectedPublication, reviewedBy: access.userId, reason });
    if (body.action === "publish" || body.action === "rollback") revalidateTag(MAYHEM_REFERENCE_TAG, "max");
    return reply({ ok: true });
  } catch (error) {
    return reply({ error: "검토를 처리하지 못했습니다. 최신 공개 상태와 원본 파일을 확인해 주세요." }, error instanceof Error && error.message === "reference_publication_conflict" ? 409 : 503);
  }
}
