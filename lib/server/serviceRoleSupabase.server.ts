import { createClient } from "@supabase/supabase-js";

/**
 * 플레이어 단위 전적·분석 테이블은 공개 키로 읽을 수 없다(20261017050000).
 * 서버에서 이 테이블을 읽는 경로는 이 service role 클라이언트를 쓴다. 비공개 플레이어 차단은 호출부가 맡는다.
 */
export function createServiceRoleSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
