"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import SupportStatusBadge from "@/components/support/SupportStatusBadge";

type SupportTicketDetailData = {
  id: string;
  requester_nickname?: string | null;
  category: string;
  subject: string;
  body?: string;
  status: string;
  verification_status: string;
  target_platform?: string | null;
  target_nickname?: string | null;
  target_account_id?: string | null;
  messages?: Array<{ id: string; sender_type: "user" | "admin"; body: string; created_at: string }>;
  attachments?: Array<{ id: string; original_name: string; signedUrl?: string; status: string }>;
  events?: Array<{ id: string; event_type: string; from_status?: string | null; to_status?: string | null; created_at: string }>;
};

const STATUS_OPTIONS = [["new", "접수"], ["in_progress", "처리 중"], ["awaiting_user", "추가 정보 대기"], ["answered", "답변 완료"], ["resolved", "해결됨"], ["rejected", "반려됨"]] as const;
const VERIFICATION_OPTIONS = [["pending", "검증 대기"], ["verified", "검증 완료"], ["additional_info", "추가 정보 필요"], ["rejected", "검증 반려"]] as const;

export default function SupportTicketDetail({ ticketId, onChanged }: { ticketId: string; onChanged?: () => void }) {
  const [ticket, setTicket] = useState<SupportTicketDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState("");
  const [replyIdempotencyKey, setReplyIdempotencyKey] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/admin/support/tickets/${ticketId}`);
      const payload = await response.json();
      if (!response.ok || !payload.ticket) throw new Error("load_failed");
      setTicket(payload.ticket as SupportTicketDetailData);
    } catch { setError("문의를 불러오지 못했습니다."); setTicket(null); }
    finally { setLoading(false); }
  }, [ticketId]);
  useEffect(() => { void load(); }, [load]);

  async function patch(values: Record<string, string>) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/admin/support/tickets/${ticketId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "저장하지 못했습니다.");
      setTicket((current) => current ? { ...current, ...(values.status ? { status: values.status } : {}), ...(values.verificationStatus ? { verification_status: values.verificationStatus } : {}) } : current);
      toast.success("문의 상태를 저장했습니다."); onChanged?.();
    } catch (caught) { const message = caught instanceof Error ? caught.message : "저장하지 못했습니다."; setError(message); toast.error(message); }
    finally { setBusy(false); }
  }

  async function postMessage() {
    if (!reply.trim()) return;
    setBusy(true); setError("");
    try {
      const requestKey = replyIdempotencyKey || crypto.randomUUID();
      setReplyIdempotencyKey(requestKey);
      const response = await fetch(`/api/admin/support/tickets/${ticketId}/messages`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": requestKey }, body: JSON.stringify({ body: reply }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "답변을 저장하지 못했습니다.");
      setReply(""); setReplyIdempotencyKey(""); await load(); onChanged?.(); toast.success("답변을 보냈습니다.");
    } catch (caught) { const message = caught instanceof Error ? caught.message : "답변을 저장하지 못했습니다."; setError(message); toast.error(message); }
    finally { setBusy(false); }
  }

  async function applyPrivacyAction() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/admin/support/tickets/${ticketId}/privacy-action`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "비공개 처리를 완료하지 못했습니다.");
      setTicket((current) => current ? { ...current, status: "resolved" } : current); onChanged?.(); toast.success("비공개 목록에 등록했습니다.");
    } catch (caught) { const message = caught instanceof Error ? caught.message : "비공개 처리를 완료하지 못했습니다."; setError(message); toast.error(message); }
    finally { setBusy(false); }
  }

  if (loading) return <section aria-label="문의 상세" className="rounded-2xl border border-white/10 bg-[#151515] p-6 text-sm text-white/50">문의 내용을 불러오는 중…</section>;
  if (error && !ticket) return <section aria-label="문의 상세" className="rounded-2xl border border-red-400/20 bg-[#151515] p-6 text-sm text-red-200">{error}</section>;
  if (!ticket) return null;
  const isPrivacy = ticket.category === "privacy";
  const isVerified = ticket.verification_status === "verified";
  const attachments = ticket.attachments ?? [];
  return <section aria-label="문의 상세" className="rounded-2xl border border-white/10 bg-[#151515] p-5 text-white sm:p-6">
    <div className="flex flex-col gap-3 border-b border-white/10 pb-5 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs text-white/45">{ticket.requester_nickname ?? "탈퇴 회원"}</p><h2 className="mt-1 text-xl font-black">{ticket.subject}</h2><div className="mt-2 flex flex-wrap gap-2"><SupportStatusBadge value={ticket.status} />{isPrivacy && <SupportStatusBadge value={ticket.verification_status} />}</div></div><div className="flex gap-2"><select aria-label="문의 상태 변경" value={ticket.status} disabled={busy} onChange={(event) => void patch({ status: event.target.value })} className="min-h-10 rounded-lg border border-white/10 bg-black/20 px-2 text-xs"><option value="">상태</option>{STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{isPrivacy && <select aria-label="본인 계정 확인" value={ticket.verification_status} disabled={busy} onChange={(event) => void patch({ verificationStatus: event.target.value })} className="min-h-10 rounded-lg border border-white/10 bg-black/20 px-2 text-xs">{VERIFICATION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</div></div>
    {isPrivacy && <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/[0.05] p-4 text-sm"><p className="font-bold text-amber-100">대상 계정</p><p className="mt-1 text-white/75">{ticket.target_platform ?? "-"} · {ticket.target_nickname ?? "-"}</p><p className="mt-1 text-xs text-white/45">{ticket.target_account_id ?? "계정 ID 없음"}</p></div>}
    {attachments.length > 0 && <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4"><h3 className="text-sm font-bold">첨부파일 {attachments.length}개</h3><div className="mt-3 flex flex-wrap gap-2">{attachments.map((attachment) => attachment.signedUrl ? <a key={attachment.id} href={attachment.signedUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-white/15 px-3 py-2 text-xs text-amber-100">{attachment.original_name} 열기</a> : <span key={attachment.id} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-white/45">{attachment.original_name}</span>)}</div></div>}
    <div className="mt-5 space-y-3">{(ticket.messages ?? []).map((message) => <article key={message.id} className={`rounded-xl p-4 ${message.sender_type === "admin" ? "bg-amber-300/[0.08]" : "bg-white/[0.04]"}`}><p className="text-xs font-bold text-white/45">{message.sender_type === "admin" ? "관리자" : "요청자"}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-white/80">{message.body}</p></article>)}</div>
    {(ticket.events ?? []).length > 0 && <details className="mt-5 rounded-xl border border-white/10 bg-black/10 p-4"><summary className="cursor-pointer text-sm font-bold text-white/70">처리 이력 {(ticket.events ?? []).length}건</summary><div className="mt-3 space-y-2">{(ticket.events ?? []).map((event) => <div key={event.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-white/55"><span>{event.event_type}{event.from_status && event.to_status ? ` · ${event.from_status} → ${event.to_status}` : ""}</span><time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString("ko-KR")}</time></div>)}</div></details>}
    {error && <p role="alert" className="mt-4 rounded-lg border border-red-400/25 bg-red-400/10 p-3 text-sm text-red-200">{error}</p>}
    <div className="mt-5 flex flex-col gap-3"><label className="text-sm font-bold">관리자 답변<textarea aria-label="관리자 답변" value={reply} onChange={(event) => { setReply(event.target.value); setReplyIdempotencyKey(""); }} rows={4} className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 p-3 font-normal" /></label><div className="flex flex-wrap gap-2"><button type="button" onClick={() => void postMessage()} disabled={busy || !reply.trim()} className="min-h-11 rounded-xl bg-amber-400 px-4 text-sm font-black text-black disabled:opacity-40">답변 보내기</button>{isPrivacy && <button type="button" onClick={() => void applyPrivacyAction()} disabled={busy || !isVerified} className="min-h-11 rounded-xl border border-amber-300/40 px-4 text-sm font-black text-amber-100 disabled:cursor-not-allowed disabled:opacity-40">비공개 목록에 등록</button>}</div></div>
  </section>;
}
