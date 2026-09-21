import type { SupportDb } from "./contracts";

export async function createSupportReplyNotification(
  db: SupportDb,
  input: { ticketId: string; messageId: string; requesterId: string; adminId: string; previewText: string },
): Promise<void> {
  const result = await (db as any)
    .from("notifications")
    .insert({
      user_id: input.requesterId,
      sender_id: input.adminId,
      sender_name: "관리자",
      type: "support_reply",
      post_id: null,
      support_ticket_id: input.ticketId,
      support_message_id: input.messageId,
      preview_text: input.previewText.slice(0, 200),
    });
  if (result?.error && result.error.code !== "23505") throw new Error("support_notification_failed");
}
