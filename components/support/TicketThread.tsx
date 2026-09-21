"use client";

import { useEffect, useState } from "react";
import SupportStatusBadge from "./SupportStatusBadge";

type Ticket = {
  id: string;
  subject: string;
  status: string;
  verification_status?: string;
  target_platform?: string | null;
  target_resolved_nickname?: string | null;
  target_account_id?: string | null;
  messages: Array<{ id: string; sender_type: "user" | "admin"; body: string; created_at: string }>;
  attachments: Array<{ id: string; original_name: string; mime_type: string; status: string; signedUrl?: string }>;
};

export default function TicketThread({ ticketId, initialTicket }: { ticketId: string; initialTicket?: Ticket }) {
  const [ticket, setTicket] = useState<Ticket | null>(initialTicket ?? null);
  const [notFound, setNotFound] = useState(false);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    fetch(`/api/support/tickets/${ticketId}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!active) return;
        if (response.status === 404) { setNotFound(true); return; }
        if (!response.ok) throw new Error(payload.error || "문의를 불러오지 못했습니다.");
        setTicket(payload.ticket);
      })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "문의를 불러오지 못했습니다."); });
    return () => { active = false; };
  }, [refresh, ticketId]);

  useEffect(() => {
    if (!ticket || ticket.attachments.length === 0) return;
    const attachments = ticket.attachments.filter((attachment) => attachment.status === "ready" && !attachment.signedUrl);
    if (attachments.length === 0) return;
    let active = true;
    Promise.all(attachments.map(async (attachment) => {
      try {
        const response = await fetch(`/api/support/attachments/${attachment.id}/url`);
        const payload = await response.json();
        return response.ok && typeof payload.signedUrl === "string" ? { id: attachment.id, signedUrl: payload.signedUrl } : null;
      } catch { return null; }
    })).then((signed) => {
      if (!active) return;
      const signedById = new Map(signed.filter((value): value is { id: string; signedUrl: string } => Boolean(value)).map((value) => [value.id, value.signedUrl]));
      if (signedById.size === 0) return;
      setTicket((current) => current ? { ...current, attachments: current.attachments.map((attachment) => ({ ...attachment, ...(signedById.has(attachment.id) ? { signedUrl: signedById.get(attachment.id) } : {}) })) } : current);
    });
    return () => { active = false; };
  }, [ticket, ticketId]);

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setError("");
    const response = await fetch(`/api/support/tickets/${ticketId}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }),
    });
    const payload = await response.json();
    if (!response.ok) { setError(payload.error || "메시지를 저장하지 못했습니다."); return; }
    setBody("");
    setRefresh((value) => value + 1);
  }

  if (notFound) return <main className="mx-auto w-full max-w-3xl px-4 py-16 text-center text-white"><h1 className="text-2xl font-black">문의가 없습니다</h1><p className="mt-3 text-sm text-white/50">문의가 삭제되었거나 접근 권한이 없습니다.</p></main>;
  if (error && !ticket) return <main className="mx-auto w-full max-w-3xl px-4 py-16 text-center text-white"><h1 className="text-2xl font-black">문의를 불러오지 못했습니다</h1><p className="mt-3 text-sm text-red-200">{error}</p><button type="button" onClick={() => { setError(""); setRefresh((value) => value + 1); }} className="mt-5 rounded-xl bg-amber-400 px-4 py-2 text-sm font-black text-black">다시 시도</button></main>;
  if (!ticket) return <main className="mx-auto w-full max-w-3xl px-4 py-16 text-center text-sm text-white/50">문의 불러오는 중…</main>;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 text-white sm:px-6">
      <div className="mb-5 rounded-3xl border border-white/10 bg-white/[0.03] p-6">
        <div className="flex flex-wrap items-center gap-2"><SupportStatusBadge value={ticket.status} />{ticket.verification_status && <SupportStatusBadge value={ticket.verification_status} />}</div>
        <h1 className="mt-4 text-2xl font-black">{ticket.subject}</h1>
        {ticket.target_account_id && <p className="mt-2 text-xs text-white/50">{ticket.target_platform} · {ticket.target_resolved_nickname} · {ticket.target_account_id}</p>}
      </div>
      <section className="space-y-3 rounded-3xl border border-white/10 bg-[#171717] p-5">
        {ticket.messages.map((message) => <div key={message.id} className={`rounded-2xl p-4 ${message.sender_type === "admin" ? "bg-amber-400/10" : "bg-white/5"}`}><p className="mb-1 text-xs font-bold text-white/45">{message.sender_type === "admin" ? "관리자" : "나"}</p><p className="whitespace-pre-wrap text-sm leading-6 text-white/80">{message.body}</p></div>)}
        {ticket.attachments.length > 0 && <div className="border-t border-white/10 pt-4"><p className="mb-2 text-xs font-bold text-white/45">첨부 증빙</p>{ticket.attachments.map((attachment) => <div key={attachment.id} className="text-xs text-white/60">{attachment.original_name}{attachment.signedUrl && <a href={attachment.signedUrl} target="_blank" rel="noreferrer" className="ml-2 text-amber-300">열기</a>}</div>)}</div>}
        <form onSubmit={sendMessage} className="flex gap-2 border-t border-white/10 pt-4"><label className="sr-only" htmlFor="support-reply">답변</label><textarea id="support-reply" aria-label="답변" value={body} onChange={(event) => setBody(event.target.value)} rows={2} placeholder="추가로 전달할 내용" className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm" /><button type="submit" className="self-end rounded-xl bg-amber-400 px-4 py-2 text-xs font-black text-black">답변 보내기</button></form>
        {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
      </section>
    </main>
  );
}
