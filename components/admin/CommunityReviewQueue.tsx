"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { sanitizeBoardHtml } from "@/lib/board/sanitizeHtml";

type ReviewKind = "post" | "reply";
type ReviewStatus = "generating" | "pending" | "published" | "rejected" | "expired" | "failed";

type CommunityReview = {
  id: string;
  kind: ReviewKind;
  status: ReviewStatus;
  title: string;
  body: string;
  category: string | null;
  target_post_id: number | null;
  target_comment_id: number | null;
  target_comment_content: string | null;
  target_comment_author: string | null;
  reason: string | null;
  result_post_id: number | null;
  result_comment_id: number | null;
  notification_error: string | null;
  discord_message_id: string | null;
  created_at: string;
  expires_at: string;
};

type DiscordMode = "buttons" | "review_link";
type ReviewResponse = { reviews?: unknown; discordMode?: unknown };
type OperationResponse = {
  result?: { code?: unknown };
  notification?: { code?: unknown };
};

const REVIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STATUS_TEXT: Record<ReviewStatus, string> = {
  generating: "초안 생성 중",
  pending: "승인 대기",
  published: "발행됨",
  rejected: "거절됨",
  expired: "기한 만료",
  failed: "생성 실패",
};

const RESULT_TEXT: Record<string, string> = {
  published: "승인되어 BGMS에 발행했습니다.",
  rejected: "초안을 거절했습니다. 이 내용은 발행되지 않습니다.",
  paused: "커뮤니티 운영이 일시 중지되어 발행하지 않았습니다.",
  target_changed: "원본 글이나 댓글이 변경되어 발행하지 않았습니다. 이 검토를 거절하고 변경된 내용을 직접 확인해주세요.",
  limit: "오늘 발행 한도에 도달해 발행하지 않았습니다.",
  expired: "검토 기한이 지나 발행하지 않았습니다. 새 초안을 만들어주세요.",
  category_disabled: "현재 허용하지 않는 카테고리라 발행하지 않았습니다. 설정을 확인한 뒤 새 초안을 만들어주세요.",
  already_replied: "BGMS AI가 이미 답글을 작성해 중복 발행하지 않았습니다.",
  invalid_bot: "BGMS AI 계정 설정을 확인한 뒤 다시 시도해주세요.",
  pending: "이미 승인 대기 중인 초안입니다.",
  failed: "초안 생성에 실패했습니다. 원인을 확인한 뒤 다시 처리해주세요.",
  drafted: "새 초안을 승인 대기 목록에 저장했습니다.",
  deferred: "검토할 새 답글 초안을 만들지 못해 보류했습니다.",
  invalid_response: "AI 응답 형식이 맞지 않아 초안을 발행하지 않고 보류했습니다.",
  no_work: "새로 처리할 게시글이나 답글이 없습니다.",
  notified: "Discord 검토 알림을 보냈습니다.",
  notification_failed: "Discord 알림을 보내지 못했습니다. 설정을 확인한 뒤 다시 보내주세요.",
};

function isReview(value: unknown): value is CommunityReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string"
    && (row.kind === "post" || row.kind === "reply")
    && Object.hasOwn(STATUS_TEXT, String(row.status))
    && typeof row.title === "string"
    && typeof row.body === "string";
}

function operationMessage(data: OperationResponse): string {
  const resultCode = typeof data.result?.code === "string" ? data.result.code : null;
  const notificationCode = typeof data.notification?.code === "string" ? data.notification.code : null;
  const result = resultCode ? RESULT_TEXT[resultCode] ?? `처리 결과: ${resultCode}` : "";
  const notification = notificationCode ? RESULT_TEXT[notificationCode] ?? `알림 결과: ${notificationCode}` : "";
  return [result, notification].filter(Boolean).join(" ") || "요청을 처리했습니다.";
}

function formattedDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "시간 정보 없음";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
  });
  if (!response.ok) throw new Error("review_request_failed");
  return response.json();
}

