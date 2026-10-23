import { createHmac } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/access.server", () => ({
  requireLolDevAdmin: async () => ({ ok: true }),
}));

import { POST } from "@/app/api/admin/lol/search/route";
import { POST as collect } from "@/app/api/admin/lol/collect/route";
import { hasLolBenchmarkProcessedMatch } from "@/lib/lol/persistence.server";
import {
  getLolMatchDetails,
  searchLolRiotId,
} from "@/lib/lol/riotSearch.server";

const enabled = process.env.RUN_LOL_PERSISTENCE_INTEGRATION === "true";
const mode = process.env.LOL_PERSISTENCE_INTEGRATION_MODE;
const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const parsedBaseUrl = new URL(baseUrl || "http://127.0.0.1");
const unreachableUrl =
  process.env.LOL_PERSISTENCE_INTEGRATION_UNREACHABLE_URL ?? "";
const allowedRestOrigins = new Set(
  [baseUrl, unreachableUrl]
    .filter(Boolean)
    .map((value) => new URL(value).origin),
);
const secret = process.env.LOL_PERSISTENCE_INTEGRATION_JWT_SECRET ?? "";
const nativeFetch = globalThis.fetch.bind(globalThis);
const riotAndStaticCalls: string[] = [];
let restCalls = 0;

function jwtFor(role: "anon" | "authenticated") {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, exp: Math.floor(Date.now() / 1000) + 300 })}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

function fixtureResponse(value: unknown) {
  return Response.json(value, {
    headers: {
      "X-App-Rate-Limit": "20:1",
      "X-App-Rate-Limit-Count": "1:1",
      "X-Method-Rate-Limit": "10:1",
      "X-Method-Rate-Limit-Count": "1:1",
    },
  });
}

function fixtureFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  if (
    allowedRestOrigins.has(url.origin) &&
    url.pathname.startsWith("/rest/v1/")
  ) {
    restCalls += 1;
    // Supabase JS adds this gateway prefix; the real PostgREST process serves the same path at its root.
    url.pathname = url.pathname.slice("/rest/v1".length);
    return nativeFetch(new Request(url, request));
  }

  if (url.hostname.endsWith("api.riotgames.com")) {
    riotAndStaticCalls.push(url.href);
    if (url.pathname.includes("accounts/by-riot-id"))
      return Promise.resolve(
        fixtureResponse({
          puuid: "integration-puuid",
          gameName: "Integration",
          tagLine: "IT",
        }),
      );
    if (url.pathname.includes("summoner/v4"))
      return Promise.resolve(
        fixtureResponse({ profileIconId: 12, summonerLevel: 42 }),
      );
    if (url.pathname.includes("league/v4"))
      return Promise.resolve(
        fixtureResponse([
          {
            puuid: "integration-puuid",
            queueType: "RANKED_SOLO_5x5",
            tier: "GOLD",
            rank: "II",
            leaguePoints: 31,
            wins: 10,
            losses: 8,
          },
        ]),
      );
    if (url.pathname.endsWith("/ids"))
      return Promise.resolve(fixtureResponse(["KR_8801"]));
    if (url.pathname.endsWith("/KR_8801"))
      return Promise.resolve(fixtureResponse(matchFixture));
  }

  if (url.hostname === "ddragon.leagueoflegends.com") {
    riotAndStaticCalls.push(url.href);
    if (url.pathname.endsWith("/champion.json"))
      return Promise.resolve(
        fixtureResponse({ data: { Ahri: { name: "아리", key: "103" } } }),
      );
    if (url.pathname.endsWith("/item.json"))
      return Promise.resolve(
        fixtureResponse({ data: { "1056": { name: "도란의 반지" } } }),
      );
  }

  throw new Error(`Unexpected integration fetch host: ${url.hostname}`);
}

const matchFixture = {
  metadata: {
    matchId: "KR_8801",
    dataVersion: "2",
    participants: ["integration-puuid"],
  },
  info: {
    queueId: 420,
    gameMode: "CLASSIC",
    gameDuration: 1800,
    gameStartTimestamp: 1_700_000_000_000,
    gameEndTimestamp: 1_700_001_800_000,
    gameVersion: "16.21.1",
    mapId: 11,
    teams: [
      { teamId: 100, win: true },
      { teamId: 200, win: false },
    ],
    participants: [
      {
        puuid: "integration-puuid",
        participantId: 1,
        teamId: 100,
        championId: 103,
        championName: "Ahri",
        win: true,
        riotIdGameName: "Integration",
        riotIdTagline: "IT",
        kills: 5,
        deaths: 2,
        assists: 9,
        item0: 1056,
        item1: 0,
        item2: 0,
        item3: 0,
        item4: 0,
        item5: 0,
        item6: 0,
        totalMinionsKilled: 150,
        neutralMinionsKilled: 10,
        totalDamageDealtToChampions: 18000,
        visionScore: 22,
        goldEarned: 12000,
        wardsPlaced: 12,
        wardsKilled: 3,
        damageDealtToObjectives: 5000,
        perks: { statPerks: { offense: 5008 }, styles: [] },
      },
    ],
  },
};

