import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = join(
  process.cwd(),
  "supabase/migrations",
  readdirSync(join(process.cwd(), "supabase/migrations")).find((name) =>
    /_lol_persistence_foundation\.sql$/.test(name),
  ) ?? "missing.sql",
);
const sql = readFileSync(migrationPath, "utf8").toLowerCase();

describe("LoL persistence migration", () => {
  it("creates only server-side core tables with RLS and service-role access", () => {
    for (const table of [
      "lol_accounts",
      "lol_ranked_entries",
      "lol_matches",
      "lol_match_participants",
      "lol_api_cache",
      "lol_rate_limit_state",
      "lol_collection_leases",
    ]) {
      expect(sql).toContain(`create table public.${table}`);
    }
    expect(sql).toContain(
      "execute format('alter table public.%i enable row level security', table_name)",
    );
    expect(sql).toContain(
      "execute format('revoke all on public.%i from public, anon, authenticated', table_name)",
    );
    expect(sql).toContain(
      "execute format('grant select, insert, update, delete on public.%i to service_role', table_name)",
    );
  });

  it("keeps RPCs invoker-only and revokes default public execution", () => {
    expect(sql).toContain("security invoker");
    expect(sql).toContain(
      "revoke all on function public.acquire_lol_collection_lease",
    );
    expect(sql).toContain("public.reserve_lol_riot_request(text)");
    expect(sql).toContain("to service_role");
    expect(sql).not.toContain("security definer");
  });

  it("stores a bounded seven-day Riot match payload for later immutable reuse", () => {
    expect(sql).toContain(
      "request_json jsonb not null check (octet_length(request_json::text) <= 1048576)",
    );
    expect(sql).toContain(
      "create or replace function public.get_lol_match_request_json",
    );
    expect(sql).toContain("and expires_at > pg_catalog.clock_timestamp()");
    expect(sql).toContain("public.get_lol_match_request_json(text,text,text)");
    expect(sql).toContain(
      "request_json=case when public.lol_matches.expires_at<=v_now then excluded.request_json else public.lol_matches.request_json end",
    );
    expect(sql).toContain("least(v_match_expires_at,v_now+interval '7 days')");
    expect(sql).not.toContain(
      "request_json=coalesce(public.lol_matches.request_json,excluded.request_json)",
    );
    expect(sql).toContain("set local lock_timeout = '2s'");
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });
});

const historySql = readFileSync(join(process.cwd(), "supabase/migrations/20261023010000_lol_ranked_history.sql"), "utf8").toLowerCase();

describe("LoL ranked history migration", () => {
  it("keeps history and its sequence private with account cascade and invoker RPC", () => {
    expect(historySql).toContain("references public.lol_accounts(puuid) on delete cascade");
    expect(historySql).toContain("alter table public.lol_ranked_history enable row level security");
    expect(historySql).toContain("revoke all on public.lol_ranked_history from public, anon, authenticated");
    expect(historySql).toContain("revoke all on sequence public.lol_ranked_history_id_seq from public, anon, authenticated");
    expect(historySql).toContain("grant execute on function public.get_lol_ranked_history(text,integer) to service_role");
    expect(historySql).not.toContain("security definer");
  });

  it("orders all-time highest by tier, division and LP, separately from the last 30 points", () => {
    expect(historySql).toContain("array['iron','bronze','silver','gold','platinum','emerald','diamond','master','grandmaster','challenger']");
    expect(historySql).toContain("array['iv','iii','ii','i']");
    expect(historySql).toContain("desc,league_points desc,recorded_at,id");
    expect(historySql).toContain("greatest(1,least(coalesce(p_limit,30),30))");
    expect(historySql).toContain("min(recorded_at)");
    expect(historySql).toContain("is distinct from (previous.tier,previous.rank,previous.league_points,previous.wins,previous.losses)");
    expect(historySql).toContain("jsonb_set(p_cache_payload,'{rankedhistory}',public.get_lol_ranked_history(v_puuid,30))");
  });
});
