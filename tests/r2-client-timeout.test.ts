import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockNodeHttpHandler, mockS3Client, mockSend } = vi.hoisted(() => {
  const mockSend = vi.fn().mockResolvedValue({});
  return {
    mockNodeHttpHandler: vi.fn(function MockNodeHttpHandler(options: unknown) {
      return { options };
    }),
    mockS3Client: vi.fn(function MockS3Client() {
      return { send: mockSend };
    }),
    mockSend,
  };
});

vi.mock("@smithy/node-http-handler", () => ({
  NodeHttpHandler: mockNodeHttpHandler,
}));

vi.mock("@aws-sdk/client-s3", () => {
  class MockCommand {
    constructor(readonly input: unknown) {}
  }
  return {
    S3Client: mockS3Client,
    PutObjectCommand: MockCommand,
    GetObjectCommand: MockCommand,
    ListObjectsV2Command: MockCommand,
    HeadObjectCommand: MockCommand,
    DeleteObjectsCommand: MockCommand,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://r2.example/signed"),
}));

import { uploadToR2 } from "../lib/pubg-analysis/r2Service";

describe("R2 client timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    vi.stubEnv("CLOUDFLARE_R2_ENDPOINT", "https://r2.example");
    vi.stubEnv("CLOUDFLARE_R2_ACCESS_KEY_ID", "access-key");
    vi.stubEnv("CLOUDFLARE_R2_SECRET_ACCESS_KEY", "secret-key");
    vi.stubEnv("CLOUDFLARE_R2_BUCKET_NAME", "telemetry");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("R2 요청은 연결 3초·소켓 10초로 제한하고 일시 오류를 1회 재시도한다", async () => {
    await uploadToR2("test.json", "{}", "application/json");

    expect(mockNodeHttpHandler).toHaveBeenCalledWith({
      connectionTimeout: 3_000,
      socketTimeout: 10_000,
    });
    expect(mockS3Client).toHaveBeenCalledWith(expect.objectContaining({
      maxAttempts: 2,
      requestHandler: expect.any(Object),
    }));
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
