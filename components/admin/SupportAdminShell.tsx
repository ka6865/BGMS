"use client";

import { useState } from "react";
import SupportFaqEditor from "@/components/admin/SupportFaqEditor";
import SupportInbox from "@/components/admin/SupportInbox";
import SupportTicketDetail from "@/components/admin/SupportTicketDetail";

export default function SupportAdminShell() {
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  return <main className="min-h-screen bg-[#0b0f19] p-4 text-white sm:p-6"><div className="mx-auto max-w-[1440px]"><div className="mb-6"><p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-300">BGMS Support</p><h1 className="mt-2 text-3xl font-black">고객센터 관리</h1><p className="mt-2 text-sm text-white/50">사용자 문의와 전적 비공개 요청을 관리자 전용 화면에서 처리합니다.</p></div><div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]"><SupportInbox refreshKey={refreshKey} selectedTicketId={selectedTicketId} onSelect={setSelectedTicketId} /><div className="space-y-5">{selectedTicketId ? <SupportTicketDetail key={`${selectedTicketId}:${refreshKey}`} ticketId={selectedTicketId} onChanged={() => setRefreshKey((value) => value + 1)} /> : <section className="flex min-h-[300px] items-center justify-center rounded-2xl border border-dashed border-white/15 bg-[#151515] p-6 text-center text-sm text-white/45">왼쪽 목록에서 문의를 선택하세요.</section>}<SupportFaqEditor /></div></div></div></main>;
}
