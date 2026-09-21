"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type ResolvedTarget = { platform: "steam" | "kakao"; requestedNickname: string; canonicalNickname: string; accountId: string };

export default function TicketForm({ onCreated }: { onCreated?: (ticketId: string) => void }) {
  const router = useRouter();
  const [category, setCategory] = useState("account");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [platform, setPlatform] = useState<"steam" | "kakao">("steam");
  const [nickname, setNickname] = useState("");
  const [target, setTarget] = useState<ResolvedTarget | null>(null);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const isPrivacy = category === "privacy";
  const canSubmit = !isSubmitting && !isUploading && Boolean(subject.trim()) && Boolean(body.trim())
    && (!isPrivacy || (Boolean(target) && attachmentIds.length > 0));

  async function resolveTarget() {
    setError("");
    try {
      const response = await fetch("/api/support/player-target", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform, nickname }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "플레이어를 확인하지 못했습니다.");
      setTarget(payload.target);
    } catch (caught) {
      setTarget(null);
      setError(caught instanceof Error ? caught.message : "플레이어를 확인하지 못했습니다.");
    }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (isPrivacy && !target) {
      setError("먼저 PUBG 닉네임을 확인해 주세요.");
      return;
    }
    setError("");
    setIsUploading(true);
    try {
      const nextIds: string[] = [];
      for (const file of Array.from(files)) {
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("PNG, JPEG, WebP 이미지만 첨부할 수 있습니다.");
        if (file.size > 3 * 1024 * 1024) throw new Error("첨부파일은 3MiB 이하만 가능합니다.");
        const reserveResponse = await fetch("/api/support/attachments/reserve", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ mimeType: file.type, byteSize: file.size, originalName: file.name }),
        });
        const reserved = await reserveResponse.json();
        if (!reserveResponse.ok) throw new Error(reserved.error || "업로드 실패");
        const uploadResult = await supabase.storage.from(reserved.bucketId).uploadToSignedUrl(reserved.storageKey, reserved.token, file);
        if (uploadResult.error) throw new Error("업로드 실패");
        const completeResponse = await fetch("/api/support/attachments/complete", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attachmentId: reserved.attachmentId }),
        });
        const completed = await completeResponse.json();
        if (!completeResponse.ok) throw new Error(completed.error || "첨부파일을 완료하지 못했습니다.");
        nextIds.push(reserved.attachmentId);
      }
      setAttachmentIds(nextIds);
    } catch (caught) {
      setAttachmentIds([]);
      setError(caught instanceof Error ? caught.message : "업로드 실패");
    } finally {
      setIsUploading(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setError("");
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/support/tickets", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ category, subject, body, ...(isPrivacy ? { platform, nickname, attachmentIds } : { attachmentIds }) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "문의를 저장하지 못했습니다.");
      const id = payload.ticket?.id;
      if (typeof id !== "string") throw new Error("문의 번호를 확인하지 못했습니다.");
      if (onCreated) onCreated(id); else router.push(`/support/${id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "문의를 저장하지 못했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5 rounded-3xl border border-white/10 bg-[#171717] p-5 text-white sm:p-7">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-bold">문의 유형<select aria-label="문의 유형" value={category} onChange={(event) => { setCategory(event.target.value); setTarget(null); setAttachmentIds([]); }} className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-black/20 px-3 font-normal outline-none focus:border-amber-400/60">
          <option value="account">계정</option><option value="community">커뮤니티</option><option value="bug">오류</option><option value="privacy">전적 비공개 요청</option><option value="other">기타</option>
        </select></label>
        <label className="text-sm font-bold">제목<input aria-label="제목" value={subject} maxLength={120} onChange={(event) => setSubject(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-black/20 px-3 font-normal outline-none focus:border-amber-400/60" /></label>
      </div>

      {isPrivacy && <div className="space-y-4 rounded-2xl border border-amber-400/20 bg-amber-400/[0.04] p-4">
        <p className="text-sm leading-6 text-white/70">전적 비공개 요청은 본인 계정 확인을 위해 인게임 프로필 또는 최근 전적 화면 스크린샷이 필수입니다. 관리자가 수동으로 검토합니다.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-bold">플랫폼<select aria-label="플랫폼" value={platform} onChange={(event) => { setPlatform(event.target.value as "steam" | "kakao"); setTarget(null); }} className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-black/20 px-3 font-normal"><option value="steam">Steam</option><option value="kakao">Kakao</option></select></label>
          <label className="text-sm font-bold">PUBG 닉네임<input aria-label="PUBG 닉네임" value={nickname} onChange={(event) => { setNickname(event.target.value); setTarget(null); }} className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-black/20 px-3 font-normal" /></label>
        </div>
        <button type="button" onClick={resolveTarget} className="rounded-xl border border-amber-400/40 px-3 py-2 text-xs font-bold text-amber-200">대상 확인</button>
        {target && <p className="text-xs text-emerald-300">확인된 계정: {target.canonicalNickname} · {target.accountId}</p>}
        <p className="text-xs text-amber-200/80">스크린샷 필수 · PNG/JPEG/WebP · 파일당 3MiB 이하</p>
      </div>}

      <label className="block text-sm font-bold">문의 내용<textarea aria-label="문의 내용" value={body} maxLength={5000} onChange={(event) => setBody(event.target.value)} rows={7} className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 font-normal outline-none focus:border-amber-400/60" /></label>
      <label className="block text-sm font-bold">첨부파일<input aria-label="첨부파일" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => uploadFiles(event.target.files)} disabled={isUploading} className="mt-2 block w-full text-sm text-white/60 file:mr-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-white" /></label>
      {attachmentIds.length > 0 && <p className="text-xs text-emerald-300">첨부파일 {attachmentIds.length}개 준비 완료</p>}
      {error && <p role="alert" className="rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</p>}
      <button type="submit" disabled={!canSubmit} className="min-h-11 rounded-xl bg-amber-400 px-5 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-40">{isSubmitting ? "제출 중…" : "문의 제출"}</button>
    </form>
  );
}
