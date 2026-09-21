import { addPrivatePlayer, getPrivatePlayersList, type PrivatePlayer } from "@/lib/pubg/privatePlayers";
import type { SupportDb } from "./contracts";

export class SupportPrivacyActionError extends Error {
  readonly code: "not_found" | "not_verified" | "invalid_target" | "database";

  constructor(code: SupportPrivacyActionError["code"]) {
    super(code);
    this.name = "SupportPrivacyActionError";
    this.code = code;
  }
}

type PrivacyTicket = {
  id: string;
  requester_id: string | null;
  category: string;
  status: string;
  verification_status: string;
  target_platform: string | null;
  target_nickname: string | null;
  target_account_id: string | null;
  target_resolved_nickname: string | null;
};

function alreadyRegistered(list: PrivatePlayer[], ticket: PrivacyTicket): boolean {
  const platform = ticket.target_platform?.toLowerCase();
  const accountId = ticket.target_account_id?.trim();
  const nickname = ticket.target_resolved_nickname?.trim() || ticket.target_nickname?.trim();
  if (!platform || !nickname) return false;
  return list.some((row) => (
    (row.platform.toLowerCase() === platform || row.platform.toLowerCase() === "all")
    && ((accountId && row.account_id === accountId) || row.lower_nickname === nickname.toLowerCase())
  ));
}

async function readTicket(db: SupportDb, ticketId: string): Promise<PrivacyTicket | null> {
  const { data, error } = await (db as any)
    .from("support_tickets")
    .select("id,requester_id,category,status,verification_status,target_platform,target_nickname,target_account_id,target_resolved_nickname")
    .eq("id", ticketId)
    .maybeSingle();
  if (error) throw new SupportPrivacyActionError("database");
  return data as PrivacyTicket | null;
}

export async function applySupportPrivacyAction(input: {
  ticketId: string;
  actorId: string;
  db: SupportDb;
}): Promise<{ outcome: "registered" | "already_registered" }> {
  const ticket = await readTicket(input.db, input.ticketId);
  if (!ticket) throw new SupportPrivacyActionError("not_found");
  if (ticket.category !== "privacy" || ticket.verification_status !== "verified") {
    throw new SupportPrivacyActionError("not_verified");
  }
  if (!ticket.target_platform || !ticket.target_account_id || !(ticket.target_resolved_nickname || ticket.target_nickname)) {
    throw new SupportPrivacyActionError("invalid_target");
  }

  const before = await getPrivatePlayersList();
  const outcome = alreadyRegistered(before, ticket) ? "already_registered" : "registered";
  await addPrivatePlayer(
    ticket.target_platform,
    ticket.target_resolved_nickname || ticket.target_nickname!,
    ticket.target_account_id,
  );

  const eventType = outcome === "registered"
    ? "privacy_player_registered"
    : "privacy_player_already_registered";
  const eventResult = await (input.db as any)
    .from("support_ticket_events")
    .insert({
      ticket_id: input.ticketId,
      actor_id: input.actorId,
      event_type: eventType,
      metadata: { account_id: ticket.target_account_id, outcome },
    });
  if (eventResult?.error && eventResult.error.code !== "23505") {
    throw new SupportPrivacyActionError("database");
  }

  const updateResult = await (input.db as any)
    .from("support_tickets")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("id", input.ticketId);
  if (updateResult?.error) throw new SupportPrivacyActionError("database");
  return { outcome };
}
