import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { LOL_AUGMENT_ICON_PATH } from "@/lib/lol/augments/catalog";
import { getCachedLolAugmentCatalog } from "@/lib/lol/augments/catalog.server";
import { LOL_AUGMENT_ICON_BUCKET, MAX_LOL_AUGMENT_ICON_BYTES, isPng, lolAugmentIconObject } from "@/lib/lol/augments/icons";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";

const ONE_YEAR_SECONDS = 31536000;
const empty = (status: number) => new Response(null, { status, headers: { "Cache-Control": "private, no-store" } });

export async function GET(_request: Request, { params }: { params: Promise<{ patch: string; path: string[] }> }) {
  const { patch, path } = await params;
  const icon = path.join("/");
  const valid = /^(15|16)\.[1-9][0-9]?$/.test(patch) && LOL_AUGMENT_ICON_PATH.test(icon);
  const publicView = process.env.LOL_PUBLIC_ENABLED === "true";
  // 캐시된 게시본 목록으로 먼저 거른다. 없는 파일명을 바꿔 가며 호출해도 CDN에 남지 않는 요청이 Storage까지 가지 않는다.
  const listed = publicView && valid && (await getCachedLolAugmentCatalog(patch).catch(() => null))?.icons.includes(icon);
  if (!listed) {
    // 관리자는 게시 전 패치도 미리 본다.
    const access = await requireLolDevAdmin();
    if (!access.ok) return publicView ? empty(404) : access.error;
    if (!valid) return empty(404);
  }
  try {
    const { data, error } = await createServiceRoleSupabase().storage.from(LOL_AUGMENT_ICON_BUCKET).download(lolAugmentIconObject(patch, icon));
    if (error || !data) return empty(/not.?found/i.test(error?.message ?? "") ? 404 : 502);
    if (data.size > MAX_LOL_AUGMENT_ICON_BYTES) return empty(502);
    const image = new Uint8Array(await data.arrayBuffer());
    if (!isPng(image)) return empty(502);
    // 패치 버전이 경로에 있어 내용이 바뀌지 않으므로, 공개 응답은 CDN이 1년 보관해 함수와 Storage까지 오지 않게 한다.
    const cacheControl = listed ? `public, max-age=${ONE_YEAR_SECONDS}, s-maxage=${ONE_YEAR_SECONDS}, immutable`
      : `private, max-age=${ONE_YEAR_SECONDS}, immutable`;
    return new Response(image, { headers: { "Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Cache-Control": cacheControl,
      ...(listed ? { "CDN-Cache-Control": cacheControl, "Vercel-CDN-Cache-Control": cacheControl } : {}) } });
  } catch { return empty(502); }
}
