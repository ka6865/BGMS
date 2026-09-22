import type { SupportCategory } from "./contracts";
import type { SupportTicketRow } from "./ticketStore.server";

const DISCORD_NOTIFICATION_TIMEOUT_MS = 1_000;

const CATEGORY_LABELS: Record<SupportCategory, string> = {
  privacy: "전적 비공개",
  account: "계정/로그인",
  community: "커뮤니티",
  bug: "오류 신고",
  other: "기타",
};

/**
 * Sends a small operational alert after a ticket has already been persisted.
 * The ticket body and attachments intentionally never leave the support system.
 */
export async function notifySupportTicketCreated(
  ticket: Pick<SupportTicketRow, "id" | "category" | "subject">,
): Promise<void> {
  const webhookUrl = process.env.DISCORD_SUPPORT_WEBHOOK_URL?.trim()
    || process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhookUrl) return;

  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const delivery = fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        allowed_mentions: { parse: [] },
        embeds: [{
          title: "📩 새 고객센터 1:1 문의",
          url: `${siteUrl}/admin/support`,
          color: 0xf2a900,
          fields: [
            {
              name: "문의 유형",
              value: CATEGORY_LABELS[ticket.category] || ticket.category,
              inline: true,
            },
            {
              name: "문의 ID",
              value: `\`${ticket.id}\``,
              inline: true,
            },
            {
              name: "제목",
              value: ticket.subject.trim().slice(0, 200) || "(제목 없음)",
              inline: false,
            },
          ],
          footer: { text: "BGMS 고객센터" },
          timestamp: new Date().toISOString(),
        }],
      }),
    }).catch(() => undefined);

    const timeout = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        resolve();
      }, DISCORD_NOTIFICATION_TIMEOUT_MS);
    });

    await Promise.race([delivery, timeout]);
  } catch {
    // Discord 전달 실패는 이미 커밋된 문의를 되돌리지 않는다.
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
