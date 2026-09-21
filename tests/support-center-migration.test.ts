import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../supabase/migrations/20260921100000_support_center.sql", import.meta.url),
  "utf8",
);

describe("support center migration contract", () => {
  it("creates private support tables and refuses public storage reads", () => {
    expect(migration).toMatch(/create table(?: if not exists)? public\.support_tickets/i);
    expect(migration).toMatch(/create table(?: if not exists)? public\.support_messages/i);
    expect(migration).toMatch(/insert into storage\.buckets[\s\S]*support-evidence[\s\S]*false/i);
    expect(migration).toMatch(/support_ticket_id uuid/i);
    expect(migration).toMatch(/alter table public\.support_attachments enable row level security/i);
    expect(migration).not.toMatch(/support-evidence[\s\S]*public\s*[,=]\s*true/i);
  });

  it("keeps pre-ticket attachments unlinked and exposes an atomic ticket RPC", () => {
    expect(migration).toMatch(/ticket_id uuid references public\.support_tickets/i);
    expect(migration).toMatch(/create or replace function public\.create_support_ticket\(/i);
    expect(migration).toMatch(/ticket_id\s+is\s+null[\s\S]*uploader_id\s*=\s*p_requester_id/i);
    expect(migration).toMatch(/revoke all on function public\.create_support_ticket/i);
    expect(migration).toMatch(/support_ticket_privacy_action_once_idx/i);
  });
});
