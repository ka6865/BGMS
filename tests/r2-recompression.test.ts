import { describe, it, expect } from "vitest";
import {
  isRecompressTarget,
  runR2Recompression,
  RECOMPRESS_BATCH_LIMIT,
} from "../scripts/recompress_r2_json";

describe("R2 재압축 대상 판정: 이미지를 건드리지 않는다", () => {
  it("보호 경로 이미지를 제외한다", () => {
    expect(isRecompressTarget("crates/11010112.webp")).toBe(false);
    expect(isRecompressTarget("weapons/ar_akm.webp")).toBe(false);
  });

  it("경로가 달라도 이미지 확장자를 제외한다", () => {
    for (const ext of [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".bmp", ".ico"]) {
      expect(isRecompressTarget(`some/path/file${ext}`)).toBe(false);
    }
  });

  it("대소문자가 섞인 이미지도 제외한다", () => {
    expect(isRecompressTarget("Crates/Foo.WEBP")).toBe(false);
    expect(isRecompressTarget("root/IMAGE.PnG")).toBe(false);
  });

  it("삭제 목록 아카이브를 제외한다", () => {
    expect(isRecompressTarget("telemetry-inventory/2026-07-31.json")).toBe(false);
  });

  it("경로 탈출과 빈 키를 제외한다", () => {
    expect(isRecompressTarget("../secret.json")).toBe(false);
    expect(isRecompressTarget("/etc/passwd.json")).toBe(false);
    expect(isRecompressTarget("")).toBe(false);
  });

  it("JSON 이 아닌 객체를 제외한다", () => {
    expect(isRecompressTarget("telemetry-map/v60/steam/m/h/lite.txt")).toBe(false);
    expect(isRecompressTarget("some-object-without-extension")).toBe(false);
  });

  it("텔레메트리 JSON 캐시를 대상으로 삼는다", () => {
    expect(isRecompressTarget("abc-def_nick_v60_analyze.json")).toBe(true);
    expect(isRecompressTarget("telemetry-map/v60/steam/match/hash/lite.json")).toBe(true);
  });
});

describe("R2 재압축 실행 안전장치", () => {
  it("자격 증명이 없으면 실행하지 않는다", async () => {
    await expect(runR2Recompression({ env: {} }))
      .rejects.toThrow("r2-recompress-credentials-missing");
  });

  it("배치 상한이 안전한 범위로 정의되어 있다", () => {
    expect(RECOMPRESS_BATCH_LIMIT).toBeGreaterThan(0);
    expect(RECOMPRESS_BATCH_LIMIT).toBeLessThanOrEqual(5000);
  });
});
