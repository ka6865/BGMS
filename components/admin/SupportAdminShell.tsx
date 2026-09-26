import SupportFaqEditor from "@/components/admin/SupportFaqEditor";
import SupportInbox from "@/components/admin/SupportInbox";

export default function SupportAdminShell() {
  return (
    <main className="min-h-screen bg-[#0b0f19] p-4 text-white sm:p-6">
      <div className="mx-auto max-w-[1440px]">
        <div className="mb-6">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-300">BGMS Support</p>
          <h1 className="mt-2 text-3xl font-black">고객센터 관리</h1>
          <p className="mt-2 text-sm text-white/50">문의를 눌러 상세 내용을 확인하고 답변하거나 처리 상태를 변경하세요.</p>
        </div>
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <SupportInbox />
          <SupportFaqEditor />
        </div>
      </div>
    </main>
  );
}
