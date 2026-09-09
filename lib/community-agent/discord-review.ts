/**
 * Discord delivery and interaction helpers for community post/reply reviews.
 *
 * This module deliberately keeps the review shape independent from the
 * persistence implementation. `reviews.ts` owns the database transition;
 * this file only builds bounded Discord messages and sends them.
 */

export type ReviewKind = "post" | "reply";
export type ReviewStatus = "generating" | "pending" | "published" | "rejected" | "expired" | "failed";

export type Review = {
  id: string;
  kind: ReviewKind;
  status: ReviewStatus;
  title: string;
  /** HTML for posts and plain text for replies. */
  body: string;
  target_post_id: number | null;
  target_comment_id: number | null;
  target_comment_content: string | null;
  target_comment_author: string | null;
  discord_message_id: string | null;
  result_post_id: number | null;
  result_comment_id: number | null;
};

export type DiscordReviewMessage = {
  allowed_mentions: { parse: [] };
  embeds: Array<Record<string, unknown>>;
  components?: Array<Record<string, unknown>>;
};

type Attachment = { filename: string; content: string };

export type BuiltDiscordReviewMessage = {
  payload: DiscordReviewMessage;
  attachment: Attachment | null;
  detailsUrl: string;
};

const REVIEW_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNOWFLAKE = /^\d{17,20}$/;
const SAFE_TOKEN = /^[A-Za-z0-9._-]{20,200}$/;
const DISCORD_WEBHOOK_PATH = /^\/api\/webhooks\/(\d{17,20})\/([A-Za-z0-9._-]{20,200})$/;
const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com"]);
const MAX_EMBED_FIELD = 900;
const MAX_BODY_PREVIEW = 2_900;
const REQUEST_TIMEOUT_MS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE.test(value);
}

function validReviewId(value: unknown): value is string {
  return typeof value === "string" && REVIEW_UUID.test(value);
}

