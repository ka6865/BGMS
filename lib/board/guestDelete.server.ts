import type { SupabaseClient } from "@supabase/supabase-js";

// 기존 배포의 해시도 읽어 앱·DB 전환 중 삭제 비밀번호를 유지한다.
export async function readGuestDeleteHash(input: {
  supabaseAdmin: SupabaseClient;
  scope: "post" | "comment";
  id: number;
  legacyHash: string | null;
}): Promise<string | null> {
  if (input.legacyHash) return input.legacyHash;
  const table = input.scope === "post" ? "board_post_delete_credentials" : "board_comment_delete_credentials";
  const key = input.scope === "post" ? "post_id" : "comment_id";
  const { data, error } = await input.supabaseAdmin.from(table)
    .select("password_hash").eq(key, input.id).maybeSingle();
  if (error) throw error;
  return data?.password_hash ?? null;
}
