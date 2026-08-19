import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve("supabase/migrations/20260819115023_profile_linked_pubg_auto_sync.sql"),
  "utf8",
);

describe("linked player sync migration contract", () => {
  it("creates a service-role-only state table with RLS", () => {
    expect(MIGRATION).toContain("create table");
    expect(MIGRATION).toContain("pubg_linked_player_sync_state");
    expect(MIGRATION).toContain("primary key (platform, normalized_nickname)");
    expect(MIGRATION).toContain("enable row level security");
    expect(MIGRATION).toContain("revoke all");
    expect(MIGRATION).toContain("to service_role");
  });

  it("exposes only invoker RPCs for list, claim, and completion", () => {
    expect(MIGRATION).toContain("security invoker");
    expect(MIGRATION).toContain("list_pubg_linked_sync_candidates");
    expect(MIGRATION).toContain("claim_pubg_linked_sync");
    expect(MIGRATION).toContain("complete_pubg_linked_sync");
  });

  it("keeps identity grouping, activity eligibility, ordering, and lease guards in SQL", () => {
    expect(MIGRATION).toContain("max(profile.last_active_at)");
    expect(MIGRATION).toContain("group by");
    expect(MIGRATION).toContain("pubg_nickname");
    expect(MIGRATION).toContain("pubg_nickname is not null");
    expect(MIGRATION).toContain("last_active_at >= p_active_since");
    expect(MIGRATION).toContain("last_success_at nulls first");
    expect(MIGRATION).toContain("lease_expires_at <= now()");
    expect(MIGRATION).toContain("lease_token = p_lease_token");
  });
});
