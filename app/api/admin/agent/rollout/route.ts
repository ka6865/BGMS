import { NextResponse } from "next/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { isAdminAgentCronRequest } from "@/lib/admin-agent/cron-auth";
import { verifyAdminRole } from "@/lib/admin-agent/logging";
import { buildAgentRolloutReadiness } from "@/lib/admin-agent/rollout";
import { withAuthGuard } from "@/utils/supabase/guard";

const clean = (value: string | undefined) => (value || "").replace(/['";\s]+/g, "").trim();

export async function GET(request: Request) {
  const cronAuth = resolveCronAuth(request);
  if (cronAuth) {
    return NextResponse.json({ rollout: await buildAgentRolloutReadiness(cronAuth.supabase), source: "cron" });
  }

  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;

  return NextResponse.json({ rollout: await buildAgentRolloutReadiness(supabase), source: "manual" });
}

function resolveCronAuth(request: Request) {
  // 상수 시간 비교(lib/server/secretAuth matchesSecret)를 쓰는 공용 판정
  if (!isAdminAgentCronRequest(request)) return null;

  return {
    supabase: createSupabaseAdminClient(
      clean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      clean(process.env.SUPABASE_SERVICE_ROLE_KEY)
    )
  };
}
