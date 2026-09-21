import type {
  SupportCategory,
  SupportDb,
  SupportTicketStatus,
  SupportVerificationStatus,
} from "./contracts";

const TICKET_COLUMNS = [
  "id",
  "requester_id",
  "category",
  "subject",
  "status",
  "verification_status",
  "target_platform",
  "target_nickname",
  "target_account_id",
  "target_resolved_nickname",
  "target_resolved_at",
  "last_message_at",
  "last_message_sender",
  "user_last_read_at",
  "admin_last_read_at",
  "resolved_at",
  "created_at",
  "updated_at",
].join(",");
const MESSAGE_COLUMNS = "id,ticket_id,sender_id,sender_type,body,created_at";
const ATTACHMENT_COLUMNS = "id,ticket_id,message_id,original_name,mime_type,byte_size,status,expires_at,created_at,deleted_at";
const EVENT_COLUMNS = "id,ticket_id,actor_id,event_type,from_status,to_status,metadata,created_at";

export type SupportActor = { userId: string; isAdmin: boolean };

export type SupportTicketRow = {
  id: string;
  requester_id: string | null;
  category: SupportCategory;
  subject: string;
  status: SupportTicketStatus;
  verification_status: SupportVerificationStatus;
  target_platform?: string | null;
  target_nickname?: string | null;
  target_account_id?: string | null;
  target_resolved_nickname?: string | null;
  target_resolved_at?: string | null;
  last_message_at: string;
  last_message_sender: "user" | "admin";
  user_last_read_at?: string | null;
  admin_last_read_at?: string | null;
  resolved_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type SupportTicketSummary = SupportTicketRow & { unread: boolean };

export type SupportMessageRow = {
  id: string;
  ticket_id: string;
  sender_id: string | null;
  sender_type: "user" | "admin";
  body: string;
  created_at: string;
};

export type SupportAttachmentView = {
  id: string;
  ticket_id: string | null;
  message_id: string | null;
  original_name: string;
  mime_type: string;
  byte_size: number;
  status: "pending" | "ready" | "deleted";
  expires_at: string | null;
  created_at: string;
  deleted_at: string | null;
};

export type SupportTicketEventRow = {
  id: string;
  ticket_id: string;
  actor_id: string | null;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type SupportTicketDetail = SupportTicketRow & {
  messages: SupportMessageRow[];
  attachments: SupportAttachmentView[];
  events: SupportTicketEventRow[];
};

export type CreateSupportTicketStoreInput = {
  requesterId: string;
  category: SupportCategory;
  subject: string;
  body: string;
  verificationStatus: SupportVerificationStatus;
  targetPlatform: string | null;
  targetNickname: string | null;
  targetAccountId: string | null;
  targetResolvedNickname: string | null;
  attachmentIds: string[];
};

export type AppendSupportMessageInput = {
  ticketId: string;
  actor: SupportActor;
  senderType: "user" | "admin";
  body: string;
};

export class SupportStoreError extends Error {
  readonly code: "not_found" | "forbidden" | "database" | "duplicate";

  constructor(code: SupportStoreError["code"], message: string = code) {
    super(message);
    this.name = "SupportStoreError";
    this.code = code;
  }
}

type QueryResult<T> = { data: T; error: { message?: string; code?: string } | null };

function throwDatabaseError(error: { message?: string; code?: string } | null): void {
  if (!error) return;
  if (error.code === "23505" || error.message?.includes("support_ticket_duplicate")) {
    throw new SupportStoreError("duplicate", "support_ticket_duplicate");
  }
  throw new SupportStoreError("database", "support_store_database_error");
}

function isAdmin(actor: SupportActor): boolean {
  return actor.isAdmin;
}

function isUnread(row: SupportTicketRow, viewer: "user" | "admin"): boolean {
  if (row.last_message_sender !== (viewer === "user" ? "admin" : "user")) return false;
  const readAt = viewer === "user" ? row.user_last_read_at : row.admin_last_read_at;
  return !readAt || new Date(row.last_message_at).getTime() > new Date(readAt).getTime();
}

async function readTicket(db: SupportDb, ticketId: string): Promise<SupportTicketRow | null> {
  const result = await (db as any)
    .from("support_tickets")
    .select(TICKET_COLUMNS)
    .eq("id", ticketId)
    .maybeSingle() as QueryResult<SupportTicketRow | null>;
  throwDatabaseError(result.error);
  return result.data;
}

async function readRows<T>(query: unknown): Promise<QueryResult<T>> {
  return await query as QueryResult<T>;
}

export async function createSupportTicket(
  db: SupportDb,
  input: CreateSupportTicketStoreInput,
): Promise<SupportTicketRow> {
  const result = await (db as any).rpc("create_support_ticket", {
    p_requester_id: input.requesterId,
    p_category: input.category,
    p_subject: input.subject,
    p_body: input.body,
    p_verification_status: input.verificationStatus,
    p_target_platform: input.targetPlatform,
    p_target_nickname: input.targetNickname,
    p_target_account_id: input.targetAccountId,
    p_target_resolved_nickname: input.targetResolvedNickname,
    p_attachment_ids: input.attachmentIds,
  }) as QueryResult<string | null>;
  throwDatabaseError(result.error);
  if (!result.data) throw new SupportStoreError("database", "support_ticket_missing_after_create");
  const ticket = await readTicket(db, result.data);
  if (!ticket) throw new SupportStoreError("database", "support_ticket_missing_after_create");
  return ticket;
}

export async function getSupportTicketForActor(
  db: SupportDb,
  ticketId: string,
  actor: SupportActor,
): Promise<SupportTicketDetail | null> {
  const ticket = await readTicket(db, ticketId);
  if (!ticket || (!isAdmin(actor) && ticket.requester_id !== actor.userId)) return null;

  const [messagesResult, attachmentsResult, eventsResult] = await Promise.all([
    readRows<SupportMessageRow[]>((db as any)
      .from("support_messages")
      .select(MESSAGE_COLUMNS)
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true })),
    readRows<SupportAttachmentView[]>((db as any)
      .from("support_attachments")
      .select(ATTACHMENT_COLUMNS)
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true })),
    isAdmin(actor)
      ? readRows<SupportTicketEventRow[]>((db as any)
        .from("support_ticket_events")
        .select(EVENT_COLUMNS)
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true }))
      : Promise.resolve({ data: [], error: null } as QueryResult<SupportTicketEventRow[]>),
  ]);
  throwDatabaseError(messagesResult.error);
  throwDatabaseError(attachmentsResult.error);
  throwDatabaseError(eventsResult.error);

  const readColumn = isAdmin(actor) ? "admin_last_read_at" : "user_last_read_at";
  await (db as any).from("support_tickets").update({ [readColumn]: new Date().toISOString() }).eq("id", ticketId);

  return {
    ...ticket,
    messages: messagesResult.data ?? [],
    attachments: attachmentsResult.data ?? [],
    events: isAdmin(actor) ? eventsResult.data ?? [] : [],
  };
}

