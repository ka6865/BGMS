import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/20260901141209_pubg_analysis_population_provenance.sql",
);
const SAFETY_MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/20260904130000_telemetry_cache_recovery_safety.sql",
);
const VERIFY_SCRIPT_PATH = resolve(process.cwd(), "scripts/verify_migrations_local.sh");
const PREREQUISITES_PATH = resolve(
  process.cwd(),
  "tests/fixtures/migration-check/prerequisites.sql",
);
const SCENARIOS_PATH = resolve(process.cwd(), "tests/fixtures/migration-check/scenarios.sql");

function migrationSql(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

function safetyMigrationSql(): string {
  return readFileSync(SAFETY_MIGRATION_PATH, "utf8");
}

function verifyScript(): string {
  return readFileSync(VERIFY_SCRIPT_PATH, "utf8");
}

function prerequisitesSql(): string {
  return readFileSync(PREREQUISITES_PATH, "utf8");
}

function scenariosSql(): string {
  return readFileSync(SCENARIOS_PATH, "utf8");
}

describe("PUBG analysis population provenance migration", () => {
  it("adds nullable, explicit-write provenance markers without trusting legacy rows", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      "ADD COLUMN IF NOT EXISTS population_evidence_version integer",
    );
    expect(sql).toContain(
      "ALTER TABLE public.weapon_meta_match_samples\n  ADD COLUMN IF NOT EXISTS filter_version integer",
    );
    expect(sql).toContain(
      "ALTER TABLE public.weapon_meta_match_samples\n  ADD COLUMN IF NOT EXISTS population_evidence_version integer",
    );
    expect(sql).not.toMatch(/DEFAULT\s+1\b/i);
    const executableSql = sql
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(executableSql).not.toMatch(/^\s*UPDATE\b[\s\S]*population_evidence_version\s*=\s*1/im);

    expect(sql).toContain("global_benchmarks_population_evidence_version_check");
    expect(sql).toContain("weapon_meta_match_samples_filter_version_check");
    expect(sql).toContain("weapon_meta_match_samples_population_evidence_version_check");
    expect(sql).toMatch(
      /CHECK\s*\(population_evidence_version IS NULL OR population_evidence_version = 1\)\s*NOT VALID/i,
    );
    expect(sql).toMatch(
      /CHECK\s*\(filter_version IS NULL OR filter_version = 8\)\s*NOT VALID/i,
    );
    expect(sql).toMatch(/pg_constraint[\s\S]*conname = 'global_benchmarks_population_evidence_version_check'/i);
  });

  it("rebuilds the tier view on only current official/competitive evidence", () => {
    const sql = migrationSql();

    expect(sql).toMatch(
      /CREATE OR REPLACE VIEW public\.benchmark_stats_by_tier\s+WITH \(security_invoker = true\)/i,
    );
    expect(sql).toContain("b.filter_version = 8");
    expect(sql).toContain("b.population_evidence_version = 1");
    expect(sql).toContain("b.match_type IN ('official', 'competitive')");
    expect(sql).toContain(
      "b.game_mode IN ('solo', 'solo-fpp', 'duo', 'duo-fpp', 'squad', 'squad-fpp')",
    );
    expect(sql).toContain("8::integer AS filter_version");
    expect(sql).toContain("1::integer AS population_evidence_version");
    expect(sql).toContain("GROUP BY b.tier, b.game_mode, b.match_type");
    expect(sql).toContain("ALTER VIEW public.benchmark_stats_by_tier OWNER TO postgres");
    expect(sql).toContain("GRANT SELECT ON TABLE public.benchmark_stats_by_tier TO anon, authenticated");
    expect(sql).toContain("GRANT ALL ON TABLE public.benchmark_stats_by_tier TO service_role");

    const metrics: Array<[string, string, string]> = [
      ["damage", "avg_damage", "-1::double precision"],
      ["kills", "avg_kills", "-1"],
      ["survival_time", "avg_survival_time", "-1"],
      ["duel_win_rate", "avg_duel_win_rate", "-1::double precision"],
      ["initiative_rate", "avg_initiative_rate", "-1::double precision"],
      ["trade_rate", "avg_trade_rate", "-1::double precision"],
      ["revive_rate", "avg_revive_rate", "-1::double precision"],
      ["smoke_rate", "avg_smoke_rate", "-1::double precision"],
      ["pressure_index", "avg_pressure_index", "-1::double precision"],
      ["team_wipes", "avg_team_wipes", "-1"],
      ["reversal_rate", "avg_reversal_rate", "-1::double precision"],
      ["isolation_index", "avg_isolation_index", "-1::double precision"],
      ["min_dist", "avg_min_dist", "-1::double precision"],
      ["counter_latency_ms", "avg_counter_latency_ms", "-1::double precision"],
      ["trade_latency_ms", "avg_trade_latency_ms", "-1::double precision"],
      ["solo_kill_rate", "avg_solo_kill_rate", "-1"],
      ["death_phase", "avg_death_phase", "-1"],
    ];

    for (const [column, alias, sentinel] of metrics) {
      expect(sql).toContain(`avg(NULLIF(b.${column}, ${sentinel})) AS ${alias}`);
      expect(sql).toContain(
        `count(*) FILTER (WHERE NULLIF(b.${column}, ${sentinel}) IS NOT NULL) AS ${alias}_count`,
      );
    }
  });

  it("adds evidence-selective benchmark and weapon indexes", () => {
    const sql = migrationSql();

    expect(sql).toContain("idx_global_benchmarks_population_evidence");
    expect(sql).toContain("idx_weapon_meta_match_samples_population_evidence");
    const predicates = sql.match(/WHERE filter_version = 8\s+AND population_evidence_version = 1/gi) ?? [];
    expect(predicates.length).toBeGreaterThanOrEqual(2);
    expect(sql).toContain(
      "WHERE filter_version = 8\n    AND population_evidence_version = 1\n    AND match_type IN ('official', 'competitive')\n    AND game_mode IN ('solo', 'solo-fpp', 'duo', 'duo-fpp', 'squad', 'squad-fpp')",
    );
  });

  it("recreates both weapon RPC overloads with trusted markers and service-only ACL", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      "DROP FUNCTION IF EXISTS public.get_weapon_meta_comparison(text, timestamptz, integer)",
    );
    expect(sql).toContain(
      "DROP FUNCTION IF EXISTS public.get_weapon_meta_comparison(text, timestamptz, integer, text)",
    );
    expect((sql.match(/CREATE OR REPLACE FUNCTION public\.get_weapon_meta_comparison\(/g) ?? []).length).toBe(2);
    expect((sql.match(/filter_version integer,/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((sql.match(/population_evidence_version integer/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((sql.match(/s\.filter_version = 8/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((sql.match(/s\.population_evidence_version = 1/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(sql).toContain("s.match_type IN ('official', 'competitive')");
    expect(sql).toContain("8::integer AS filter_version");
    expect(sql).toContain("1::integer AS population_evidence_version");
    expect((sql.match(/SECURITY INVOKER/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer) FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer, text) FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer) TO service_role",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.get_weapon_meta_comparison(text, timestamptz, integer, text) TO service_role",
    );
  });

  it("tightens both historical weapon RPC overloads forward without recreating or re-ACLing them", () => {
    const sql = safetyMigrationSql();

    expect(sql).toMatch(
      /alter function public\.get_weapon_meta_comparison\(\s*text, timestamptz, integer\s*\)\s*set search_path = ''/i,
    );
    expect(sql).toMatch(
      /alter function public\.get_weapon_meta_comparison\(\s*text, timestamptz, integer, text\s*\)\s*set search_path = ''/i,
    );
    expect((sql.match(/alter function public\.get_weapon_meta_comparison\(/gi) ?? []).length).toBe(2);
    expect(sql).not.toMatch(
      /(?:create|drop)\s+(?:or replace\s+)?function\s+public\.get_weapon_meta_comparison\(/i,
    );
    expect(sql).not.toMatch(
      /(?:alter\s+function|grant\s+execute\s+on\s+function|revoke\s+all\s+on\s+function)[\s\S]*get_weapon_meta_comparison[\s\S]*(?:owner\s+to|grant\s+execute|revoke\s+all)/i,
    );
  });

  it("runs this migration after the existing local migration-check chain", () => {
    const script = verifyScript();
    const previous = "20260819115023_profile_linked_pubg_auto_sync";
    const current = "20260901141209_pubg_analysis_population_provenance";

    expect(script).toContain(`"${previous}"`);
    expect(script).toContain(`"${current}"`);
    expect(script.indexOf(`"${previous}"`)).toBeLessThan(script.indexOf(`"${current}"`));
  });

  it("declares faithful benchmark/sample prerequisites and an existing tier view", () => {
    const sql = prerequisitesSql();

    expect(sql).toMatch(/create table if not exists public\.global_benchmarks\s*\(/i);
    for (const column of [
      "match_id text not null",
      "player_id text not null",
      "game_mode text",
      "created_at timestamptz",
      "filter_version integer",
      "tier text",
      "match_type text",
      "damage double precision",
      "kills integer",
      "survival_time integer",
      "death_phase integer",
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toMatch(/create table if not exists public\.weapon_meta_match_samples\s*\(/i);
    expect(sql).toContain("filter_version integer");
    expect(sql).toMatch(/create or replace view public\.benchmark_stats_by_tier/i);
    expect(sql).toMatch(/create or replace function public\.get_weapon_meta_comparison\(/i);
  });

  it("checks the executable provenance scenarios for benchmark and weapon populations", () => {
    const sql = scenariosSql();

    expect(sql).toContain("legacy/unmarked benchmark rows are excluded");
    expect(sql).toContain("trusted canonical benchmark rows are included");
    expect(sql).toContain("invalid game mode is excluded");
    expect(sql).toContain("metric -1 is omitted");
    expect(sql).toContain("weapon RPC returns only current markers");
    expect(sql).toContain("population_evidence_version");
    expect(sql).toContain("filter_version");
    expect(sql).toContain("squad-fpp");
  });

  it("checks forward weapon RPC catalog state, four-way ACL, and both service-role calls", () => {
    const migration = safetyMigrationSql();
    const scenarios = scenariosSql();

    expect(migration).toMatch(
      /alter function public\.get_weapon_meta_comparison\(\s*text, timestamptz, integer\s*\)\s*set search_path = ''/i,
    );
    expect(migration).toMatch(
      /alter function public\.get_weapon_meta_comparison\(\s*text, timestamptz, integer, text\s*\)\s*set search_path = ''/i,
    );
    expect(scenarios).toContain("weapon RPC empty search_path + ACL + role boundaries");
    expect(scenarios).toContain("prosecdef");
    expect(scenarios).toContain('search_path=""');
    expect(scenarios).toContain("has_function_privilege('public'");
    expect(scenarios).toContain("has_function_privilege('anon'");
    expect(scenarios).toContain("has_function_privilege('authenticated'");
    expect(scenarios).toContain("has_function_privilege('service_role'");
    expect(scenarios).toContain(
      "public.get_weapon_meta_comparison('42.1', now() - interval '1 hour', 14)",
    );
    expect(scenarios).toContain(
      "public.get_weapon_meta_comparison('42.1', now() - interval '1 hour', 14, 'all')",
    );
  });
});
