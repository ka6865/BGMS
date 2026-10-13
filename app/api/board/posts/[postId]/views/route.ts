import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { extractClientIp } from "@/lib/board/ipUtils";
import crypto from "crypto";

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(ip).digest("hex");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;
  const id = Number(postId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return jsonError("게시글 ID가 올바르지 않습니다.", 400);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return jsonError("조회수를 반영하지 못했습니다.", 503);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

  const clientIp = extractClientIp(request);
  const ipHash = hashIp(clientIp);

  // 조회수 증가는 원자 RPC로 처리하여 중복 방지와 카운트 증가를 한 번에 수행한다.
  let rpcResult: { data: unknown; error: unknown };
  try {
    rpcResult = await supabaseAdmin.rpc("increment_board_post_views", {
      p_post_id: id,
      p_ip_hash: ipHash,
    });
  } catch {
    return jsonError("조회수를 반영하지 못했습니다.", 503);
  }

  const { data, error } = rpcResult;
  if (error) return jsonError("조회수를 반영하지 못했습니다.", 503);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return jsonError("조회수 결과를 확인하지 못했습니다.", 503);
  }

  const result = data as { status?: unknown; views?: unknown };
  if (result.status === "not_found") return jsonError("게시글을 찾을 수 없습니다.", 404);
  if (result.status !== "incremented" || !Number.isSafeInteger(result.views) || (result.views as number) < 0) {
    return jsonError("조회수 결과를 확인하지 못했습니다.", 503);
  }

  return NextResponse.json({ success: true, views: result.views }, {
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}
