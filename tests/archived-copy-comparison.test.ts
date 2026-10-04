import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSharedTelemetrySource, buildSharedTelemetrySourceKey } from "@/lib/pubg-analysis/sharedTelemetrySourceContract";
import { buildTelemetryPlayerKey } from "@/lib/pubg-analysis/telemetryCacheKey";
import { compareArchivedMatchCopies } from "@/lib/pubg-analysis/archivedCopyComparison";
import { runArchivedMatchCopyAudit } from "@/scripts/audit_archived_match_copies";

const TABLES = [
  "match_master_telemetry", "telemetry_map_cache_entries", "processed_match_telemetry",
  "pubg_player_matches", "pubg_player_match_discovery", "match_stats_raw", "global_benchmarks",
  "match_ai_coaching_cache", "attachments", "board_image_objects", "bonus_items",
  "crate_item_assets", "crate_items", "crate_templates", "prime_parcel_items", "support_attachments",
];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function legacyIdentity(match = "match-test") {
  return { version: "root", match, nickname: "Alice", kind: "analysis" };
}

function legacyBody() {
  return Buffer.from(JSON.stringify([{
    _T: "LogPlayerPosition",
    character: { name: "Alice", accountId: "account-alice", location: { x: 1, y: 2, z: 0 } },
  }]));
}

function legacyFixture() {
  const body = legacyBody();
  const inventory = [
    { key: "legacy/one_analyze.json", bytes: body.length, etag: "etag-one", modified: "2026-10-01T00:00:00.000Z" },
    { key: "legacy/two_analyze.json", bytes: body.length, etag: "etag-two", modified: "2026-10-01T00:00:00.000Z" },
  ];
  const identity = legacyIdentity();
  const db: Record<string, unknown[]> = Object.fromEntries(TABLES.map((table) => [table, []]));
  db.pubg_player_matches = [{ match_id: "match-test", account_id: "account-alice", platform: "steam" }];
  const tableRows = Object.fromEntries(TABLES.map((table) => [table, db[table].length]));
  const snapshot = {
    report: {
      complete: true, readOnly: true, pages: 1, objects: inventory.length,
      bytes: inventory.reduce((sum, row) => sum + row.bytes, 0), atomicSnapshot: false,
      tableRows, samples: inventory.length, sampleFailures: 0,
    },
    objects: inventory,
    database: db,
    inventoryArchives: [],
    samples: inventory.map((row) => ({ key: row.key, etag: row.etag, compressedBytes: row.bytes, sha256: sha(body) })),
  };
  const classify = (row: (typeof inventory)[number]) => ({ ...row, identity: structuredClone(identity), category: "logical-db" });
  const pairObject = (row: (typeof inventory)[number]) => ({
    ...classify(row), ageDays: 300, directRefs: [], pairedRefs: [], matchRefs: ["match-test"],
    ownNicknameRefs: ["nickname-ref"], archiveExact: true, archiveMatch: true, replacement: null,
  });
  const plan = {
    summary: {
      "legacy-byte-duplicate": { objects: 1, bytes: body.length },
      "superseded-map": { objects: 0, bytes: 0 },
      total: { objects: 1, bytes: body.length },
    },
    plans: [{ kind: "legacy-byte-duplicate", candidate: pairObject(inventory[0]), keep: pairObject(inventory[1]), requires: [] }],
  };
  const classified = { objects: inventory.map(classify), duplicateGroups: [] };
  return { snapshot, plan, classified, body, inventory };
}

function sharedMatchData() {
  return {
    data: { id: "match-test", attributes: {
      createdAt: "2026-09-01T00:00:00.000Z", mapName: "Erangel", gameMode: "squad",
    } },
    included: [
      { id: "participant-1", type: "participant", attributes: { stats: {
        name: "Alice", playerId: "account-alice", kills: 1, damageDealt: 100, winPlace: 3, timeSurvived: 600,
      } } },
      { id: "roster-1", type: "roster", relationships: { participants: { data: [{ id: "participant-1" }] } } },
    ],
  };
}

