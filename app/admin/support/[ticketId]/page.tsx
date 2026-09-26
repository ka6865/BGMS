import Link from "next/link";
import { notFound } from "next/navigation";
import { isUuid } from "@/lib/board/imageStorageContract";
import { verifyAdminRole } from "@/lib/admin-agent/logging";
import { withAuthGuard } from "@/utils/supabase/guard";
import SupportTicketDetail from "@/components/admin/SupportTicketDetail";

export default async function AdminSupportTicketPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const auth = await withAuthGuard();
  if (auth.error || await verifyAdminRole(auth.supabaseAdmin, auth.user.id)) {
    return (
      <main className="min-h-screen bg-zinc-950 p-6 text-zinc-200">
        <h1 className="text-xl font-bold">고객센터 관리</h1>
        <p className="mt-4">관리자 계정으로 로그인해야 이용할 수 있습니다.</p>
        <Link className="mt-4 inline-block underline" href="/login">로그인하기</Link>
      </main>
    );
  }

  const { ticketId } = await params;
  if (!isUuid(ticketId)) notFound();

  return (
    <main className="min-h-screen bg-[#0b0f19] p-4 text-white sm:p-6">
      <div className="mx-auto max-w-4xl">
        <Link href="/admin/support" className="inline-flex min-h-11 items-center text-sm font-bold text-amber-200 hover:text-amber-100">
          ← 문의함으로 돌아가기
        </Link>
        <div className="mb-5 mt-3">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-300">BGMS Support</p>
          <h1 className="mt-2 text-3xl font-black">문의 상세</h1>
        </div>
        <SupportTicketDetail ticketId={ticketId} />
      </div>
    </main>
  );
}