export async function listSupportTicketsForUser(
  db: SupportDb,
  userId: string,
): Promise<SupportTicketSummary[]> {
  const result = await readRows<SupportTicketRow[]>((db as any)
    .from("support_tickets")
    .select(TICKET_COLUMNS)
    .eq("requester_id", userId)
    .order("updated_at", { ascending: false }));
  throwDatabaseError(result.error);
  return (result.data ?? []).map((row) => ({ ...row, unread: isUnread(row, "user") }));
}

export async function listSupportTicketsForAdmin(
  db: SupportDb,
  filters: { status?: SupportTicketStatus; category?: SupportCategory; q?: string } = {},
): Promise<SupportTicketSummary[]> {
  let query = (db as any)
    .from("support_tickets")
    .select(TICKET_COLUMNS)
    .order("last_message_at", { ascending: true });
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.q?.trim()) {
    const escaped = filters.q.trim().slice(0, 100).replace(/[\\%_]/g, "\\$&");
    query = query.ilike("subject", `%${escaped}%`);
  }
  const result = await readRows<SupportTicketRow[]>(query);
  throwDatabaseError(result.error);
  return (result.data ?? []).map((row) => ({ ...row, unread: isUnread(row, "admin") }));
}

export async function appendSupportMessage(
  db: SupportDb,
  input: AppendSupportMessageInput,
): Promise<SupportMessageRow> {
  const ticket = await readTicket(db, input.ticketId);
  if (!ticket) throw new SupportStoreError("not_found", "support_ticket_not_found");
  if (!input.actor.isAdmin && ticket.requester_id !== input.actor.userId) {
    throw new SupportStoreError("forbidden", "support_ticket_forbidden");
  }
  if ((input.senderType === "admin") !== input.actor.isAdmin) {
    throw new SupportStoreError("forbidden", "support_message_sender_forbidden");
  }

  const now = new Date().toISOString();
  const nextStatus = input.senderType === "user"
    ? (["awaiting_user", "answered", "resolved", "rejected"] as string[]).includes(ticket.status)
      ? "in_progress"
      : ticket.status
    : (["new", "in_progress", "awaiting_user"] as string[]).includes(ticket.status)
      ? "answered"
      : ticket.status;
  const readColumn = input.senderType === "user" ? "user_last_read_at" : "admin_last_read_at";

  const messageResult = await (db as any)
    .from("support_messages")
    .insert({
      ticket_id: input.ticketId,
      sender_id: input.actor.userId,
      sender_type: input.senderType,
      body: input.body.trim(),
    })
    .select(MESSAGE_COLUMNS)
    .single() as QueryResult<SupportMessageRow | null>;
  throwDatabaseError(messageResult.error);
  if (!messageResult.data) throw new SupportStoreError("database", "support_message_missing_after_insert");

  const updateResult = await (db as any)
    .from("support_tickets")
    .update({
      status: nextStatus,
      last_message_at: now,
      last_message_sender: input.senderType,
      [readColumn]: now,
      ...(nextStatus === "resolved" || nextStatus === "rejected" ? { resolved_at: now } : {}),
    })
    .eq("id", input.ticketId) as QueryResult<unknown>;
  throwDatabaseError(updateResult?.error ?? null);
  return messageResult.data;
}