function makeFresh(fixture: ReturnType<typeof legacyFixture>, entries: Array<{ key: string; body: Buffer; etag?: string; contentEncoding?: string }>) {
  const inventory = entries.map((entry) => ({
    key: entry.key, bytes: entry.body.length, etag: entry.etag ?? `fresh-${entry.key}`,
    modified: "2026-10-05T00:00:00.000Z",
  }));
  fixture.snapshot.objects = inventory;
  fixture.snapshot.report.objects = inventory.length;
  fixture.snapshot.report.bytes = inventory.reduce((sum, row) => sum + row.bytes, 0);
  fixture.snapshot.samples = [];
  const candidateBase = fixture.plan.plans[0].candidate;
  const keepBase = fixture.plan.plans[0].keep;
  const planObject = (row: (typeof inventory)[number], base: typeof candidateBase) => ({
    ...row, identity: base.identity, category: base.category, ageDays: 300,
    directRefs: base.directRefs, pairedRefs: base.pairedRefs, matchRefs: base.matchRefs,
    ownNicknameRefs: base.ownNicknameRefs, archiveExact: true, archiveMatch: true, replacement: null,
  });
  fixture.plan.plans[0].candidate = planObject(inventory[0], candidateBase);
  fixture.plan.plans[0].keep = planObject(inventory[1], keepBase);
  fixture.classified.objects = inventory.map((row, index) => ({
    ...row, identity: index === 0 ? candidateBase.identity : keepBase.identity,
    category: index === 0 ? candidateBase.category : keepBase.category,
  }));
  fixture.snapshot.report.tableRows = Object.fromEntries(TABLES.map((table) => [table, fixture.snapshot.database[table].length]));
  return entries.map((entry, index) => ({
    key: entry.key, etag: inventory[index].etag, bytes: entry.body.length, body: entry.body,
    ...(entry.contentEncoding ? { contentEncoding: entry.contentEncoding } : {}),
  }));
}

