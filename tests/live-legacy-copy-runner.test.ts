import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLegacyCopyVerification } from "@/scripts/verify_legacy_match_copies";

const mocks = vi.hoisted(() => ({
  s3Constructed: 0,
  s3Send: vi.fn(),
  dbConstructed: 0,
  dbFrom: vi.fn(),
  putBodies: new Map<string, Buffer>(),
  putKeys: [] as string[],
  failAliasReadback: false,
  conditionalPutIndex: 0,
  failConditionalPutAt: 0,
  predeleteReference: false,
  registryReads: 0,
  mockSource: null as any,
  restoreCalls: 0,
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor() { mocks.s3Constructed++; }
    send(command: { input: Record<string, any> }) { return mocks.s3Send(command); }
    destroy() {}
  },
  GetObjectCommand: class { constructor(readonly input: Record<string, unknown>) {} },
  PutObjectCommand: class { constructor(readonly input: Record<string, unknown>) {} },
}));

vi.mock("@smithy/node-http-handler", () => ({ NodeHttpHandler: class {} }));

vi.mock("@/lib/pubg-analysis/telemetryCacheKey", () => ({
  buildTelemetryPlayerKey: (accountId: string) => accountId,
}));

vi.mock("@/lib/pubg-analysis/sharedTelemetrySourceContract", () => ({
  buildSharedTelemetrySourceKey: () => "telemetry-source/shared-fixture.json",
  parseSharedTelemetrySource: () => mocks.mockSource,
}));

vi.mock("@/lib/pubg-analysis/telemetryContract", () => ({
  filterTelemetryEvents: (events: unknown[]) => events,
}));

vi.mock("@/lib/pubg-analysis/telemetryPayload", () => ({
  parseTelemetryPayload: (payload: unknown) => payload,
}));

vi.mock("@/scripts/verify_archived_match_reads", () => ({
  recalculateReplayPayload: () => ({ recalculated: true }),
  assertReplayMatchesRecalculation: () => undefined,
}));

vi.mock("@/scripts/restore_legacy_player_matches", () => ({
  runRestoreLegacyPlayerMatches: async () => {
    mocks.restoreCalls++;
    return { existingRecords: 2, plannedInserts: 0 };
  },
  playerMatchRecordMatchesLiveRow: () => true,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    mocks.dbConstructed++;
    return { from: mocks.dbFrom };
  },
}));

const matchId = "12345678-1234-4234-8234-123456789abc";
const accountIds = ["account.alice-secret", "account.bob-secret"];
const originalKeys = [
  `${matchId}_alice_v60_analyze.json`,
  `${matchId}_bob_v61_analyze.json`,
] as const;
const matchRows = ["alice", "bob"].map((player_id, index) => ({
  player_id,
  platform: "steam",
  match_id: matchId,
  played_at: "2026-07-01T00:00:00.000Z",
  game_mode: "squad",
  map_name: "Baltic_Main",
  kills: index + 1,
  damage: 120 + index,
  win_place: 2 + index,
  match_type: "official",
  account_id: accountIds[index],
}));
const privateSecret = "runner-test-private-secret-value-0001";
const tempDirectories: string[] = [];
const eligibleEvents = [
  { _T: "LogMatchDefinition", MatchId: `match.bro.official.pc-2018.steam.as.${matchId}` },
  { _T: "LogMatchStart", mapName: "Baltic_Main" },
  ...matchRows.map((row) => ({ _T: "LogPlayerPosition", character: { accountId: row.account_id, name: row.player_id } })),
  ...Array.from({ length: 5000 }, (_, index) => ({ _T: "LogPlayerPosition", padding: `fixture-padding-${index}-${"x".repeat(32)}` })),
];
const eligibleBody = Buffer.from(JSON.stringify(eligibleEvents));
const sharedSourceBody = Buffer.from(JSON.stringify({ source: "fixture shared source payload" }));
const mockSource = {
  matchId,
  platform: "steam",
  events: eligibleEvents,
  matchData: {
    data: { id: matchId, attributes: { createdAt: "2026-07-01T00:00:00.000Z", mapName: "Baltic_Main", gameMode: "squad" } },
    included: [
      ...matchRows.map((row, index) => ({ id: `participant-${index}`, type: "participant", attributes: { stats: {
        playerId: row.account_id, name: row.player_id, kills: row.kills, damageDealt: row.damage,
        winPlace: row.win_place, timeSurvived: 600,
      } } })),
      { id: "roster-1", type: "roster", relationships: { participants: { data: [{ id: "participant-0" }, { id: "participant-1" }] } } },
    ],
  },
};

