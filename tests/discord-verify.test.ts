import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { verifyDiscordSignature } from "@/lib/discord/verify";

describe("discord signature verification", () => {
  const keyPair = nacl.sign.keyPair();
  const publicKeyHex = Buffer.from(keyPair.publicKey).toString("hex");

  it("verifies a valid ed25519 signature", () => {
    const rawBody = JSON.stringify({ type: 1 });
    const timestamp = "1724112000";
    const message = Buffer.from(timestamp + rawBody, "utf8");
    const signatureUint8 = nacl.sign.detached(message, keyPair.secretKey);
    const signatureHex = Buffer.from(signatureUint8).toString("hex");

    const isValid = verifyDiscordSignature({
      rawBody,
      signature: signatureHex,
      timestamp,
      publicKey: publicKeyHex,
    });

    expect(isValid).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const rawBody = JSON.stringify({ type: 1 });
    const timestamp = "1724112000";

    const isValid = verifyDiscordSignature({
      rawBody,
      signature: "00".repeat(64),
      timestamp,
      publicKey: publicKeyHex,
    });

    expect(isValid).toBe(false);
  });

  it("rejects when signature or timestamp is missing", () => {
    const rawBody = JSON.stringify({ type: 1 });

    expect(verifyDiscordSignature({
      rawBody,
      signature: null,
      timestamp: "1724112000",
      publicKey: publicKeyHex,
    })).toBe(false);

    expect(verifyDiscordSignature({
      rawBody,
      signature: "00".repeat(64),
      timestamp: null,
      publicKey: publicKeyHex,
    })).toBe(false);
  });

  it("rejects gracefully on malformed hex input", () => {
    const isValid = verifyDiscordSignature({
      rawBody: "{}",
      signature: "invalid-hex",
      timestamp: "1724112000",
      publicKey: publicKeyHex,
    });

    expect(isValid).toBe(false);
  });
});