describe("read-only archived R2 copy comparison", () => {
  it("uses full-body SHA evidence and leaves deletion blocked without fresh reads, conversion, and recalculation proof", () => {
    const fixture = legacyFixture();
    const { summary, privateRows } = compareArchivedMatchCopies(fixture);

    expect(summary.totals).toMatchObject({
      exactByteDuplicatePairs: 1,
      identicalLegacyArrayPairs: 0,
      commonSourceConversionProvenPairs: 0,
      provenCandidates: 0,
      deletionEligibleCandidates: 0,
    });
    expect(privateRows[0].bodyComparison).toBe("equal");
    expect(privateRows[0].hashEvidence).toBe("prior-read");
    expect(privateRows[0].blockers).toContain("fresh-current-body-reads-missing");
    expect(privateRows[0].blockers).toContain("legacy-recovery-alias-consumption-unverified");
    expect(privateRows[0].blockers).toContain("recalculation-proof-missing");
    expect(JSON.stringify(summary)).not.toContain("legacy/one_analyze.json");
  });

  it("marks inconsistent inventory counts incomplete and proves zero candidates", () => {
    const fixture = legacyFixture();
    fixture.snapshot.report.objects -= 1;
    const result = compareArchivedMatchCopies(fixture);

    expect(result.summary.inputs.inventoryComplete).toBe(false);
    expect(result.summary.totals.provenCandidates).toBe(0);
    expect(result.privateRows[0].blockers).toContain("snapshot-incomplete");
  });

  it("blocks mismatched match identities and plan metadata", () => {
    const fixture = legacyFixture();
    fixture.plan.plans[0].keep.identity.match = "different-match";
    const result = compareArchivedMatchCopies(fixture);

    expect(result.summary.totals.planIdentityShapeMatchedPairs).toBe(0);
    expect(result.summary.totals.metadataMatchedPairs).toBe(0);
    expect(result.summary.totals.provenCandidates).toBe(0);
    expect(result.privateRows[0].blockers).toContain("match-platform-account-identity-unproven");
  });

  it("treats conflicting full-body SHA evidence as a conflict even when the object metadata is unchanged", () => {
    const fixture = legacyFixture();
    const later = structuredClone(fixture.snapshot);
    later.samples[1].sha256 = "f".repeat(64);
    const result = compareArchivedMatchCopies({ ...fixture, sampleSnapshots: [later] });

    expect(result.privateRows[0].bodyComparison).toBe("conflict");
    expect(result.privateRows[0].blockers).toContain("body-hash-evidence-conflict");
    expect(result.summary.totals.provenCandidates).toBe(0);
  });

  it("does not treat a personalized projection:full marker as a complete common source", () => {
    const fixture = legacyFixture();
    const projected = Buffer.from(JSON.stringify({
      analyzeFormat: 2, projection: "full", identity: { matchId: "match-test", playerKey: "a".repeat(32) }, events: [],
    }));
    const freshBodies = makeFresh(fixture, [
      { key: fixture.inventory[0].key, body: projected },
      { key: fixture.inventory[1].key, body: projected },
    ]);
    const result = compareArchivedMatchCopies({ ...fixture, freshBodies });

    expect(result.summary.totals.projectionFullMarkers).toBe(1);
    expect(result.summary.totals.commonSourceConversionProvenPairs).toBe(0);
    expect(result.privateRows[0].blockers).toContain("complete-common-source-conversion-unproven");
    expect(result.summary.totals.deletionEligibleCandidates).toBe(0);
  });

  it("proves an exact legacy-array conversion only with a validated shared source envelope and still blocks deletion", () => {
    const fixture = legacyFixture();
    const event = JSON.parse(fixture.body.toString("utf8"))[0];
    const source = createSharedTelemetrySource(sharedMatchData(), "steam", [event]);
    const sourceKey = buildSharedTelemetrySourceKey("match-test", "steam");
    const sourceBody = Buffer.from(JSON.stringify(source));
    const freshBodies = makeFresh(fixture, [
      { key: fixture.inventory[0].key, body: fixture.body },
      { key: fixture.inventory[1].key, body: fixture.body },
      { key: sourceKey, body: sourceBody },
    ]);
    fixture.snapshot.database.pubg_player_matches = [{ match_id: "match-test", account_id: "account-alice", platform: "steam" }];
    fixture.snapshot.report.tableRows.pubg_player_matches = 1;
    const result = compareArchivedMatchCopies({ ...fixture, freshBodies });

    expect(result.summary.totals.commonSourceConversionProvenPairs).toBe(1);
    expect(result.summary.totals.identicalLegacyArrayPairs).toBe(1);
    expect(result.privateRows[0].commonSourceConversionProven).toBe(true);
    expect(result.privateRows[0].blockers).toContain("legacy-recovery-alias-consumption-unverified");
    expect(result.privateRows[0].blockers).toContain("recalculation-proof-missing");
    expect(result.summary.totals.deletionEligibleCandidates).toBe(0);
  });

  it("keeps a superseded map blocked while the old registry path remains referenced", () => {
    const fixture = legacyFixture();
    const account = "account-alice";
    const player = buildTelemetryPlayerKey(account);
    const matchId = "match-test";
    const makeMap = (version: number) => Buffer.from(JSON.stringify({
      identity: { matchId, platform: "steam", playerKey: player, mode: "lite", telemetryVersion: version },
      startTime: "2026-09-01T00:00:00.000Z", teammates: [player], teamNames: ["Alice"],
      events: [{ _T: "LogPlayerPosition", character: { name: "Alice", accountId: player, location: { x: 1, y: 2, z: 0 } } }],
      zoneEvents: [], mapName: "Erangel",
    }));
    const mapBodies = [makeMap(60), makeMap(61)];
    const mapPaths = [
      `telemetry-map/v60/steam/${matchId}/${player}/lite.json`,
      `telemetry-map/v61/steam/${matchId}/${player}/lite.json`,
    ];
    const inventory = mapPaths.map((key, index) => ({
      key, bytes: mapBodies[index].length, etag: `map-etag-${index}`, modified: "2026-10-01T00:00:00.000Z",
    }));
    const mapIdentity = (version: number) => ({ version: `v${version}`, platform: "steam", match: matchId, player, mode: "lite", kind: "map" });
    const makePlanObject = (index: number) => ({
      ...inventory[index], identity: mapIdentity(index === 0 ? 60 : 61), category: "direct", ageDays: 300,
      directRefs: ["telemetry_map_cache_entries"], pairedRefs: [], matchRefs: [], ownNicknameRefs: [],
      archiveExact: false, archiveMatch: false, replacement: mapPaths[1],
    });
    const db = fixture.snapshot.database;
    db.pubg_player_matches = [{ match_id: matchId, account_id: account, platform: "steam" }];
    db.telemetry_map_cache_entries = inventory.map((row) => ({
      match_id: matchId, platform: "steam", player_id: account, mode: "lite", storage_path: row.key,
    }));
    fixture.snapshot.objects = inventory;
    fixture.snapshot.report.objects = inventory.length;
    fixture.snapshot.report.bytes = inventory.reduce((sum, row) => sum + row.bytes, 0);
    fixture.snapshot.report.tableRows = Object.fromEntries(TABLES.map((table) => [table, db[table].length]));
    fixture.snapshot.samples = [];
    fixture.plan = {
      summary: {
        "legacy-byte-duplicate": { objects: 0, bytes: 0 }, "superseded-map": { objects: 1, bytes: inventory[0].bytes },
        total: { objects: 1, bytes: inventory[0].bytes },
      },
      plans: [{ kind: "superseded-map", candidate: makePlanObject(0), keep: makePlanObject(1), requires: [] }],
    } as unknown as typeof fixture.plan;
    fixture.classified.objects = inventory.map((row, index) => ({
      ...row, identity: mapIdentity(index === 0 ? 60 : 61), category: "direct",
    })) as unknown as typeof fixture.classified.objects;
    const sourceEvent = { _T: "LogPlayerPosition", character: { name: "Alice", accountId: account, location: { x: 1, y: 2, z: 0 } } };
    const sourceBody = Buffer.from(JSON.stringify(createSharedTelemetrySource(sharedMatchData(), "steam", [sourceEvent])));
    const freshBodies = makeFresh(fixture, [
      { key: mapPaths[0], body: mapBodies[0], etag: inventory[0].etag },
      { key: mapPaths[1], body: mapBodies[1], etag: inventory[1].etag },
      { key: buildSharedTelemetrySourceKey(matchId, "steam"), body: sourceBody },
    ]);
    const result = compareArchivedMatchCopies({ ...fixture, freshBodies });

    expect(result.summary.totals.supersededMapPairs).toBe(1);
    expect(result.privateRows[0].blockers).toContain("superseded-map-still-referenced");
    expect(result.summary.totals.deletionEligibleCandidates).toBe(0);
  });

  it("caps exact fresh object reads at twenty", () => {
    const fixture = legacyFixture();
    const body = fixture.body;
    const tooMany = Array.from({ length: 21 }, (_, index) => ({
      key: `unused/${index}`, etag: "etag", bytes: body.length, body,
    }));
    expect(() => compareArchivedMatchCopies({ ...fixture, freshBodies: tooMany })).toThrow("archived-copy-fresh-read-bound");
  });

  it("writes an aggregate result and an exclusive mode 0600 private manifest", async () => {
    const fixture = legacyFixture();
    const directory = await mkdtemp(join(tmpdir(), "bgms-archived-copy-"));
    tempDirectories.push(directory);
    const paths = {
      snapshot: join(directory, "snapshot.json"), plan: join(directory, "plan.json"),
      classified: join(directory, "classified.json"), manifest: join(directory, "private-manifest.json"),
    };
    for (const [path, value] of [
      [paths.snapshot, fixture.snapshot], [paths.plan, fixture.plan], [paths.classified, fixture.classified],
    ] as const) {
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });
      await chmod(path, 0o600);
    }
    const summary = await runArchivedMatchCopyAudit([
      "--snapshot", paths.snapshot, "--plan", paths.plan, "--classified", paths.classified, "--manifest", paths.manifest,
    ]);
    const output = await stat(paths.manifest);
    const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));

    expect("help" in summary).toBe(false);
    expect(output.mode & 0o777).toBe(0o600);
    expect(manifest.pairs[0].candidateKey).toBe("legacy/one_analyze.json");
    await expect(runArchivedMatchCopyAudit([
      "--snapshot", paths.snapshot, "--plan", paths.plan, "--classified", paths.classified, "--manifest", paths.manifest,
    ])).rejects.toThrow("archived-copy-manifest-already-exists");
  });
});