async function roleClient(role: "anon" | "authenticated" | "service_role") {
  const token =
    role === "service_role"
      ? process.env.SUPABASE_SERVICE_ROLE_KEY!
      : jwtFor(role);
  return createClient(baseUrl, token, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: fixtureFetch },
  });
}

function assertLocalTarget() {
  expect(enabled).toBe(true);
  expect(secret.length).toBeGreaterThanOrEqual(32);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsedBaseUrl.hostname);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(
    new URL(unreachableUrl).hostname,
  );
}

function withFixtures() {
  riotAndStaticCalls.length = 0;
  restCalls = 0;
  vi.stubGlobal("fetch", fixtureFetch);
}

afterAll(() => vi.unstubAllGlobals());

describe.skipIf(!enabled || mode !== "populate")(
  "LoL PG17/PostgREST integration: populate",
  () => {
    it("검색과 상세를 저장하고 실제 REST의 anon/authenticated/service_role 경계를 확인한다", async () => {
      assertLocalTarget();
      withFixtures();

      for (const role of ["anon", "authenticated"] as const) {
        const client = await roleClient(role);
        const table = await client
          .from("lol_accounts")
          .select("puuid")
          .limit(1);
        expect(table.error?.code).toBe("42501");
        for (const tableName of ["lol_benchmark_processed_matches", "lol_benchmark_aggregates"]) {
          const anonymous = await client.from(tableName).select("*").limit(1);
          expect(anonymous.error?.code).toBe("42501");
        }
        const benchmark = await client.rpc("aggregate_lol_match_benchmarks", { p_match_id: "KR_8801" });
        expect(benchmark.error?.code).toBe("42501");
        const rpc = await client.rpc("acquire_lol_collection_lease", {
          p_key: `${role}:denied`,
          p_ttl_seconds: 10,
        });
        expect(rpc.error?.code).toBe("42501");
      }

      const service = await roleClient("service_role");
      const serviceRead = await service
        .from("lol_accounts")
        .select("puuid")
        .limit(1);
      expect(serviceRead.error).toBeNull();
      expect(serviceRead.data).toBeTruthy();

      vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true");
      const search = await searchLolRiotId("Integration#IT");
      expect(search).toMatchObject({
        account: { gameName: "Integration", tagLine: "IT" },
        profile: { profileIconId: 12, summonerLevel: 42 },
        matchStatus: "ready",
      });
      expect(search.ranked[0]).toMatchObject({
        tier: "GOLD",
        rank: "II",
        leaguePoints: 31,
      });
      expect(JSON.stringify(search)).not.toContain("integration-puuid");

      const details = await getLolMatchDetails("KR_8801");
      expect(details.teams[0].participants[0]).toMatchObject({
        riotId: "Integration#IT",
        championNameKo: "아리",
        kills: 5,
        cs: 160,
      });

      const account = await service
        .from("lol_accounts")
        .select("game_name,tag_line")
        .eq("puuid", "integration-puuid")
        .single();
      expect(account.data).toEqual({
        game_name: "Integration",
        tag_line: "IT",
      });
      const ranked = await service
        .from("lol_ranked_entries")
        .select("league_points")
        .eq("puuid", "integration-puuid")
        .single();
      expect(ranked.data?.league_points).toBe(31);
      const match = await service
        .from("lol_matches")
        .select("match_id")
        .eq("match_id", "KR_8801")
        .single();
      expect(match.data?.match_id).toBe("KR_8801");
      const participant = await service
        .from("lol_match_participants")
        .select("puuid,kills,cs,neutral_minions_killed")
        .eq("match_id", "KR_8801")
        .single();
      expect(participant.data).toMatchObject({
        puuid: "integration-puuid",
        kills: 5,
        cs: 150,
        neutral_minions_killed: 10,
      });
      const processed = await service.from("lol_benchmark_processed_matches").select("match_id,skipped_reason").eq("match_id", "KR_8801").single();
      expect(processed.error).toBeNull();
      expect(processed.data).toEqual({ match_id: "KR_8801", skipped_reason: "invalid_participants" });
      expect(await hasLolBenchmarkProcessedMatch("KR_8801")).toBe(true);
      expect(await hasLolBenchmarkProcessedMatch("KR_999999")).toBe(false);
      const collectionRequest = () => new Request("http://localhost/api/admin/lol/collect", {
        method: "POST", headers: { Origin: "http://localhost", Host: "localhost", "Content-Type": "application/json" },
        body: JSON.stringify({ riotId: "Integration#IT", count: 1, confirm: true }),
      });
      expect(await (await collect(collectionRequest())).json()).toMatchObject({ processed: 1, reused: 1, skipped: 1, fetched: 1 });
      const beforeReuse = riotAndStaticCalls.length;
      expect(await (await collect(collectionRequest())).json()).toMatchObject({ processed: 1, reused: 1, skipped: 1, fetched: 0 });
      expect(riotAndStaticCalls).toHaveLength(beforeReuse);
      const cache = await service
        .from("lol_api_cache")
        .select("kind")
        .in("kind", ["search", "match_details"]);
      expect(cache.data?.map((row) => row.kind)).toEqual(
        expect.arrayContaining(["search", "match_details"]),
      );
      expect(
        riotAndStaticCalls.some((url) => url.includes("api.riotgames.com")),
      ).toBe(true);
      expect(
        riotAndStaticCalls.some((url) =>
          url.includes("ddragon.leagueoflegends.com"),
        ),
      ).toBe(true);
    });
  },
);

