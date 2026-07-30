import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MIGRATION = readFileSync(
  resolve("supabase/migrations/20260730210000_pubg_response_cache.sql"),
  "utf8"
);

describe("PUBG 분산 캐시 모듈", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  async function loadModule(rpc?: ReturnType<typeof vi.fn>) {
    if (rpc) {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
      vi.doMock("@supabase/supabase-js", () => ({
        createClient: () => ({ rpc }),
      }));
    } else {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    }
    const mod = await import("@/lib/pubg/responseCache");
    mod.__resetPubgCacheForTests();
    return mod;
  }

  it("캐시 키에 플랫폼·닉네임(소문자)·시즌을 모두 포함한다", async () => {
    const { buildPlayerCacheKey } = await loadModule();
    expect(buildPlayerCacheKey("steam", "KangHeeSung_", "division.bro.official.pc-2018-37"))
      .toBe("player:steam:kangheesung_:division.bro.official.pc-2018-37");
    expect(buildPlayerCacheKey("kakao", "Player", null)).toBe("player:kakao:player:current");
  });

  it("L1 히트 시 DB RPC 를 호출하지 않는다", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const { readPubgCache, writePubgCache } = await loadModule(rpc);

    await writePubgCache("player:steam:a:current", { name: "a" });
    rpc.mockClear();

    const hit = await readPubgCache("player:steam:a:current");
    expect(hit).toEqual({ name: "a" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("L1 미스 시 DB L2 를 조회하고 결과를 L1 으로 승격한다", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { name: "fromDb" }, error: null });
    const { readPubgCache } = await loadModule(rpc);

    const first = await readPubgCache("player:steam:b:current");
    expect(first).toEqual({ name: "fromDb" });
    expect(rpc).toHaveBeenCalledWith("read_pubg_response_cache", {
      p_cache_key: "player:steam:b:current",
    });

    rpc.mockClear();
    const second = await readPubgCache("player:steam:b:current");
    expect(second).toEqual({ name: "fromDb" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("쓰기 시 L2 에 TTL 과 함께 기록한다", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const { writePubgCache, PLAYER_CACHE_TTL_SECONDS } = await loadModule(rpc);

    await writePubgCache("player:steam:c:current", { name: "c" });
    expect(rpc).toHaveBeenCalledWith("write_pubg_response_cache", {
      p_cache_key: "player:steam:c:current",
      p_payload: { name: "c" },
      p_ttl_seconds: PLAYER_CACHE_TTL_SECONDS,
    });
  });

  it("L2 오류가 나도 예외를 던지지 않고 null 을 반환한다 (성능 저하 모드)", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("network down"));
    const { readPubgCache } = await loadModule(rpc);

    await expect(readPubgCache("player:steam:d:current")).resolves.toBeNull();
  });

  it("L2 쓰기 오류도 요청을 실패시키지 않고 L1 에는 남는다", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const { writePubgCache, readPubgCache } = await loadModule(rpc);

    await expect(writePubgCache("player:steam:e:current", { name: "e" })).resolves.toBeUndefined();
    rpc.mockClear();
    await expect(readPubgCache("player:steam:e:current")).resolves.toEqual({ name: "e" });
  });

  it("강제 갱신 클레임은 DB RPC 결과를 그대로 따른다", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: false, error: null });
    const { claimForceRefresh } = await loadModule(rpc);

    await expect(claimForceRefresh("player:steam:f:current")).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledWith("claim_pubg_force_refresh", {
      p_lock_key: "player:steam:f:current",
      p_cooldown_seconds: 60,
    });
  });

  it("DB 를 쓸 수 없으면 로컬 쿨다운으로 대체한다", async () => {
    const { claimForceRefresh } = await loadModule();

    await expect(claimForceRefresh("player:steam:g:current")).resolves.toBe(true);
    await expect(claimForceRefresh("player:steam:g:current")).resolves.toBe(false);
  });
});

describe("PUBG 캐시 마이그레이션 계약", () => {
  it("캐시·락 테이블에 RLS 를 켜고 anon/authenticated 권한을 회수한다", () => {
    for (const table of ["pubg_response_cache", "pubg_refresh_locks"]) {
      expect(MIGRATION).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(MIGRATION).toContain(`REVOKE ALL ON TABLE public.${table} FROM anon, authenticated`);
      expect(MIGRATION).toContain(`GRANT ALL ON TABLE public.${table} TO service_role`);
    }
  });

  it("읽기 RPC 가 만료 시각을 검사한다", () => {
    const body = MIGRATION.split("read_pubg_response_cache(p_cache_key text)")[1];
    expect(body).toContain("expires_at > now()");
  });

  it("TTL 과 쿨다운을 서버에서 상한 처리한다", () => {
    expect(MIGRATION).toContain("least(greatest(coalesce(p_ttl_seconds, 180), 1), 86400)");
    expect(MIGRATION).toContain("least(greatest(coalesce(p_cooldown_seconds, 60), 1), 3600)");
  });

  it("강제 갱신 클레임이 쿨다운 조건부 UPDATE 로 경쟁을 처리한다", () => {
    const body = MIGRATION.split("claim_pubg_force_refresh(")[1];
    expect(body).toContain("ON CONFLICT (lock_key) DO UPDATE");
    expect(body).toContain("WHERE public.pubg_refresh_locks.claimed_at < now() - make_interval");
    expect(body).toContain("GET DIAGNOSTICS updated_rows = ROW_COUNT");
  });

  it("모든 SECURITY DEFINER 함수가 search_path 를 고정하고 service_role 로 제한된다", () => {
    const definerCount = MIGRATION.match(/SECURITY DEFINER/g)?.length ?? 0;
    const searchPathCount = MIGRATION.match(/SET search_path = ''/g)?.length ?? 0;
    expect(definerCount).toBeGreaterThan(0);
    expect(searchPathCount).toBeGreaterThanOrEqual(definerCount);

    for (const fn of [
      "public.read_pubg_response_cache(text)",
      "public.write_pubg_response_cache(text, jsonb, integer)",
      "public.claim_pubg_force_refresh(text, integer)",
      "public.cleanup_pubg_response_cache()",
    ]) {
      expect(MIGRATION).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated`);
      expect(MIGRATION).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO service_role`);
    }
  });
});

describe("player 라우트가 분산 캐시를 사용한다", () => {
  const routeSource = readFileSync(resolve("app/api/pubg/player/route.ts"), "utf8");

  it("인메모리 전용 캐시 구현이 남아 있지 않다", () => {
    expect(routeSource).not.toContain("playerResponseCache");
    expect(routeSource).not.toContain("forceRefreshLocks");
    expect(routeSource).not.toContain("CACHE_TTL_MS");
  });

  it("공유 캐시 모듈을 통해 읽고 쓴다", () => {
    expect(routeSource).toContain('from "@/lib/pubg/responseCache"');
    expect(routeSource).toContain("await readPubgCache(cacheKey)");
    expect(routeSource).toContain("await claimForceRefresh(cacheKey)");
    expect(routeSource.match(/await writePubgCache\(cacheKey, responseBody\)/g)).toHaveLength(2);
  });
});
