import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeReplayEvents, encodeReplayEvents } from "@/lib/pubg-analysis/replayTrackEncoding";
import { parseTelemetryPayload, serializeTelemetryPayload, type TelemetryPayload } from "@/lib/pubg-analysis/telemetryPayload";

const loadReplay = (name: string): TelemetryPayload =>
  parseTelemetryPayload(JSON.parse(readFileSync(`public/learn/replays/${name}.json`, "utf8")));

function position(relativeTimeMs: number, name: string, x: number) {
  return {
    type: "position",
    time: new Date(Date.UTC(2026, 6, 18) + relativeTimeMs).toISOString(),
    relativeTimeMs,
    name,
    teamId: 3,
    isTeam: false,
    x,
    y: 200,
    z: 1.5,
    health: 100,
    vehicleId: null,
  };
}

describe("리플레이 track 인코딩", () => {
  it.each(["2026-09-22-squad", "2026-09-22-solo"])("실제 경기 %s를 순서·키 순서까지 그대로 복원한다", (name) => {
    const payload = loadReplay(name);
    const encoded = encodeReplayEvents(payload.events);

    expect(encoded).not.toBeNull();
    expect(encoded!.tracks.length).toBeGreaterThan(50);
    const decoded = decodeReplayEvents(encoded!.encoding, JSON.parse(JSON.stringify(encoded!.events)), encoded!.tracks);
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(payload.events));
  });

  it("저장 형식은 기존 이벤트 배열보다 작고 parseTelemetryPayload로 같은 페이로드가 된다", () => {
    const payload = loadReplay("2026-09-22-squad");
    const serialized = serializeTelemetryPayload(payload);

    expect(serialized.length).toBeLessThan(JSON.stringify(payload).length * 0.8);
    expect(parseTelemetryPayload(JSON.parse(serialized), payload.identity)).toEqual(payload);
  });

  it("시간 기준과 맞지 않는 좌표와 폭발 시각이 다른 투척 이벤트는 일반 이벤트로 남긴다", () => {
    const delayed = { ...position(5_000, "Enemy", 300), time: "2026-07-18T00:00:09.000Z" };
    const grenade = { type: "grenade", time: "2026-07-18T00:00:12.000Z", relativeTimeMs: 8_000, x: 1, y: 2 };
    const events = [position(0, "Enemy", 100), delayed, grenade, position(10_000, "Enemy", 500)];
    const encoded = encodeReplayEvents(events)!;

    expect(encoded.events).toEqual([0, delayed, grenade, 0]);
    expect(encoded.tracks[0].t).toEqual([0, 10_000]);
    expect(decodeReplayEvents(encoded.encoding, encoded.events, encoded.tracks)).toEqual(events);
  });

  it("time이 없는 이벤트가 있으면 압축하지 않아 기존 형식으로 저장한다", () => {
    const payload = { ...loadReplay("2026-09-22-solo") };
    payload.events = [...payload.events, { type: "marker", relativeTimeMs: 10 }];

    expect(encodeReplayEvents(payload.events)).toBeNull();
    expect(JSON.parse(serializeTelemetryPayload(payload))).not.toHaveProperty("encoding");
  });

  it("track 참조 수와 길이가 맞지 않으면 거부한다", () => {
    const encoded = encodeReplayEvents([position(0, "Enemy", 100), position(10_000, "Enemy", 200)])!;

    expect(() => decodeReplayEvents(encoded.encoding, [0], encoded.tracks)).toThrow("track 길이");
    expect(() => decodeReplayEvents(encoded.encoding, [0, 0, 0], encoded.tracks)).toThrow("track 참조");
    expect(() => decodeReplayEvents(encoded.encoding, [1], encoded.tracks)).toThrow("track 참조");
    expect(() => decodeReplayEvents({ version: 2, timeBaseMs: 0 }, encoded.events, encoded.tracks)).toThrow("encoding");
  });
});