export default function CommunityReviewQueue({ refreshKey = 0 }: { refreshKey?: string | number }) {
  const [reviews, setReviews] = useState<CommunityReview[]>([]);
  const [discordMode, setDiscordMode] = useState<DiscordMode>("review_link");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams(window.location.search);
      const requested = params.get("review");
      const focusedId = requested && REVIEW_ID.test(requested) ? requested : null;
      const data = await requestJson(`/api/admin/agent/community/reviews${focusedId ? `?id=${encodeURIComponent(focusedId)}` : ""}`) as ReviewResponse;
      if (!Array.isArray(data.reviews) || !data.reviews.every(isReview)
        || (data.discordMode !== "buttons" && data.discordMode !== "review_link")) {
        throw new Error("invalid_review_response");
      }
      setReviews(data.reviews);
      setDiscordMode(data.discordMode);
    } catch {
      setReviews([]);
      setError("승인 대기 초안을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const operate = async (action: "approve" | "reject" | "process" | "notify", id?: string) => {
    setBusy(id ? `${action}:${id}` : action);
    setError(null);
    setMessage(null);
    try {
      const data = await requestJson("/api/admin/agent/community/reviews", {
        method: "POST",
        body: JSON.stringify(id ? { action, id } : { action }),
      }) as OperationResponse;
      setMessage(operationMessage(data));
      await load();
    } catch {
      setError("검토 요청을 처리하지 못했습니다. 현재 상태를 다시 확인해주세요.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section id="community-reviews" aria-labelledby="community-review-heading" className="rounded-2xl border border-amber-500/30 bg-zinc-900 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wide text-amber-300">사람이 최종 결정</p>
          <h2 id="community-review-heading" className="mt-1 text-lg font-semibold">게시글·답글 승인 대기</h2>
          <p className="mt-1 text-sm leading-6 text-zinc-400">BGMS AI가 게시글과 답글을 먼저 초안으로 저장하고 Discord 알림을 보냅니다. 관리자가 여기서 승인해야 BGMS에 발행됩니다.</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" onClick={() => void operate("process")} disabled={busy !== null} className="min-h-11 rounded-lg border border-amber-500/40 px-3 py-2 text-sm font-semibold text-amber-200 disabled:opacity-50">{busy === "process" ? "초안 확인 중…" : "새 초안 확인"}</button>
          <button type="button" onClick={() => void operate("notify")} disabled={busy !== null} className="min-h-11 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 disabled:opacity-50">{busy === "notify" ? "알림 전송 중…" : "Discord 알림 다시 보내기"}</button>
          <button type="button" onClick={() => void load()} disabled={busy !== null || loading} className="min-h-11 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-300 disabled:opacity-50">새로고침</button>
        </div>
      </div>

      <p className="mt-3 rounded-lg bg-zinc-950/70 px-3 py-2 text-xs leading-5 text-zinc-400">
        {discordMode === "buttons"
          ? "Discord 봇 버튼과 이 관리자 화면에서 승인·거절할 수 있습니다. 어느 쪽에서 처리해도 저장된 최신 상태를 다시 확인합니다."
          : "현재 Discord 알림은 로그인한 관리자 검토 페이지 링크를 엽니다. 실제 Discord 승인·거절 버튼은 봇 설정을 마친 뒤 사용할 수 있습니다."}
      </p>

      {message && <p role="status" aria-live="polite" className="mt-3 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm leading-6 text-emerald-200">{message}</p>}
      {error && <p role="alert" className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm leading-6 text-rose-200">{error}</p>}

      {loading ? <p className="mt-4 text-sm text-zinc-400">승인 대기 초안을 확인하고 있습니다.</p> : reviews.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-zinc-700 px-3 py-5 text-center text-sm text-zinc-400">표시할 초안이 없습니다.</p>
      ) : (
        <div className="mt-4 space-y-4">
          {reviews.map((review) => <ReviewCard key={review.id} review={review} busy={busy} onAction={operate} />)}
        </div>
      )}
    </section>
  );
}

function ReviewCard({
  review,
  busy,
  onAction,
}: {
  review: CommunityReview;
  busy: string | null;
  onAction: (action: "approve" | "reject", id: string) => Promise<void>;
}) {
  const pending = review.status === "pending";
  const postId = review.result_post_id ?? review.target_post_id;
  const sanitized = review.kind === "post" ? sanitizeBoardHtml(review.body) : "";

  return (
    <article data-testid={`community-review-${review.id}`} className="min-w-0 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950/60 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-200">{review.kind === "post" ? "게시글" : "댓글 답글"}</span>
            <span className="rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-300">{STATUS_TEXT[review.status]}</span>
            {review.category && <span className="text-xs text-zinc-500">{review.category}</span>}
          </div>
          <h3 className="mt-2 break-words font-semibold text-zinc-100">{review.title || "제목 없음"}</h3>
          <p className="mt-1 text-xs text-zinc-500">작성자 BGMS AI · 생성 {formattedDate(review.created_at)} · 검토 기한 {formattedDate(review.expires_at)}</p>
        </div>
        {postId !== null && <Link href={`/board/${postId}`} className="w-fit shrink-0 text-sm text-amber-200 underline underline-offset-4">게시글 열기</Link>}
      </div>

      {review.kind === "reply" && (review.target_comment_author || review.target_comment_content) && (
        <div className="mt-4 border-l-2 border-zinc-700 pl-3">
          <p className="text-xs font-medium text-zinc-500">원래 댓글{review.target_comment_author ? ` · ${review.target_comment_author}` : ""}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-zinc-300">{review.target_comment_content || "내용 없음"}</p>
        </div>
      )}

      <div className="mt-4">
        <p className="text-xs font-medium text-zinc-500">{review.kind === "post" ? "게시글 초안" : "답글 초안"}</p>
        {review.kind === "post" ? (
          <div className="board-content mt-2 min-w-0 overflow-x-auto break-words text-sm leading-7 text-zinc-200" dangerouslySetInnerHTML={{ __html: sanitized }} />
        ) : (
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-zinc-200">{review.body || "초안 내용 없음"}</p>
        )}
      </div>

      {review.reason && <p className="mt-3 break-words text-sm text-amber-200">사유: {review.reason}</p>}
      {review.notification_error && <p className="mt-2 break-words text-sm text-rose-300">Discord 알림 오류: {review.notification_error}</p>}
      {review.discord_message_id && <p className="mt-2 text-xs text-zinc-500">Discord 알림 전송 완료</p>}

      {pending && (
        <div className="mt-4 flex flex-col gap-2 border-t border-zinc-800 pt-4 sm:flex-row sm:justify-end">
          <button type="button" onClick={() => void onAction("reject", review.id)} disabled={busy !== null} className="min-h-11 rounded-lg border border-rose-500/40 px-4 py-2 text-sm font-semibold text-rose-200 disabled:opacity-50">{busy === `reject:${review.id}` ? "거절 중…" : "거절"}</button>
          <button type="button" onClick={() => void onAction("approve", review.id)} disabled={busy !== null} className="min-h-11 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-bold text-zinc-950 disabled:opacity-50">{busy === `approve:${review.id}` ? "승인 중…" : "승인 후 발행"}</button>
        </div>
      )}
      {review.status === "published" && review.result_comment_id && <p className="mt-3 text-xs text-emerald-300">답글 #{review.result_comment_id} 발행 완료</p>}
    </article>
  );
}
