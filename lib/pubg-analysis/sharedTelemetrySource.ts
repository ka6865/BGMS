import "server-only";
import { type TelemetryPlatform } from "./telemetryIdentity";
import { getMatchDetailRetention } from "./matchRetention";
import { downloadFromR2, uploadRecoveryObjectToR2 } from "./r2Service";
import { buildSharedTelemetrySourceKey, createSharedTelemetrySource, parseSharedTelemetrySource, type SharedTelemetrySource } from "./sharedTelemetrySourceContract";

export { buildSharedTelemetrySourceKey, parseSharedTelemetrySource, SHARED_TELEMETRY_FILTER_VERSION, type SharedTelemetrySource } from "./sharedTelemetrySourceContract";

export async function readSharedTelemetrySource(matchId: string, platform: TelemetryPlatform): Promise<SharedTelemetrySource | null> {
  const text = await downloadFromR2(buildSharedTelemetrySourceKey(matchId, platform));
  if (!text) return null;
  try { return parseSharedTelemetrySource(JSON.parse(text), matchId, platform); }
  catch { return null; }
}

/** Called only with events validated against the official, relationship-bound asset. */
export async function writeSharedTelemetrySource(matchData: any, platform: TelemetryPlatform, events: any[]): Promise<void> {
  const retention = getMatchDetailRetention(matchData?.data?.attributes?.createdAt);
  if (retention.status === "expired") throw new Error("PUBG_MATCH_DETAIL_EXPIRED");
  const envelope = createSharedTelemetrySource(matchData, platform, events);
  const { matchId } = envelope;
  const key = buildSharedTelemetrySourceKey(envelope.matchId, platform);
  try {
    // A and B can race; conditional creation keeps one corpus without replacing the winner.
    await uploadRecoveryObjectToR2(key, JSON.stringify(envelope), "application/json");
  } catch (error) {
    const conflict = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (conflict?.name !== "PreconditionFailed" && conflict?.$metadata?.httpStatusCode !== 412) throw error;
    if (!await readSharedTelemetrySource(matchId, platform)) throw new Error("shared-telemetry-create-conflict-invalid");
  }
}
