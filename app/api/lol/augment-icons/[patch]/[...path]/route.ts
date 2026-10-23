import { requireLolDevAdmin } from "@/lib/lol/access.server";

export async function GET(_request: Request, { params }: { params: Promise<{ patch: string; path: string[] }> }) {
  const { patch, path } = await params;
  const publicEnabled = process.env.LOL_PUBLIC_ENABLED === "true";
  if (!publicEnabled) {
    const access = await requireLolDevAdmin();
    if (!access.ok) return access.error;
  }
  const icon = path.join("/");
  if (!/^(15|16)\.[1-9][0-9]?$/.test(patch) || !/^assets\/ux\/(kiwi|cherry)\/augments\/icons\/[a-z0-9_-]+\.png$/.test(icon)) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
  try {
    const upstream = await fetch(`https://raw.communitydragon.org/${patch}/game/${icon}`, {
      signal: AbortSignal.timeout(10_000), redirect: "error", next: { revalidate: 31536000 },
    });
    if (!upstream.ok || upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "image/png"
      || Number(upstream.headers.get("content-length")) > 2 * 1024 * 1024) throw new Error("invalid_image");
    if (!upstream.body) throw new Error("invalid_image");
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) throw new Error("invalid_image");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const image = Buffer.concat(chunks);
    if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("invalid_image");
    return new Response(image, { headers: { "Content-Type": "image/png", "X-Content-Type-Options": "nosniff",
      "Cache-Control": `${publicEnabled ? "public" : "private"}, max-age=31536000, immutable` } });
  } catch { return new Response(null, { status: 502, headers: { "Cache-Control": "private, no-store" } }); }
}