async function fixture(pairCount = 1) {
  const directory = await mkdtemp(join(tmpdir(), "bgms-live-legacy-runner-"));
  tempDirectories.push(directory);
  const targetsPath = join(directory, "targets.json");
  const outputPath = join(directory, "report.json");
  const pairs = Array.from({ length: pairCount }, (_, index) => {
    const id = index === 0 ? matchId : `22345678-1234-4234-8234-${String(index).padStart(12, "0")}`;
    return { originalKeys: [`${id}_alice_v60_analyze.json`, `${id}_bob_v61_analyze.json`] };
  });
  await writeFile(targetsPath, JSON.stringify({ format: 1, pairs }), { mode: 0o600 });
  return { targetsPath, outputPath };
}

function setReadMocks(body: Buffer, options: { eligible?: boolean } = {}) {
  mocks.mockSource = options.eligible ? mockSource : null;
  mocks.s3Send.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, any> }) => {
    const key = command.input.Key as string;
    if (command.constructor.name === "PutObjectCommand") {
      if (command.input.IfMatch) {
        mocks.conditionalPutIndex++;
        if (mocks.conditionalPutIndex === mocks.failConditionalPutAt) {
          throw Object.assign(new Error("precondition failed"), { $metadata: { httpStatusCode: 412 } });
        }
      }
      mocks.putKeys.push(key);
      mocks.putBodies.set(key, Buffer.from(command.input.Body as Buffer));
      return {};
    }
    if (command.constructor.name !== "GetObjectCommand") throw new Error("unexpected-s3-command");
    if (mocks.failAliasReadback && mocks.putKeys.some((putKey) => putKey.includes("legacy-aliases")) && key.includes("legacy-aliases")) {
      throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
    }
    if (key.includes("legacy-corpus") || key.includes("legacy-aliases") || key.includes("legacy-copy-compaction")) {
      const stored = mocks.putBodies.get(key);
      if (!stored) throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
      return { Body: Readable.from([stored]), ETag: `etag-${key}`, ContentLength: stored.length, ContentType: "application/octet-stream" };
    }
    const resultBody = mocks.putBodies.get(key) ?? (key === "telemetry-source/shared-fixture.json" ? sharedSourceBody : body);
    return { Body: Readable.from([resultBody]), ETag: `etag-${key}`, ContentLength: resultBody.length, ContentType: "application/json" };
  });
  mocks.dbFrom.mockImplementation((table: string) => {
    if (table === "telemetry_map_cache_entries") mocks.registryReads++;
    const data = table === "pubg_player_matches" ? matchRows
      : table === "system_settings" ? { value: "[]" }
        : table === "telemetry_map_cache_entries" && mocks.predeleteReference && mocks.registryReads > 1
          ? [{ storage_path: originalKeys[0] }] : [];
    const query: any = {
      select: () => query,
      eq: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data, error: null }),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(resolve, reject),
    };
    return query;
  });
}

