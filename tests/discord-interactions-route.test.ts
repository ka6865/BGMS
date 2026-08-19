import { describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import { POST } from "@/app/api/discord/interactions/route";

describe("discord interactions route", () => {
  const keyPair = nacl.sign.keyPair();
  const publicKeyHex = Buffer.from(keyPair.publicKey).toString("hex");

  function createSignedRequest(body: object, timestamp = "1724112000") {
    const rawBody = JSON.stringify(body);
    const message = Buffer.from(timestamp + rawBody, "utf8");
    const signatureHex = Buffer.from(nacl.sign.detached(message, keyPair.secretKey)).toString("hex");

    return new Request("http://localhost:3000/api/discord/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-Ed25519": signatureHex,
        "X-Signature-Timestamp": timestamp,
      },
      body: rawBody,
    });
  }

  it("rejects unauthorized requests with invalid signature", async () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);

    const req = new Request("http://localhost:3000/api/discord/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-Ed25519": "invalid-signature",
        "X-Signature-Timestamp": "1724112000",
      },
      body: JSON.stringify({ type: 1 }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("responds with type 1 (PONG) to type 1 (PING) requests", async () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);

    const req = createSignedRequest({ type: 1 });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({ type: 1 });
  });

  it("routes /link command properly", async () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);

    const req = createSignedRequest({
      type: 2,
      data: {
        name: "연동",
        options: [
          { name: "nickname", value: "TestGamer" },
          { name: "platform", value: "steam" },
        ],
      },
      member: {
        user: { id: "discord_user_999" },
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.type).toBe(4);
  });
});
