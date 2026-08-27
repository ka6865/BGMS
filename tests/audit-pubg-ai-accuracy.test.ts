import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AI_CACHE_VERSION,
  RESULT_VERSION,
  TELEMETRY_VERSION,
} from "@/lib/pubg-analysis/constants";
import { runAccuracyAudit } from "@/scripts/audit_pubg_ai_accuracy";

const fixturePath = path.resolve("tests/fixtures/pubg-official-shaped-telemetry.json");

describe("anonymous PUBG AI accuracy audit", () => {
  it("synthetic fallback은 aggregate/fingerprint만 반환한다", async () => {
    const report = await runAccuracyAudit({
      source: "synthetic_fixture",
      fixturePath,
      nickname: "FixturePlayer",
      platform: "steam",
      limit: 25,
    });

    expect(report.source).toBe("synthetic_fixture");
    expect(report.remoteWritesAttempted).toBe(0);
    expect(report.externalAiCalls).toBe(0);
    expect(report.recentSelection.nextCount).toBeLessThanOrEqual(10);
    expect(report.recentSelection.nextMatchFingerprints.length).toBe(report.recentSelection.nextCount);
    expect(JSON.stringify(report)).not.toMatch(/accountId|playerId|matchId|FixturePlayer|LogPlayerAttack|https?:/);
    expect(report.recentSelection.legacyCount).toBe(5);
    expect(report.recentSelection.nextCount).toBe(10);
    expect(report.recentSelection.nextExcluded.duplicate_id).toBe(1);
    expect(report.recentSelection.nextExcluded.match_type_excluded).toBe(1);
    expect(report.recentSelection.nextExcluded.mode_excluded).toBe(1);
    expect(report.recentSelection.nextExcluded.over_limit).toBe(2);
    expect(report.telemetry.next.positionEvents).toBe(3);
    expect(report.telemetry.next.teamPositionEvents).toBe(1);
    expect(report.telemetry.next.enemyPositionEvents).toBe(2);
    expect(report.singleMatchMetrics.legacy.damage).toBe(280);
    expect(report.singleMatchMetrics.next.damage).toBe(280);
    expect(report.singleMatchMetrics.legacy.kills).toBe(2);
    expect(report.singleMatchMetrics.next.kills).toBe(2);
    expect(report.singleMatchMetrics.legacy.storedProcessedDamageDealt).toBe(250);
    expect(report.singleMatchMetrics.next.storedProcessedDamageDealt).toBe(250);
    expect(report.singleMatchMetrics.legacy.initiativeSampleCount).toBe(1);
    expect(report.singleMatchMetrics.next.initiativeSampleCount).toBe(1);
    expect(report.singleMatchMetrics.legacy.duelWins).toBe(1);
    expect(report.singleMatchMetrics.next.duelWins).toBe(1);
    expect(report.singleMatchMetrics.legacy.processedDamageDealt).toBe(42);
    expect(report.singleMatchMetrics.next.processedDamageDealt).toBe(42);
    expect(report.singleMatchMetrics.legacy.attackEventCount).toBe(0);
    expect(report.singleMatchMetrics.next.attackEventCount).toBe(1);
    expect(report.singleMatchMetrics.legacy.vehicleEventCount).toBe(0);
    expect(report.singleMatchMetrics.next.vehicleEventCount).toBe(1);
    expect(report.singleMatchMetrics.legacy.carePackageLocationCount).toBe(0);
    expect(report.singleMatchMetrics.next.carePackageLocationCount).toBe(1);
    expect(report.singleMatchMetrics.legacy.redeployCharacterCount).toBe(0);
    expect(report.singleMatchMetrics.next.redeployCharacterCount).toBe(2);
    expect(report.singleMatchMetrics.legacy.officialAssistArrayCount).toBe(0);
    expect(report.singleMatchMetrics.next.officialAssistArrayCount).toBe(1);
    expect(report.singleMatchMetrics.legacy.officialTeamKillerArrayCount).toBe(0);
    expect(report.singleMatchMetrics.next.officialTeamKillerArrayCount).toBe(1);
    expect(report.singleMatchMetrics).toMatchObject({
      legacy: expect.any(Object),
      next: expect.any(Object),
      delta: expect.any(Object),
    });
    expect(report.recentSelection.legacyRejectionCounts).toBeTypeOf("object");
    expect(report.recentSelection.nextRejectionCounts).toBeTypeOf("object");
    expect(report.versions).toEqual({
      result: RESULT_VERSION,
      telemetry: TELEMETRY_VERSION,
      aiCache: AI_CACHE_VERSION,
    });
  });

  it("fixture는 공식 이벤트 shape와 20개 적 위치를 고정한다", async () => {
    const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as {
      telemetry: Array<Record<string, unknown>>;
    };
    const positions = fixture.telemetry.filter((event) => event._T === "LogPlayerPosition");
    const enemyPositions = positions.filter((event) => String((event.character as Record<string, unknown>)?.name).startsWith("Enemy"));
    const redeploy = fixture.telemetry.find((event) => event._T === "LogPlayerRedeployBRStart");
    const kill = fixture.telemetry.find((event) => event._T === "LogPlayerKillV2");
    const carePackage = fixture.telemetry.find((event) => event._T === "LogCarePackageLand");
    const attack = fixture.telemetry.find((event) => event._T === "LogPlayerAttack");
    const throwable = fixture.telemetry.find((event) => event._T === "LogPlayerUseThrowable");
    const vehicle = fixture.telemetry.find((event) => event._T === "LogVehicleRide");

    expect(enemyPositions).toHaveLength(20);
    expect(positions).toHaveLength(21);
    expect(redeploy).toHaveProperty("characters");
    expect((kill?.assists_AccountId as string[]).length).toBeGreaterThan(0);
    expect((kill?.teamKillers_AccountId as string[]).length).toBeGreaterThan(0);
    expect(carePackage).toMatchObject({ itemPackage: { location: { x: 300, y: 400 } } });
    expect(attack).toHaveProperty("weapon.itemId");
    expect(throwable).toHaveProperty("weapon.itemId");
    expect(vehicle).toHaveProperty("vehicle.vehicleId");
    expect((positions[0]?.character as Record<string, unknown>)?.loc).toBeDefined();
  });

  it("real_read_only adapter는 match GET에만 key를 보내고 asset GET은 무키로 읽는다", async () => {
    const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as {
      matches: Array<Record<string, unknown>>;
      telemetry: Array<Record<string, unknown>>;
    };
    const firstMatch = fixture.matches[0];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: async () => ({
        data: [{
          match_id: "fixture-match",
          player_id: "fixtureplayer",
          platform: "steam",
          updated_at: "2026-08-27T00:12:00.000Z",
          data: { fullResult: firstMatch?.fullResult },
        }],
        error: null,
      }),
    };
    const officialBody = {
      data: {
        id: "fixture-match",
        attributes: {
          createdAt: "2026-08-27T00:12:00.000Z",
          gameMode: "squad",
          mapName: "Erangel_Main",
          matchType: "official",
        },
      },
      included: [
        {
          id: "participant-me",
          type: "participant",
          attributes: {
            accountId: "account.fixture",
            stats: {
              ...(typeof firstMatch?.fullResult === "object" && firstMatch.fullResult !== null
                && typeof (firstMatch.fullResult as Record<string, unknown>).stats === "object"
                && (firstMatch.fullResult as Record<string, unknown>).stats !== null
                ? (firstMatch.fullResult as Record<string, unknown>).stats as Record<string, unknown>
                : {}),
            },
          },
        },
        {
          id: "participant-team",
          type: "participant",
          attributes: {
            accountId: "account.teammate",
            stats: { name: "Teammate", playerId: "account.teammate", kills: 0, damageDealt: 40 },
          },
        },
        {
          id: "roster-me",
          type: "roster",
          relationships: {
            participants: { data: [{ id: "participant-me" }, { id: "participant-team" }] },
          },
        },
        { type: "asset", attributes: { URL: "https://assets.example/fixture.json" } },
      ],
    };
    const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("assets.example")) {
        return new Response(JSON.stringify(fixture.telemetry), { status: 200 });
      }
      return new Response(JSON.stringify(officialBody), { status: 200 });
    };

    const report = await runAccuracyAudit({
      source: "real_read_only",
      nickname: "FixturePlayer",
      platform: "steam",
      limit: 25,
      env: {
        PUBG_API_KEY: "test-api-key",
        NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
      },
      supabase: { from: () => query },
      fetchFn,
    });

    expect(report.source).toBe("real_read_only");
    expect(report.fallbackReason).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init?.method).toBe("GET");
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer test-api-key");
    expect(calls[1]?.init?.method).toBe("GET");
    expect(calls[1]?.init?.headers).not.toHaveProperty("Authorization");
    expect(report.remoteWritesAttempted).toBe(0);
    expect(report.externalAiCalls).toBe(0);
  });

  it("legacy recent pool은 입력 순서가 아니라 createdAt 내림차순을 따른다", async () => {
    const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as {
      matches: Array<Record<string, unknown>>;
      telemetry: Array<Record<string, unknown>>;
      teamNames: string[];
      teamAccountIds: string[];
    };
    const shuffled = {
      ...fixture,
      matches: [...fixture.matches].reverse(),
    };
    const original = await runAccuracyAudit({
      source: "synthetic_fixture",
      fixture,
      nickname: "FixturePlayer",
      platform: "steam",
      limit: 25,
    });
    const reordered = await runAccuracyAudit({
      source: "synthetic_fixture",
      fixture: shuffled,
      nickname: "FixturePlayer",
      platform: "steam",
      limit: 25,
    });
    expect(reordered.recentSelection.legacyCount).toBe(original.recentSelection.legacyCount);
    expect(reordered.recentSelection.legacyMatchFingerprints)
      .toEqual(original.recentSelection.legacyMatchFingerprints);
    expect(reordered.recentSelection.nextMatchFingerprints)
      .toEqual(original.recentSelection.nextMatchFingerprints);
  });

  it("의미 버전은 지정 값으로 한 번만 bump된다", () => {
    expect(RESULT_VERSION).toBe(73.0);
    expect(TELEMETRY_VERSION).toBe(61.0);
    expect(AI_CACHE_VERSION).toBe("2026-08-27.pubg-ai-accuracy-v1");
  });
});