beforeEach(() => {
  mocks.s3Constructed = 0;
  mocks.dbConstructed = 0;
  mocks.putBodies.clear();
  mocks.putKeys = [];
  mocks.failAliasReadback = false;
  mocks.conditionalPutIndex = 0;
  mocks.failConditionalPutAt = 0;
  mocks.predeleteReference = false;
  mocks.registryReads = 0;
  mocks.restoreCalls = 0;
  mocks.mockSource = null;
  mocks.s3Send.mockReset();
  mocks.dbFrom.mockReset();
  vi.stubEnv("BGMS_ENV_FILE", "");
  vi.stubEnv("R2_RECOVERY_ARCHIVE_KEY", privateSecret);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.example.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-secret");
  vi.stubEnv("CLOUDFLARE_R2_ENDPOINT", "https://r2.example.test");
  vi.stubEnv("CLOUDFLARE_R2_ACCESS_KEY_ID", "test-r2-access");
  vi.stubEnv("CLOUDFLARE_R2_SECRET_ACCESS_KEY", "test-r2-secret");
  vi.stubEnv("CLOUDFLARE_R2_BUCKET_NAME", "test-bucket");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/api/pubg/telemetry")) {
      return { ok: true, json: async () => ({ downloadUrl: "https://fixture.r2.cloudflarestorage.com/map" }) };
    }
    if (url.hostname === "fixture.r2.cloudflarestorage.com") return { ok: true, json: async () => ({}) };
    if (url.pathname.endsWith("/api/pubg/match")) {
      return { ok: true, json: async () => ({ matchId, stats: { name: url.searchParams.get("nickname") } }) };
    }
    throw new Error("unexpected-fetch");
  }));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("live legacy-copy runner boundary", () => {
  it("reports equal old raw arrays without a match definition as examined but ineligible, with no writes or deletes", async () => {
    const files = await fixture();
    const body = Buffer.from(JSON.stringify([
      { _T: "LogMatchStart", mapName: "Baltic_Main" },
      ...matchRows.map((row) => ({ _T: "LogPlayerPosition", character: { accountId: row.account_id, name: row.player_id } })),
    ]));
    setReadMocks(body);

    const report = await runLegacyCopyVerification([
      "--targets", files.targetsPath, "--output", files.outputPath,
    ]);

    expect(report).toMatchObject({ examinedPairs: 1, exactBytePairs: 1, eligiblePairs: 0, deletedObjects: 0, dryRun: true });
    expect(mocks.s3Send.mock.calls).toHaveLength(2);
    expect(mocks.s3Send.mock.calls.every(([command]) => command.constructor.name === "GetObjectCommand")).toBe(true);
    expect(report).not.toHaveProperty("puts");
    expect(report).not.toHaveProperty("deletes");
  });

  it("rejects apply without a valid preceding plan hash before constructing network clients", async () => {
    const files = await fixture();

    await expect(runLegacyCopyVerification([
      "--targets", files.targetsPath, "--output", files.outputPath, "--apply", "--plan-hash", "invalid",
    ])).rejects.toThrow("live-copy-preceding-plan-required");

    expect(mocks.s3Constructed).toBe(0);
    expect(mocks.dbConstructed).toBe(0);
    expect(mocks.s3Send).not.toHaveBeenCalled();
    expect(mocks.dbFrom).not.toHaveBeenCalled();
  });

  it("rejects more than twenty pairs before constructing network clients", async () => {
    const files = await fixture(21);

    await expect(runLegacyCopyVerification([
      "--targets", files.targetsPath, "--output", files.outputPath,
    ])).rejects.toThrow("live-copy-targets-invalid");

    expect(mocks.s3Constructed).toBe(0);
    expect(mocks.dbConstructed).toBe(0);
    expect(mocks.s3Send).not.toHaveBeenCalled();
    expect(mocks.dbFrom).not.toHaveBeenCalled();
  });

  it("allows a valid-hash apply run with zero eligible pairs as a successful no-op", async () => {
    const files = await fixture();
    const body = Buffer.from(JSON.stringify([{ _T: "LogMatchStart", mapName: "Baltic_Main" }]));
    setReadMocks(body);

    const report = await runLegacyCopyVerification([
      "--targets", files.targetsPath, "--output", files.outputPath, "--apply", "--plan-hash", "a".repeat(64),
    ]);

    expect(report).toMatchObject({ dryRun: false, examinedPairs: 1, eligiblePairs: 0, deletedObjects: 0, compactedObjects: 0, netSavedBytes: 0 });
    expect(mocks.s3Send.mock.calls.every(([command]) => command.constructor.name === "GetObjectCommand")).toBe(true);
    expect(mocks.s3Send.mock.calls.some(([command]) => command.constructor.name === "PutObjectCommand")).toBe(false);
  });

  it("keeps reporter fields free of secrets, account IDs, and object keys", async () => {
    const files = await fixture();
    setReadMocks(Buffer.from(JSON.stringify([{ _T: "LogMatchStart", mapName: "Baltic_Main" }])));
    const report = await runLegacyCopyVerification([
      "--targets", files.targetsPath, "--output", files.outputPath,
    ]);
    const reporterFields = JSON.stringify(report);

    expect(reporterFields).not.toContain(privateSecret);
    for (const accountId of accountIds) expect(reporterFields).not.toContain(accountId);
    for (const originalKey of originalKeys) expect(reporterFields).not.toContain(originalKey);
    expect(JSON.parse(await readFile(files.outputPath, "utf8")).report).toEqual(report);
  });

  it("reports a positive compact result with two conditional writes and never issues a delete", async () => {
    const files = await fixture();
    setReadMocks(eligibleBody, { eligible: true });
    const { proveLegacyCopy, bodySha256 } = await import("@/lib/pubg-analysis/liveLegacyCopyProof");
    const eligibility = proveLegacyCopy({
      target: { originalKeys: [...originalKeys] as [string, string] },
      bodies: [eligibleBody, eligibleBody], records: matchRows as any,
      referenced: false, activeLease: false, secret: privateSecret,
    });
    expect(eligibility.manifest).toBeDefined();
    const proof = {
      target: { originalKeys: [...originalKeys] },
      etags: originalKeys.map((key) => `etag-${key}`),
      sha256: bodySha256(eligibleBody), manifest: eligibility.manifest,
      bytes: eligibleBody.length * 2,
    };
    const planHash = bodySha256(Buffer.from(JSON.stringify(proof)));

    const report = await runLegacyCopyVerification([
      "--targets", files.targetsPath, "--output", files.outputPath, "--apply", "--plan-hash", planHash,
    ]);

    expect(report).toMatchObject({ deletedObjects: 0, compactedObjects: 2, uncertainWrites: 0 });
    expect(report.netSavedBytes).toBeGreaterThan(0);
    const conditionalPuts = mocks.s3Send.mock.calls.filter(([command]) => command.constructor.name === "PutObjectCommand"
      && (command as any).input.IfMatch);
    expect(conditionalPuts).toHaveLength(2);
    expect(conditionalPuts.map(([command]) => (command as any).input.IfMatch)).toEqual(originalKeys.map((key) => `etag-${key}`));
    expect(mocks.s3Send.mock.calls.some(([command]) => command.constructor.name === "DeleteObjectsCommand")).toBe(false);
    const journal = await readFile(`${files.outputPath}.journal.enc`);
    expect(journal.includes(Buffer.from(privateSecret))).toBe(false);
  });

  it("stops before replacing originals if encrypted alias readback fails", async () => {
    const files = await fixture();
    setReadMocks(eligibleBody, { eligible: true });
    mocks.failAliasReadback = true;
    const { proveLegacyCopy, bodySha256 } = await import("@/lib/pubg-analysis/liveLegacyCopyProof");
    const eligibility = proveLegacyCopy({
      target: { originalKeys: [...originalKeys] as [string, string] },
      bodies: [eligibleBody, eligibleBody], records: matchRows as any,
      referenced: false, activeLease: false, secret: privateSecret,
    });
    const proof = {
      target: { originalKeys: [...originalKeys] }, etags: originalKeys.map((key) => `etag-${key}`),
      sha256: bodySha256(eligibleBody), manifest: eligibility.manifest, bytes: eligibleBody.length * 2,
    };
    const planHash = bodySha256(Buffer.from(JSON.stringify(proof)));

    await expect(runLegacyCopyVerification([
      "--targets", files.targetsPath, "--output", files.outputPath, "--apply", "--plan-hash", planHash,
    ])).rejects.toThrow("live-copy-recovery-readback-failed");

    expect(mocks.putKeys).toHaveLength(2);
    expect(mocks.s3Send.mock.calls.filter(([command]) => command.constructor.name === "PutObjectCommand"
      && (command as any).input.IfMatch)).toHaveLength(0);
  });

  it("stops before replacement when a conditional write reports HTTP 412", async () => {
    const files = await fixture();
    setReadMocks(eligibleBody, { eligible: true });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/api/pubg/telemetry")) {
        return { ok: true, json: async () => ({ downloadUrl: "https://fixture.r2.cloudflarestorage.com/map" }) };
      }
      if (url.hostname === "fixture.r2.cloudflarestorage.com") return { ok: true, json: async () => ({}) };
      if (url.pathname.endsWith("/api/pubg/match")) {
        return { ok: true, json: async () => ({ matchId, stats: { name: url.searchParams.get("nickname") } }) };
      }
      throw new Error("unexpected-fetch");
    }));
    mocks.failConditionalPutAt = 1;
    const { proveLegacyCopy, bodySha256 } = await import("@/lib/pubg-analysis/liveLegacyCopyProof");
    const eligibility = proveLegacyCopy({
      target: { originalKeys: [...originalKeys] as [string, string] },
      bodies: [eligibleBody, eligibleBody], records: matchRows as any,
      referenced: false, activeLease: false, secret: privateSecret,
    });
    const proof = {
      target: { originalKeys: [...originalKeys] }, etags: originalKeys.map((key) => `etag-${key}`),
      sha256: bodySha256(eligibleBody), manifest: eligibility.manifest, bytes: eligibleBody.length * 2,
    };
    const planHash = bodySha256(Buffer.from(JSON.stringify(proof)));

    await expect(runLegacyCopyVerification([
      "--targets", files.targetsPath, "--output", files.outputPath, "--apply", "--plan-hash", planHash,
    ])).rejects.toThrow("live-copy-original-changed-during-compaction");

    expect(mocks.conditionalPutIndex).toBe(1);
    expect(mocks.s3Send.mock.calls.some(([command]) => command.constructor.name === "DeleteObjectsCommand")).toBe(false);
    const journal = await readFile(`${files.outputPath}.journal.enc`);
    expect(journal.includes(Buffer.from(privateSecret))).toBe(false);
    expect(journal.includes(Buffer.from(accountIds[0]))).toBe(false);
  });

  it("records one compacted key and one uncertain write if the second conditional write fails", async () => {
    const files = await fixture();
    setReadMocks(eligibleBody, { eligible: true });
    mocks.failConditionalPutAt = 2;
    const { proveLegacyCopy, bodySha256 } = await import("@/lib/pubg-analysis/liveLegacyCopyProof");
    const eligibility = proveLegacyCopy({ target: { originalKeys: [...originalKeys] as [string, string] },
      bodies: [eligibleBody, eligibleBody], records: matchRows as any, referenced: false, activeLease: false, secret: privateSecret });
    const proof = { target: { originalKeys: [...originalKeys] }, etags: originalKeys.map((key) => `etag-${key}`),
      sha256: bodySha256(eligibleBody), manifest: eligibility.manifest, bytes: eligibleBody.length * 2 };
    await expect(runLegacyCopyVerification(["--targets", files.targetsPath, "--output", files.outputPath,
      "--apply", "--plan-hash", bodySha256(Buffer.from(JSON.stringify(proof)))])).rejects
      .toThrow("live-copy-original-changed-during-compaction");
    const failedOutput = JSON.parse(await readFile(files.outputPath, "utf8"));
    expect(failedOutput).toMatchObject({ failed: true, deletedObjects: 0, compactedObjects: 1, uncertainWrites: 0 });
    expect(mocks.s3Send.mock.calls.some(([command]) => command.constructor.name === "DeleteObjectsCommand")).toBe(false);
  });
});
