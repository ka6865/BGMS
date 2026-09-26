"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import SupportStatusBadge from "@/components/support/SupportStatusBadge";

type SupportTicketSummary = {
  id: string;
  subject: string;
  category: string;
  status: string;
  verification_status: string;
  requester_nickname?: string | null;
  target_nickname?: string | null;
  last_message_at?: string;
  last_message_sender?: string;
  created_at?: string;
  unread?: boolean;
};

const STATUS_OPTIONS = [
  ["", "전체 상태"], ["new", "접수"], ["in_progress", "처리 중"], ["awaiting_user", "추가 정보 대기"],
  ["answered", "답변 완료"], ["resolved", "해결됨"], ["rejected", "반려됨"],
] as const;
const CATEGORY_OPTIONS = [["", "전체 유형"], ["privacy", "전적 비공개"], ["account", "계정"], ["community", "커뮤니티"], ["bug", "오류"], ["other", "기타"]] as const;

export default function SupportInbox() {
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [tickets, setTickets] = useState<SupportTicketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (category) params.set("category", category);
    if (query.trim()) params.set("q", query.trim());
    try {
      const response = await fetch(`/api/admin/support/tickets${params.toString() ? `?${params}` : ""}`);
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.tickets)) throw new Error("load_failed");
      setTickets(payload.tickets as SupportTicketSummary[]);
    } catch {
      setTickets([]);
      setError("문의 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [category, query, status]);

  useEffect(() => { void load(); }, [load]);

  const pendingCount = useMemo(() => tickets.filter((ticket) => ["new", "in_progress", "awaiting_user"].includes(ticket.status)).length, [tickets]);

  return (
    <section aria-label="고객센터 문의 목록" className="flex min-h-[620px] flex-col rounded-2xl border border-white/10 bg-[#151515] p-4 text-white">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div><h2 className="text-lg font-black">문의함</h2><p className="mt-1 text-xs text-white/45">처리 대기 {pendingCount}건 · 오래된 문의부터 표시</p></div>
        <button type="button" onClick={() => void load()} className="rounded-lg border border-white/15 px-3 py-2 text-xs font-bold text-white/70 hover:text-white">새로고침</button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="text-xs font-bold text-white/60">문의 상태<select aria-label="문의 상태" value={status} onChange={(event) => setStatus(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-sm text-white"><option value="">전체 상태</option>{STATUS_OPTIONS.slice(1).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="text-xs font-bold text-white/60">문의 유형<select aria-label="문의 유형" value={category} onChange={(event) => setCategory(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-sm text-white"><option value="">전체 유형</option>{CATEGORY_OPTIONS.slice(1).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="text-xs font-bold text-white/60">문의 검색<input aria-label="문의 검색" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="제목·닉네임·대상" className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-sm text-white" /></label>
      </div>
      {error && <p role="alert" className="mt-4 rounded-lg border border-red-400/25 bg-red-400/10 p-3 text-sm text-red-200">{error}</p>}
      <div className="mt-4 flex-1 space-y-2 overflow-y-auto pr-1">
        {loading ? <p className="py-10 text-center text-sm text-white/45">문의 목록을 불러오는 중…</p>
          : tickets.length === 0 ? <p className="py-10 text-center text-sm text-white/45">조건에 맞는 문의가 없습니다.</p>
          : tickets.map((ticket) => <Link key={ticket.id} href={`/admin/support/${ticket.id}`} prefetch={false} className="block w-full rounded-xl border border-white/10 bg-black/10 p-3 text-left transition hover:border-amber-300/60 hover:bg-amber-300/[0.06] focus-visible:outline-2 focus-visible:outline-amber-300">
            <div className="flex items-start justify-between gap-2"><span className="min-w-0 truncate text-sm font-black">{ticket.subject}</span><SupportStatusBadge value={ticket.status} /></div>
            <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs text-white/50"><span>{ticket.requester_nickname ?? "탈퇴 회원"}</span><span>·</span><span>{ticket.category === "privacy" ? "전적 비공개" : ticket.category}</span>{ticket.unread && <span className="text-amber-200">새 답변</span>}</div>
            <span className="mt-2 block text-right text-xs font-bold text-amber-200">문의 상세 보기 →</span>
          </Link>)}
      </div>
    </section>
  );
}
