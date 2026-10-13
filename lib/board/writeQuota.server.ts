import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";

export type BoardWriteScope = "post" | "comment" | "post_delete" | "comment_delete";

export type BoardWriteQuotaResult =
  | { ok: true }
  | { ok: false; status: 429 | 503; error: string };

const QUOTA_UNAVAILABLE_ERROR =
  "게시판 요청 제한을 확인하지 못했습니다.";

const QUOTAS = {
  post: {
    windowSeconds: 60,
    limit: 1,
    error: "게시글은 1분에 한 번만 작성할 수 있습니다.",
  },
  comment: {
    windowSeconds: 10,
    limit: 1,
    error: "댓글은 10초에 한 번만 작성할 수 있습니다.",
  },
  post_delete: {
    windowSeconds: 60,
    limit: 5,
    error: "삭제 비밀번호를 여러 번 시도했습니다. 1분 후 다시 시도해 주세요.",
  },
  comment_delete: {
    windowSeconds: 60,
    limit: 5,
    error: "삭제 비밀번호를 여러 번 시도했습니다. 1분 후 다시 시도해 주세요.",
  },
} as const satisfies Record<
  BoardWriteScope,
  { windowSeconds: number; limit: number; error: string }
>;

export function buildBoardWriteActorHash(
  scope: BoardWriteScope,
  actor: string,
): string {
  return createHash("sha256")
    .update(`${scope}:${normalizeBoardWriteActor(actor)}`)
    .digest("hex");
}

function normalizeBoardWriteActor(actor: string): string {
  const trimmedActor = actor.trim();
  if (isIP(trimmedActor) !== 6) return trimmedActor;

  const [head = "", tail = ""] = trimmedActor.toLowerCase().split("::", 2);
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const expandIpv4 = (part: string) => {
    if (!part.includes(".")) return [part];
    const octets = part.split(".").map(Number);
    return [
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16),
    ];
  };
  const parts = [...headParts, ...tailParts].flatMap(expandIpv4);
  const missingParts = 8 - parts.length;
  const expanded = [
    ...headParts.flatMap(expandIpv4),
    ...Array(Math.max(missingParts, 0)).fill("0"),
    ...tailParts.flatMap(expandIpv4),
  ];

  return `ipv6/64:${expanded.slice(0, 4).map((part) => part.padStart(4, "0")).join(":")}`;
}

export async function consumeBoardWriteQuota(input: {
  supabaseAdmin: SupabaseClient;
  scope: BoardWriteScope;
  actor: string;
}): Promise<BoardWriteQuotaResult> {
  const actor = input.actor.trim();
  if (!actor) {
    return { ok: false, status: 503, error: QUOTA_UNAVAILABLE_ERROR };
  }

  const quota = QUOTAS[input.scope];

  try {
    const { data, error } = await input.supabaseAdmin.rpc(
      "consume_board_write_quota",
      {
        p_scope: input.scope,
        p_actor_hash: buildBoardWriteActorHash(input.scope, actor),
        p_window_seconds: quota.windowSeconds,
        p_limit: quota.limit,
      },
    );

    if (error || typeof data !== "boolean") {
      return { ok: false, status: 503, error: QUOTA_UNAVAILABLE_ERROR };
    }

    return data
      ? { ok: true }
      : { ok: false, status: 429, error: quota.error };
  } catch {
    return { ok: false, status: 503, error: QUOTA_UNAVAILABLE_ERROR };
  }
}