function bounded(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

function transportText(value: unknown): string {
  if (typeof value !== "string") return "";
  // Keep tabs/newlines in the full attachment. Other controls cannot carry
  // useful review content and can make a Discord payload ambiguous.
  return value.normalize("NFC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'");
}

/** Convert post HTML to the complete plain-text form used in attachments. */
export function toReviewPlainText(value: string): string {
  return decodeEntities(value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match: string, attributes: string, inner: string) => {
      const href = attributes.match(/\bhref\s*=\s*(?:["']([^"']*)["']|([^\s"'=<>`]+))/i);
      const url = href?.[1] ?? href?.[2];
      return url ? `${inner} (${url})` : inner;
    })
    .replace(/<[^>]*>/g, "")
    .replace(/[ \t\f\r]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

function configuredSiteOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.port) {
        return url.origin;
      }
    } catch {
      // Use the known public origin below. Configuration details must not leak.
    }
  }
  return "https://bgms.kr";
}

export function reviewDetailsUrl(reviewId: string): string {
  const id = validReviewId(reviewId) ? reviewId : "invalid";
  return `${configuredSiteOrigin()}/admin/bot?tab=community&review=${encodeURIComponent(id)}`;
}

function reviewLabel(review: Review): string {
  return review.kind === "post" ? "게시글" : "댓글 답글";
}

function statusLabel(status: ReviewStatus): string {
  switch (status) {
    case "published": return "발행됨";
    case "rejected": return "거절됨";
    case "expired": return "만료됨";
    case "failed": return "처리 실패";
    default: return "검토 대기";
  }
}

function notificationTitle(review: Review): string {
  const prefix = `BGMS AI ${reviewLabel(review)}`;
  return review.status === "pending" ? `${prefix} 승인 대기` : `${prefix} · ${statusLabel(review.status)}`;
}

function resultIdentifier(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function resultFields(review: Review): Array<Record<string, unknown>> {
  if (review.status !== "published") return [];
  const postId = resultIdentifier(review.result_post_id) ?? resultIdentifier(review.target_post_id);
  const commentId = resultIdentifier(review.result_comment_id);
  if (!postId && !commentId) return [];
  const postUrl = postId ? `${configuredSiteOrigin()}/board/${postId}` : null;
  const values: Array<Record<string, unknown>> = [];
  if (postUrl) values.push({ name: "발행 결과", value: `[게시글 열기](${postUrl})`, inline: false });
  if (commentId) {
    values.push({
      name: "등록된 답글",
      value: postUrl ? `댓글 #${commentId} · [게시글에서 확인](${postUrl}#comment-${commentId})` : `댓글 #${commentId}`,
      inline: false,
    });
  }
  return values;
}

function fullReviewText(review: Review): string {
  const title = bounded(review.title, 256) || "(제목 없음)";
  const body = review.kind === "post" ? toReviewPlainText(transportText(review.body)) : transportText(review.body);
  const commentAuthor = transportText(review.target_comment_author);
  const commentContent = transportText(review.target_comment_content);
  const lines = [
    `BGMS AI ${reviewLabel(review)} ${statusLabel(review.status)}`,
    `검토 ID: ${review.id}`,
    `제목: ${title}`,
  ];
  if (commentAuthor || commentContent) {
    lines.push("", "대상 댓글");
    if (commentAuthor) lines.push(`작성자: ${commentAuthor}`);
    if (commentContent) lines.push(commentContent);
  }
  lines.push("", "초안 본문", body);
  const postId = resultIdentifier(review.result_post_id) ?? resultIdentifier(review.target_post_id);
  const commentId = resultIdentifier(review.result_comment_id);
  if (review.status === "published" && (postId || commentId)) {
    lines.push("", "발행 결과");
    if (postId) lines.push(`게시글: ${configuredSiteOrigin()}/board/${postId}`);
    if (commentId) lines.push(`답글 ID: ${commentId}`);
  }
  return `${lines.join("\n")}\n`;
}

function preview(value: string, max = MAX_EMBED_FIELD): string {
  if (value.length <= max) return value || "(내용 없음)";
  return `${value.slice(0, Math.max(0, max - 16)).trimEnd()} …(첨부 참조)`;
}

function reviewComponents(reviewId: string, detailsUrl: string, disabled = false): Array<Record<string, unknown>> {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "승인", custom_id: `community:approve:${reviewId}`, ...(disabled ? { disabled: true } : {}) },
      { type: 2, style: 4, label: "거절", custom_id: `community:reject:${reviewId}`, ...(disabled ? { disabled: true } : {}) },
      { type: 2, style: 5, label: "검토 페이지", url: detailsUrl },
    ],
  }];
}

/** Build the bot/webhook payload. Long drafts always retain a complete attachment. */
export function buildReviewNotification(review: Review): BuiltDiscordReviewMessage {
  if (!validReviewId(review.id)) throw new Error("discord_review_invalid");
  const detailsUrl = reviewDetailsUrl(review.id);
  const boundedBody = bounded(review.body, 200_000);
  const body = review.kind === "post" ? toReviewPlainText(boundedBody) : boundedBody.trim();
  const targetComment = bounded(review.target_comment_content, 200_000).trim();
  const targetAuthor = bounded(review.target_comment_author, 200);
  const needsAttachment = body.length > MAX_BODY_PREVIEW || targetComment.length > MAX_EMBED_FIELD;
  const bodyDescription = needsAttachment
    ? `${preview(body, MAX_BODY_PREVIEW)}\n\n전체 초안과 대상 댓글은 첨부 파일에서 확인하세요.`
    : preview(body, MAX_BODY_PREVIEW);
  const fields: Array<Record<string, unknown>> = [
    { name: "제목", value: preview(bounded(review.title, 256), 256), inline: false },
  ];
  if (targetAuthor || targetComment) {
    fields.push({ name: targetAuthor ? `대상 댓글 · ${targetAuthor}` : "대상 댓글", value: preview(targetComment), inline: false });
  }
  fields.push({ name: "관리자 검토", value: `[검토 페이지](${detailsUrl})`, inline: false });
  fields.push(...resultFields(review));
  const payload: DiscordReviewMessage = {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: notificationTitle(review),
      description: bodyDescription,
      color: 0xf2a900,
      fields,
      footer: { text: "BGMS AI 비서" },
      timestamp: new Date().toISOString(),
    }],
    components: review.status === "pending"
      ? reviewComponents(review.id, detailsUrl)
      : disabledReviewComponents(review.id),
  };
  return {
    payload,
    attachment: needsAttachment ? {
      filename: `community-review-${review.id}.txt`,
      content: fullReviewText(review),
    } : null,
    detailsUrl,
  };
}

