import { addPrivatePlayer, getPrivatePlayersList, type PrivatePlayer } from "@/lib/pubg/privatePlayers";
import type { SupportDb } from "./contracts";

export class SupportPrivacyActionError extends Error {
  readonly code: "not_found" | "not_verified" | "invalid_target" | "invalid_status" | "database";

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
  resolved_at: string | null;
};

function alreadyRegistered(list: PrivatePlayer[], ticket: PrivacyTicket): boolean {
  const platform = ticket.target_platform?.toLowerCase();
  const accountId = ticket.target_account_id?.trim();
  if (!platform || !accountId) return false;
  return list.some((row) => (
    (row.platform.toLowerCase() === platform || row.platform.toLowerCase() === "all")
    && row.account_id === accountId
  ));
}

async function readTicket(db: SupportDb, ticketId: string): Promise<PrivacyTicket | null> {
  const { data, error } = await (db as any)
    .from("support_tickets")
    .select("id,requester_id,category,status,verification_status,target_platform,target_nickname,target_account_id,target_resolved_nickname,resolved_at")
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
  const actionRpc = (input.db as any).rpc;
  if (typeof actionRpc === "function") {
    let result: { data: { outcome?: string; code?: string } | null; error: { message?: string } | null };
    try {
      result = await actionRpc("apply_support_privacy_action", {
        p_ticket_id: input.ticketId,
        p_actor_id: input.actorId,
      });
    } catch {
      throw new SupportPrivacyActionError("database");
    }
    if (result.error) throw new SupportPrivacyActionError("database");
    if (result.data?.code === "not_found") throw new SupportPrivacyActionError("not_found");
    if (result.data?.code === "not_verified") throw new SupportPrivacyActionError("not_verified");
    if (result.data?.code === "invalid_target") throw new SupportPrivacyActionError("invalid_target");
    if (result.data?.code === "invalid_status") throw new SupportPrivacyActionError("invalid_status");
    if (result.data?.outcome === "registered" || result.data?.outcome === "already_registered") {
      return { outcome: result.data.outcome };
    }
    throw new SupportPrivacyActionError("database");
  }
  const ticket = await readTicket(input.db, input.ticketId);
  if (!ticket) throw new SupportPrivacyActionError("not_found");
  if (ticket.category !== "privacy" || ticket.verification_status !== "verified") {
    throw new SupportPrivacyActionError("not_verified");
  }
  if (!ticket.target_platform || !ticket.target_account_id || !(ticket.target_resolved_nickname || ticket.target_nickname)) {
    throw new SupportPrivacyActionError("invalid_target");
  }

  const before = await getPrivatePlayersList();
  let outcome: "registered" | "already_registered" = alreadyRegistered(before, ticket) ? "already_registered" : "registered";
  if (outcome === "registered") {
    await addPrivatePlayer(
      ticket.target_platform,
      ticket.target_resolved_nickname || ticket.target_nickname!,
      ticket.target_account_id,
    );
  }

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
  if (eventResult?.error) {
    if (eventResult.error.code !== "23505") throw new SupportPrivacyActionError("database");
    // Another verified ticket may have registered the same account between the
    // initial read and the atomic private-player write. The unique event turns
    // that race into the correct idempotent outcome.
    if (outcome === "registered") outcome = "already_registered";
  }

  const isTransitioningToResolved = ticket.status !== "resolved";
  const updateResult = isTransitioningToResolved
    ? await (input.db as any)
      .from("support_tickets")
      .update({ status: "resolved", resolved_at: ticket.resolved_at ?? new Date().toISOString() })
      .eq("id", input.ticketId)
    : { error: null };
  if (updateResult?.error) throw new SupportPrivacyActionError("database");
  if (isTransitioningToResolved) {
    const statusEvent = await (input.db as any)
      .from("support_ticket_events")
      .insert({
        ticket_id: input.ticketId,
        actor_id: input.actorId,
        event_type: "status_changed",
        from_status: ticket.status,
        to_status: "resolved",
        metadata: { reason: "privacy_action", outcome },
      });
    if (statusEvent?.error) throw new SupportPrivacyActionError("database");
  }
  return { outcome };
}