describe.skipIf(!enabled || mode !== "cache-hit")(
  "LoL PG17/PostgREST integration: restarted process cache hit",
  () => {
    it("DTO cache 만료 뒤 계정/랭크/경기목록은 갱신하고 7일 저장 경기 payload를 재사용한다", async () => {
      assertLocalTarget();
      withFixtures();
      vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true");
      const service = await roleClient("service_role");
      const before = await service
        .from("lol_matches")
        .select("fetched_at,expires_at")
        .eq("match_id", "KR_8801")
        .single();
      expect(before.error).toBeNull();
      await service
        .from("lol_api_cache")
        .delete()
        .in("kind", ["search", "match_details"]);

      await expect(searchLolRiotId("Integration#IT")).resolves.toMatchObject({
        account: { gameName: "Integration" },
        matchStatus: "ready",
      });
      const afterSearch = await service
        .from("lol_matches")
        .select("fetched_at,expires_at")
        .eq("match_id", "KR_8801")
        .single();
      expect(afterSearch.data).toEqual(before.data);
      const riotUrls = riotAndStaticCalls.filter((url) =>
        url.includes("api.riotgames.com"),
      );
      expect(riotUrls).toHaveLength(4);
      expect(riotUrls.some((url) => url.endsWith("/KR_8801"))).toBe(false);
      expect(riotUrls.some((url) => url.includes("accounts/by-riot-id"))).toBe(
        true,
      );
      expect(riotUrls.some((url) => url.includes("/ids?"))).toBe(true);

      await expect(getLolMatchDetails("KR_8801")).resolves.toMatchObject({
        matchId: "KR_8801",
      });
      const detailsCache = await service
        .from("lol_api_cache")
        .select("expires_at")
        .eq("kind", "match_details")
        .single();
      expect(Date.parse(detailsCache.data!.expires_at)).toBeLessThanOrEqual(
        Date.parse(before.data!.expires_at),
      );
      expect(
        riotAndStaticCalls.filter((url) => url.includes("api.riotgames.com")),
      ).toHaveLength(4);
      expect(restCalls).toBeGreaterThan(0);
    });
  },
);

describe.skipIf(!enabled || mode !== "db-error")(
  "LoL PG17/PostgREST integration: database error",
  () => {
    it("DB 오류를 검색 API 503으로 닫고 Riot fixture를 호출하지 않는다", async () => {
      assertLocalTarget();
      withFixtures();
      vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true");
      vi.stubEnv(
        "NEXT_PUBLIC_SUPABASE_URL",
        process.env.LOL_PERSISTENCE_INTEGRATION_UNREACHABLE_URL!,
      );

      const request = new Request("http://localhost/api/admin/lol/search", {
        method: "POST",
        headers: {
          Host: "localhost",
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ riotId: "Integration#DBERROR" }),
      });
      const response = await POST(request);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "LoL 저장소를 사용할 수 없습니다.",
      });
      expect(riotAndStaticCalls).toEqual([]);
    });
  },
);

describe.skipIf(!enabled || mode !== "flag-off")(
  "LoL PG17/PostgREST integration: flag off",
  () => {
    it("flag off에서는 DB 접근 없이 기존 fixture 경로로 복귀한다", async () => {
      assertLocalTarget();
      withFixtures();
      vi.stubEnv("LOL_PERSISTENCE_ENABLED", "false");

      const result = await searchLolRiotId("Flagoff#IT");
      expect(result).toMatchObject({
        account: { gameName: "Integration", tagLine: "IT" },
        matchStatus: "ready",
      });
      expect(
        riotAndStaticCalls.some((url) => url.includes("api.riotgames.com")),
      ).toBe(true);
      expect(restCalls).toBe(0);
    });
  },
);
