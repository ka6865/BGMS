import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

describe("텔레메트리 소비자 계약", () => {
  const useTelemetrySource = source("hooks/useTelemetry.ts");
  const replay3dSource = source("app/replay/3d/page.tsx");
  const squad2dSource = source("components/stat/Squad2DMap.tsx");
  const expandedMatchDetailsSource = source("components/stat/matches/ExpandedMatchDetails.tsx");
  const mapShellSource = source("components/map/MapShell.tsx");
  const latestRequestSource = source("hooks/useLatestTelemetryRequest.ts");

  it("hook·3D·Squad 2D가 공용 fetch만 사용한다", () => {
    expect(useTelemetrySource).toContain("fetchTelemetryPayload");
    expect(replay3dSource).toContain("fetchTelemetryPayload");
    expect(squad2dSource).toContain("fetchTelemetryPayload");
    expect(useTelemetrySource).not.toContain("/api/pubg/telemetry");
    expect(replay3dSource).not.toContain("/api/pubg/telemetry");
    expect(squad2dSource).not.toContain("/api/pubg/telemetry");
    expect(useTelemetrySource).not.toContain("downloadUrl");
    expect(replay3dSource).not.toContain("downloadUrl");
    expect(squad2dSource).not.toContain("downloadUrl");
  });

  it("hook·3D·Squad 2D가 platform과 AbortSignal을 공용 fetch에 전달한다", () => {
    expect(useTelemetrySource).toContain("platform: playbackPlatform");
    expect(useTelemetrySource).toContain("signal: controller.signal");
    expect(replay3dSource).toContain("platform: targetPlatform");
    expect(replay3dSource).toContain("signal: request.controller.signal");
    expect(squad2dSource).toContain("platform: telemetryPlatform");
    expect(squad2dSource).toContain("signal: controller.signal");
    expect(replay3dSource).not.toMatch(/platform\s*\|\|\s*["']steam["']/);
  });

  it("ExpandedMatchDetails의 두 2D URL이 platform을 인코딩해 전달한다", () => {
    expect(expandedMatchDetailsSource.match(/platform=\$\{encodeURIComponent\(platform\)\}/g)).toHaveLength(2);
  });

  it("MapShell이 완전한 playback identity를 fail-closed 검증하고 hook에 전달한다", () => {
    expect(mapShellSource).toContain("playbackPlatform");
    expect(mapShellSource).toContain("playbackMode");
    expect(mapShellSource).toMatch(
      /useTelemetry\(playbackId, playbackNickname, playbackPlatform, playbackMode, activeMapId\)/,
    );
    expect(mapShellSource).not.toMatch(/searchParams\?\.get\(["']platform["']\)\s*\|\|\s*["']steam["']/);
    expect(mapShellSource).toContain("playbackIdentityError");
    expect(mapShellSource).toContain('searchParams?.get("mode") ?? null');
    expect(mapShellSource).not.toContain('searchParams?.get("mode") || null');
    expect(mapShellSource).toContain("error={playbackIdentityError || telemetryError}");
    expect(mapShellSource).toContain("isActive: !!playbackId && !playbackIdentityError");
    expect(mapShellSource).toContain("safeTelemetryEvents");
    expect(mapShellSource).toContain("safeCurrentStates");
    expect(mapShellSource).toContain("safeTeamNames");
    expect(mapShellSource).toContain("safeZoneEvents");
  });

  it("닫기 동작이 replay query 네 개를 모두 제거한다", () => {
    for (const query of ["playback", "nickname", "platform", "mode"]) {
      expect(mapShellSource).toContain(`p.delete("${query}")`);
    }
  });

  it("3D 자동·수동 요청이 같은 latest request 경계와 상태 초기화를 사용한다", () => {
    expect(replay3dSource).toContain("useLatestTelemetryRequest");
    expect(replay3dSource).toContain("resetReplayState");
    expect(replay3dSource.match(/startTelemetryRequest\(/g)).toHaveLength(2);
    expect(replay3dSource).toContain("isCurrent(request)");
    expect(replay3dSource).toContain("cancelRequest(request)");
    expect(replay3dSource).toContain("resolveReplay3DRequest");
  });

  it("latest request token은 실제 판정에 쓰는 controller만 유지한다", () => {
    expect(latestRequestSource).not.toContain("identity:");
    expect(latestRequestSource).not.toContain("sequence");
  });

  it("Squad 2D identity 전환은 이전 payload와 재생 상태를 즉시 초기화한다", () => {
    expect(squad2dSource).toContain("resetSquadReplayState");
    expect(squad2dSource).toMatch(
      /resetSquadReplayState[\s\S]*setTelemetry\(null\)[\s\S]*setIsPlaying\(false\)[\s\S]*setPlaybackTimeMs\(0\)/,
    );
    expect(squad2dSource).toMatch(/loadTelemetry[\s\S]*resetSquadReplayState\(\)/);
  });

  it("useTelemetry가 identity 전환·누락·실패 전에 이전 리플레이 상태를 초기화한다", () => {
    expect(useTelemetrySource).toContain("resetTelemetryState");
    expect(useTelemetrySource).toContain("controller.signal.aborted");
    expect(useTelemetrySource).toMatch(/resetTelemetryState\(\);[\s\S]*if \(!matchId/);
  });
});