function parseWebhookUrl(value: unknown): URL | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port || !DISCORD_HOSTS.has(url.hostname.toLowerCase())) {
      return null;
    }
    const match = url.pathname.match(DISCORD_WEBHOOK_PATH);
    if (!match) return null;
    // A webhook's URL token is intentionally retained only in this local URL object.
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function reviewWebhookUrl(): URL | null {
  return parseWebhookUrl(process.env.DISCORD_COMMUNITY_REVIEW_WEBHOOK_URL)
    ?? parseWebhookUrl(process.env.DISCORD_WEBHOOK_URL);
}

function explicitReviewChannelId(): string | null | undefined {
  const configured = process.env.DISCORD_COMMUNITY_REVIEW_CHANNEL_ID?.trim();
  if (!configured) return undefined;
  return isSnowflake(configured) ? configured : null;
}

function validBotToken(): string | null {
  const token = process.env.DISCORD_BOT_TOKEN?.trim() || "";
  return SAFE_TOKEN.test(token) ? token : null;
}

type Timeout = { signal: AbortSignal; cleanup: () => void };

function timeoutSignal(): Timeout {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("discord_review_timeout")), REQUEST_TIMEOUT_MS);
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

async function discordRequest(url: URL, init: RequestInit): Promise<Response> {
  const timeout = timeoutSignal();
  try {
    return await fetch(url, { redirect: "error", ...init, signal: timeout.signal });
  } catch {
    throw new Error("discord_review_request_failed");
  } finally {
    timeout.cleanup();
  }
}

async function jsonBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function messageId(response: Response): Promise<string> {
  const value = await jsonBody(response);
  if (!response.ok || !isSnowflake(value?.id)) throw new Error("discord_review_send_failed");
  return value.id;
}

/** Resolve the configured channel, using webhook metadata only when no channel is explicit. */
export async function resolveReviewChannelId(): Promise<string | null> {
  const configured = explicitReviewChannelId();
  if (configured !== undefined) return configured;
  const webhook = reviewWebhookUrl();
  if (!webhook) return null;
  try {
    const response = await discordRequest(webhook, { method: "GET" });
    const value = await jsonBody(response);
    return response.ok && isSnowflake(value?.channel_id) ? value.channel_id : null;
  } catch {
    return null;
  }
}

async function sendBotMessage(built: BuiltDiscordReviewMessage, channelId: string, token: string): Promise<string> {
  const url = new URL(`/api/v10/channels/${channelId}/messages`, "https://discord.com");
  let init: RequestInit;
  if (built.attachment) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(built.payload));
    form.append("files[0]", new Blob([built.attachment.content], { type: "text/plain;charset=utf-8" }), built.attachment.filename);
    init = { method: "POST", headers: { Authorization: `Bot ${token}` }, body: form };
  } else {
    init = {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(built.payload),
    };
  }
  return messageId(await discordRequest(url, init));
}

