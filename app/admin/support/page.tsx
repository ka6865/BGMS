import Link from "next/link";
import { withAuthGuard } from "@/utils/supabase/guard";
import { verifyAdminRole } from "@/lib/admin-agent/logging";
import SupportAdminShell from "@/components/admin/SupportAdminShell";

export default async function AdminSupportPage() {
  const auth = await withAuthGuard();
  if (auth.error || await verifyAdminRole(auth.supabaseAdmin, auth.user.id)) return <main className="min-h-screen bg-zinc-950 p-6 text-zinc-200"><h1 className="text-xl font-bold">고객센터 관리</h1><p className="mt-4">관리자 계정으로 로그인해야 이용할 수 있습니다.</p><Link className="mt-4 inline-block underline" href="/login">로그인하기</Link></main>;
  return <SupportAdminShell />;
}
