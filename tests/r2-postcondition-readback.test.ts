import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class MockCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    S3Client: class {
      send = send;
    },
    PutObjectCommand: MockCommand,
    GetObjectCommand: MockCommand,
    HeadObjectCommand: MockCommand,
    ListObjectsV2Command: MockCommand,
    DeleteObjectsCommand: MockCommand,
  };
});

describe("R2 postcondition read-back", () => {
  beforeEach(() => {
    send.mockReset();
    process.env.CLOUDFLARE_R2_ENDPOINT = "https://r2.example.test";
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = "access";
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = "secret";
    process.env.CLOUDFLARE_R2_BUCKET_NAME = "telemetry";
  });

  it("performs an exact-key HEAD and GET and returns immutable bytes", async () => {
    const { readObjectForVerification } = await import("../lib/pubg-analysis/r2Service");
    const body = Buffer.from('{"fullResult":{"v":73}}', "utf8");
    send
      .mockResolvedValueOnce({ ETag: '"etag-73"' })
      .mockResolvedValueOnce({
        ETag: '"etag-73"',
        Body: { transformToByteArray: async () => Uint8Array.from(body) },
      });

    await expect(readObjectForVerification("telemetry-map/v61/steam/match/hash/lite.json"))
      .resolves.toEqual({
        key: "telemetry-map/v61/steam/match/hash/lite.json",
        etag: '"etag-73"',
        body,
      });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].input).toMatchObject({
      Bucket: "telemetry",
      Key: "telemetry-map/v61/steam/match/hash/lite.json",
    });
    expect(send.mock.calls[1][0].input).toMatchObject({
      Bucket: "telemetry",
      Key: "telemetry-map/v61/steam/match/hash/lite.json",
    });
  });

  it("uses an atomic If-None-Match create for recovery uploads and returns ETag/hash", async () => {
    const { uploadRecoveryObjectToR2 } = await import("../lib/pubg-analysis/r2Service");
    const body = '{"fullResult":{"v":73}}';
    send.mockResolvedValueOnce({ ETag: '"etag-created"' });

    await expect(uploadRecoveryObjectToR2(
      "telemetry-map/v61/steam/match/hash/lite.json",
      body,
      "application/json",
    )).resolves.toMatchObject({
      etag: '"etag-created"',
      bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(send.mock.calls[0][0].input).toMatchObject({
      Bucket: "telemetry",
      Key: "telemetry-map/v61/steam/match/hash/lite.json",
      IfNoneMatch: "*",
    });
  });

  it("keeps postcondition verification read-only; request-time recovery deletion is removed", () => {
    const source = readFileSync("lib/pubg-analysis/r2Service.ts", "utf8");

    expect(source).not.toContain("DeleteObjectCommand");
    expect(source).not.toContain("deleteRecoveryObjectIfOwned");
  });
});
