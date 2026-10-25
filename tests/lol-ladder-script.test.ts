import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

const preload = `
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push({ host: url.hostname, path: url.pathname, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.hostname === 'kr.api.riotgames.com') {
      const tier = url.pathname.includes('/grandmaster') ? 'GRANDMASTER' : url.pathname.includes('/master') ? 'MASTER' : 'CHALLENGER';
      return Response.json({ queue: url.pathname.split('/').at(-1), tier, entries: [
        { puuid: 'private-fixture-puuid', leaguePoints: 123, freshBlood: true, hotStreak: false }
      ] });
    }
    if (url.hostname !== 'fixture.supabase.co') throw new Error('unexpected fixture host');
    const rpc = url.pathname.split('/').at(-1);
    if (rpc === 'reserve_lol_riot_request') return Response.json([{ granted: true, lease_token: 'fixture-token', permit_at: new Date().toISOString() }]);
    if (rpc === 'start_lol_riot_request') return Response.json([{ allowed: true, retry_after_seconds: 0 }]);
    if (!['record_lol_riot_rate_headers','release_lol_riot_request','increment_lol_ops_metric','save_lol_ladder_daily'].includes(rpc)) {
      throw new Error('unexpected fixture RPC');
    }
    return Response.json(true);
  };
  process.once('beforeExit', () => console.error('FIXTURE_LEDGER=' + JSON.stringify(calls)));
`;

describe("랭크 컷 CLI 실제 진입점 — 외부 연결 없는 전송 fixture", () => {
  it.each(["--dry-run", "--apply"])("%s에서 공유 가드 6회와 집계만 전달한다", { timeout: 30_000 }, mode => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
      "scripts/lol_ladder_snapshot.ts", mode], { encoding: "utf8", timeout: 20_000,
      env: { ...process.env, RIOT_API_KEY: "fixture-only-key", LOL_PERSISTENCE_ENABLED: "true", LOL_LADDER_ENABLED: "true",
        NEXT_PUBLIC_SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: mode === "--dry-run", rows: expect.any(Array) });
    expect(result.stdout).not.toMatch(/private-fixture-puuid|fixture-only-key|fixture-service-key/);
    const line = result.stderr.split("\n").find(line => line.startsWith("FIXTURE_LEDGER="));
    const calls = JSON.parse(line!.slice("FIXTURE_LEDGER=".length)) as Array<{ host: string; path: string; body?: unknown }>;
    expect(calls.filter(call => call.host === "kr.api.riotgames.com")).toHaveLength(6);
    expect(calls.filter(call => call.path.endsWith("reserve_lol_riot_request"))).toHaveLength(6);
    expect(calls.filter(call => call.path.endsWith("start_lol_riot_request"))).toHaveLength(6);
    const writes = calls.filter(call => call.path.endsWith("save_lol_ladder_daily"));
    expect(writes).toHaveLength(mode === "--apply" ? 1 : 0);
    expect(JSON.stringify(writes)).not.toContain("private-fixture-puuid");
  });
});