async function sendWebhookMessage(built: BuiltDiscordReviewMessage): Promise<string> {
  const webhook = reviewWebhookUrl();
  if (!webhook) throw new Error("discord_review_not_configured");
  webhook.searchParams.set("wait", "true");
  // Fallback notifications intentionally have no custom buttons: the link is an
  // authenticated admin page and cannot be forged into a functional callback.
  const payload: DiscordReviewMessage = { ...built.payload, components: undefined };
  let init: RequestInit;
  if (built.attachment) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    form.append("files[0]", new Blob([built.attachment.content], { type: "text/plain;charset=utf-8" }), built.attachment.filename);
    init = { method: "POST", body: form };
  } else {
    init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
  }
  return messageId(await discordRequest(webhook, init));
}

function updatePayload(review: Review): DiscordReviewMessage {
  const built = buildReviewNotification(review);
  const originalEmbed = built.payload.embeds[0] ?? {};
  const terminal = ["published", "rejected", "expired", "failed"].includes(review.status);
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      ...originalEmbed,
      title: originalEmbed.title ?? notificationTitle(review),
      description: terminal
        ? `${originalEmbed.description ?? ""}\n\n상태: ${statusLabel(review.status)}`.trim()
        : originalEmbed.description,
    }],
    components: terminal ? disabledReviewComponents(review.id) : built.payload.components,
  };
}

async function updateBotMessage(review: Review, channelId: string, token: string): Promise<void> {
  if (!isSnowflake(review.discord_message_id)) throw new Error("discord_review_message_missing");
  const url = new URL(`/api/v10/channels/${channelId}/messages/${review.discord_message_id}`, "https://discord.com");
  const response = await discordRequest(url, {
    method: "PATCH",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(updatePayload(review)),
  });
  if (!response.ok) throw new Error("discord_review_update_failed");
}

async function updateWebhookMessage(review: Review): Promise<void> {
  if (!isSnowflake(review.discord_message_id)) throw new Error("discord_review_message_missing");
  const webhook = reviewWebhookUrl();
  if (!webhook) throw new Error("discord_review_not_configured");
  webhook.pathname = `${webhook.pathname}/messages/${review.discord_message_id}`;
  webhook.search = "";
  const payload = updatePayload(review);
  const response = await discordRequest(webhook, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, components: undefined }),
  });
  if (!response.ok) throw new Error("discord_review_update_failed");
}

/**
 * Send a pending review through the real bot when fully configured; otherwise
 * use the existing admin webhook and a review-page link.
 */
export async function sendReviewNotification(review: Review): Promise<{ messageId: string }> {
  const built = buildReviewNotification(review);
  const token = validBotToken();
  const approver = process.env.DISCORD_COMMUNITY_APPROVER_ID?.trim() || "";
  const channel = token && isSnowflake(approver) ? await resolveReviewChannelId() : null;
  if (token && isSnowflake(approver) && channel) {
    return { messageId: await sendBotMessage(built, channel, token) };
  }
  return { messageId: await sendWebhookMessage(built) };
}

/** Update the persisted Discord message after a terminal web or Discord decision. */
export async function updateReviewNotification(review: Review): Promise<void> {
  if (!validReviewId(review.id)) throw new Error("discord_review_invalid");
  if (!isSnowflake(review.discord_message_id)) throw new Error("discord_review_message_missing");
  const token = validBotToken();
  const approver = process.env.DISCORD_COMMUNITY_APPROVER_ID?.trim() || "";
  const channel = token && isSnowflake(approver) ? await resolveReviewChannelId() : null;
  if (token && isSnowflake(approver) && channel) {
    await updateBotMessage(review, channel, token);
    return;
  }
  await updateWebhookMessage(review);
}

/** Build the same button row with terminal decision buttons disabled. */
export function disabledReviewComponents(reviewId: string): Array<Record<string, unknown>> {
  if (!validReviewId(reviewId)) return [];
  return reviewComponents(reviewId, reviewDetailsUrl(reviewId), true);
}

export function isReviewId(value: unknown): value is string {
  return validReviewId(value);
}

export function isDiscordSnowflake(value: unknown): value is string {
  return isSnowflake(value);
}

export function isDiscordInteractionToken(value: unknown): value is string {
  return typeof value === "string" && SAFE_TOKEN.test(value);
}
