import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { compressJsonText, decodeMaybeGzip } from "../lib/pubg-analysis/r2Service";

describe("R2 압축: 텔레메트리 JSON 저장량을 줄인다", () => {
  it("압축 후 gzip 매직 넘버로 시작한다", () => {
    const compressed = compressJsonText('{"a":1}');
    expect(compressed[0]).toBe(0x1f);
    expect(compressed[1]).toBe(0x8b);
  });

  it("압축과 해제를 왕복해도 내용이 동일하다", () => {
    const original = JSON.stringify({
      events: Array.from({ length: 200 }, (_, index) => ({
        _T: "LogPlayerPosition",
        _D: `2026-07-31T00:00:${String(index % 60).padStart(2, "0")}Z`,
        character: { name: `player-${index}`, location: { x: index, y: index, z: 0 } },
      })),
    });

    expect(decodeMaybeGzip(compressJsonText(original))).toBe(original);
  });

  it("반복 구조가 많은 텔레메트리 JSON 에서 크게 줄어든다", () => {
    const payload = JSON.stringify({
      events: Array.from({ length: 500 }, (_, index) => ({
        _T: "LogPlayerPosition",
        _D: "2026-07-31T00:00:00Z",
        character: { name: "player", teamId: 1, location: { x: index, y: index, z: 100 } },
      })),
    });

    const ratio = compressJsonText(payload).length / Buffer.byteLength(payload, "utf8");
    expect(ratio).toBeLessThan(0.3);
  });

  it("한글과 유니코드가 손실 없이 왕복한다", () => {
    const original = JSON.stringify({ 닉네임: "테스트유저", 맵: "에란겔", emoji: "🎯" });
    expect(decodeMaybeGzip(compressJsonText(original))).toBe(original);
  });
});

describe("R2 압축: 기존 비압축 객체와 호환된다", () => {
  it("압축되지 않은 버퍼를 그대로 해석한다", () => {
    const plain = '{"legacy":true}';
    expect(decodeMaybeGzip(Buffer.from(plain, "utf8"))).toBe(plain);
  });

  it("외부에서 gzip 된 버퍼도 해제한다", () => {
    const plain = '{"external":true}';
    expect(decodeMaybeGzip(gzipSync(Buffer.from(plain, "utf8")))).toBe(plain);
  });

  it("빈 버퍼를 안전하게 처리한다", () => {
    expect(decodeMaybeGzip(Buffer.alloc(0))).toBe("");
  });

  it("1바이트 버퍼를 매직 넘버로 오판하지 않는다", () => {
    expect(decodeMaybeGzip(Buffer.from([0x1f]))).toBe("\u001f");
  });
});
