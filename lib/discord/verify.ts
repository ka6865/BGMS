import nacl from "tweetnacl";

export interface VerifyDiscordSignatureParams {
  rawBody: string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  publicKey: string | null | undefined;
}

/**
 * Validates an incoming Discord Interaction HTTP request using ed25519 signature verification.
 */
export function verifyDiscordSignature({
  rawBody,
  signature,
  timestamp,
  publicKey,
}: VerifyDiscordSignatureParams): boolean {
  if (!signature || !timestamp || !publicKey) {
    return false;
  }

  try {
    const signatureBuffer = Buffer.from(signature, "hex");
    const publicKeyBuffer = Buffer.from(publicKey, "hex");
    const messageBuffer = Buffer.from(timestamp + rawBody, "utf8");

    if (signatureBuffer.length !== 64 || publicKeyBuffer.length !== 32) {
      return false;
    }

    return nacl.sign.detached.verify(
      messageBuffer,
      signatureBuffer,
      publicKeyBuffer,
    );
  } catch {
    return false;
  }
}

