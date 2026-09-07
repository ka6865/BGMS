import { describe, expect, it } from "vitest";
import {
  assertHttpsHost,
  readJsonBodyWithinLimit,
  validateMode,
  validateMatchIds,
  validatePlatform,
} from "../scripts/fetch_calculation_upgrade_raw_helpers";

describe("bounded calculation-upgrade raw acquisition helpers", () => {
  it("rejects traversal, malformed, and duplicate match IDs", () => {
    const valid = "61fb7fc0-5d36-4706-b0a8-a4297f5f7ba6";
    expect(validateMatchIds([valid])).toEqual([valid]);
    expect(() => validateMatchIds(["../secret"])).toThrow("invalid_match_id");
    expect(() => validateMatchIds([valid, valid])).toThrow("duplicate_match_id");
  });

  it("validates both supported PUBG shards and rejects unknown modes", () => {
    expect(validatePlatform("STEAM")).toBe("steam");
    expect(validatePlatform("kakao")).toBe("kakao");
    expect(validateMode("any")).toBe("any");
    expect(() => validatePlatform("xbox")).toThrow("invalid_platform");
    expect(() => validateMode("squad/fpp")).toThrow("invalid_mode");
  });

  it("rejects credentials and ports even for an otherwise allowed HTTPS host", () => {
    expect(() => assertHttpsHost("https://user:pass@api.pubg.com/path", /^api\.pubg\.com$/i, "api")).toThrow("host_rejected");
    expect(() => assertHttpsHost("https://api.pubg.com:8443/path", /^api\.pubg\.com$/i, "api")).toThrow("host_rejected");
    expect(assertHttpsHost("https://api.pubg.com/path", /^api\.pubg\.com$/i, "api").hostname).toBe("api.pubg.com");
  });

  it("cancels a reader when one chunk exceeds the per-response cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(11));
      },
      cancel() { cancelled = true; },
    });
    const response = new Response(body);
    await expect(readJsonBodyWithinLimit(response, { maxBytes: 10, label: "asset" })).rejects.toThrow("asset_byte_cap");
    expect(cancelled).toBe(true);
  });

  it("rejects a Content-Length over the cap before reading the body", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), {
      headers: { "content-length": "11" },
    });
    await expect(readJsonBodyWithinLimit(response, { maxBytes: 10, label: "asset" })).rejects.toThrow("asset_byte_cap");
    expect(cancelled).toBe(true);
  });

  it("cancels a reader when cumulative chunks exceed the remaining run budget", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
      cancel() { cancelled = true; },
    });
    const response = new Response(body);
    await expect(readJsonBodyWithinLimit(response, { maxBytes: 20, remainingBytes: 10, label: "asset" })).rejects.toThrow("asset_byte_cap");
    expect(cancelled).toBe(true);
  });
});
