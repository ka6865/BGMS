import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createTelemetryIdentity,
  createTelemetryPublicIdentity,
  parseTelemetryMode,
  parseTelemetryPlatform,
  telemetryPublicIdentityEquals,
} from "../lib/pubg-analysis/telemetryIdentity";
import {
  buildTelemetryCacheKey,
  buildTelemetryPlayerKey,
} from "../lib/pubg-analysis/telemetryCacheKey.server";
import {
  createTelemetryPayload,
  parseTelemetryEnvelope,
  parseTelemetryPayload,
} from "../lib/pubg-analysis/telemetryPayload";

vi.mock("server-only", () => ({}));

const identity = createTelemetryIdentity({
  matchId: "match-1",
  platform: "kakao",
  playerId: "account.player-1",
  mode: "full",
  telemetryVersion: 60,
});
const publicIdentity = createTelemetryPublicIdentity({
  matchId: identity.matchId,
  platform: identity.platform,
  playerKey: buildTelemetryPlayerKey(identity.playerId),
  mode: identity.mode,
  telemetryVersion: identity.telemetryVersion,
});

describe("telemetry identity", () => {
  it("지원 platform과 mode만 허용한다", () => {
    expect(parseTelemetryPlatform("steam")).toBe("steam");
    expect(parseTelemetryPlatform("kakao")).toBe("kakao");
    expect(() => parseTelemetryPlatform(undefined)).toThrow("platform");
    expect(() => parseTelemetryPlatform("xbox")).toThrow("platform");
    expect(parseTelemetryMode("lite")).toBe("lite");
    expect(parseTelemetryMode("full")).toBe("full");
    expect(() => parseTelemetryMode("raw")).toThrow("mode");
  });

  it("player 평문 없이 identity별 R2 key를 분리한다", () => {
    const first = buildTelemetryCacheKey(identity);
    const otherPlayer = buildTelemetryCacheKey({ ...identity, playerId: "account.player-2" });
    const otherPlatform = buildTelemetryCacheKey({ ...identity, platform: "steam" });
    const otherMode = buildTelemetryCacheKey({ ...identity, mode: "lite" });
    expect(first).toMatch(/^telemetry-map\/v60\/kakao\/match-1\/[a-f0-9]{32}\/full\.json$/);
    expect(first).not.toContain("account.player-1");
    expect(new Set([first, otherPlayer, otherPlatform, otherMode]).size).toBe(4);
  });

  it("payload와 envelope에는 공개 identity만 남기고 accountId를 제거한다", () => {
    const payload = createTelemetryPayload({
      identity: publicIdentity,
      startTime: "2026-07-18T00:00:00.000Z",
      teammates: [],
      teamNames: ["Player"],
      events: [],
      zoneEvents: [],
      mapName: "Desert_Main",
    });
    expect(parseTelemetryPayload(payload, publicIdentity)).toEqual(payload);
    expect(telemetryPublicIdentityEquals(payload.identity, publicIdentity)).toBe(true);
    expect(() => parseTelemetryPayload({ ...payload, identity: undefined }, publicIdentity)).toThrow();
    expect(() => parseTelemetryPayload(payload, { ...publicIdentity, playerKey: "0".repeat(32) })).toThrow();
    const envelope = parseTelemetryEnvelope({
      downloadUrl: "https://r2.example/signed",
      identity: publicIdentity,
    });
    expect(envelope.identity).toEqual(publicIdentity);

    const serializedPayload = JSON.stringify(payload);
    const serializedEnvelope = JSON.stringify(envelope);
    for (const serialized of [serializedPayload, serializedEnvelope]) {
      expect(serialized).not.toContain(identity.playerId);
      expect(serialized).not.toContain("playerId");
      expect(serialized).toContain(publicIdentity.playerKey);
    }
  });

  it("payload 본문의 accountId 원문을 거부한다", () => {
    expect(() => createTelemetryPayload({
      identity: publicIdentity,
      startTime: "2026-07-18T00:00:00.000Z",
      teammates: [identity.playerId],
      teamNames: ["Player"],
      events: [{ attackerAccountId: identity.playerId }],
      zoneEvents: [],
      mapName: "Desert_Main",
    })).toThrow("accountId");
  });

  it("registry migration은 RLS와 service-role 전용 계약을 고정한다", () => {
    const sql = fs.readFileSync(
      path.resolve("supabase/migrations/20260718152309_telemetry_map_cache_entries.sql"),
      "utf8",
    );
    expect(sql).toContain("create table if not exists public.telemetry_map_cache_entries");
    expect(sql).toContain("unique (match_id, platform, player_id, mode, telemetry_version)");
    expect(sql).toContain("enable row level security");
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toContain("revoke all on table public.telemetry_map_cache_entries from anon, authenticated");
    expect(sql).toContain("grant select, insert, update, delete on table public.telemetry_map_cache_entries to service_role");
    expect(sql).toMatch(
      /pg_get_serial_sequence\(\s*'public\.telemetry_map_cache_entries',\s*'id'\s*\)/,
    );
    expect(sql).toMatch(/revoke all on sequence[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant usage, select on sequence[\s\S]*to service_role/i);
    expect(sql).toContain("finalize_telemetry_cache_write");
    expect(sql).toMatch(/revoke all on function public\.finalize_telemetry_cache_write[\s\S]*from public, anon, authenticated/);
    expect(sql.indexOf("lock table public.telemetry_map_cache_entries"))
      .toBeLessThan(sql.indexOf("insert into public.match_master_telemetry"));
    expect(sql.indexOf("insert into public.match_master_telemetry"))
      .toBeLessThan(sql.indexOf("insert into public.processed_match_telemetry"));
  });

  it("recovery claim migration은 기존 ready/pending row를 원자적으로 보존한다", () => {
    const sql = fs.readFileSync(
      path.resolve("supabase/migrations/20260902171741_telemetry_cache_recovery_claim.sql"),
      "utf8",
    );
    expect(sql).toContain("claim_telemetry_cache_recovery_write");
    expect(sql).toMatch(/on conflict\s*\(match_id, platform, player_id, mode, telemetry_version\)\s*do nothing/i);
    expect(sql).toMatch(/security invoker/i);
    expect(sql).toMatch(/revoke all on function public\.claim_telemetry_cache_recovery_write[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.claim_telemetry_cache_recovery_write[\s\S]*to service_role/i);
    expect(sql).toContain("p_mode <> 'lite'");
  });
});
