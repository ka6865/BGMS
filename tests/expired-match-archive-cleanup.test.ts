import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assessMatchRetentionCleanup,
  computeFullResultSourceChecksum,
  type MatchRetentionAccountEvidence,
  type MatchRetentionCleanupInput,
  type MatchRetentionObjectCandidate,
} from "../lib/pubg-analysis/matchRetentionCleanup";
import { buildSharedTelemetrySourceKey, createSharedTelemetrySource } from "../lib/pubg-analysis/sharedTelemetrySourceContract";
import { buildTelemetryCacheKey } from "../lib/pubg-analysis/telemetryCacheKey";
import { inspectDeletionKey } from "../lib/pubg-analysis/r2DeletionGuard";

const send = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class MockCommand {
    input: unknown;
    constructor(input: unknown) { this.input = input; }
  }
  class PutObjectCommand extends MockCommand {}
  class GetObjectCommand extends MockCommand {}
  class HeadObjectCommand extends MockCommand {}
  class ListObjectsV2Command extends MockCommand {}
  class DeleteObjectsCommand extends MockCommand {}
  return {
    S3Client: class { send = send; },
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand,
  };
});

const now = Date.parse("2026-10-06T00:00:00.000Z");
const matchId = "match.retention-1";
const playedAt = "2026-09-01T00:00:00.000Z";
const accountA = "account.Abc_123";
const accountB = "account.Other-456";

function accountEvidence(accountId: string, playerId: string, overrides: Record<string, unknown> = {}): MatchRetentionAccountEvidence {
  const basicMatch = {
    account_id: accountId,
    player_id: playerId,
    platform: "steam",
    match_id: matchId,
    played_at: playedAt,
    game_mode: "squad",
    map_name: "Baltic_Main",
    kills: 3,
    damage: 245,
    win_place: 2,
    match_type: "competitive",
  };
  const fullResult = { data: { id: matchId, attributes: { createdAt: playedAt } }, detail: "source" };
  const sourceChecksum = computeFullResultSourceChecksum(fullResult)!;
  const summary = {
    matchId,
    stats: { name: playerId, playerId: accountId, kills: 3, damageDealt: 245, winPlace: 2, rank: 2 },
  };
  const retained = {
    platform: "steam", account_id: accountId, match_id: matchId, player_id: playerId,
    played_at: playedAt, source_checksum: sourceChecksum, summary_version: 1, summary,
    ...overrides,
  };
  return {
    accountId,
    basicMatch,
    processedRows: [{ match_id: matchId, platform: "steam", player_id: playerId, data: { fullResult } }],
    retainedPerformanceRows: [retained],
  };
}

function personalMap(accountId: string, playerId: string, extra: Partial<MatchRetentionObjectCandidate> = {}): MatchRetentionObjectCandidate {
  return {
    kind: "personal-map",
    key: buildTelemetryCacheKey({ matchId, platform: "steam", playerId: accountId, mode: "full", telemetryVersion: 73 }),
    etag: '"etag-1"', sizeBytes: 100, sha256: "a".repeat(64), accountId, playerId,
    mode: "full", telemetryVersion: 73, ...extra,
  };
}

function eligibleInput(overrides: Partial<MatchRetentionCleanupInput> = {}): MatchRetentionCleanupInput {
  return {
    matchId, platform: "steam", playedAt, now,
    accounts: [accountEvidence(accountA, "alpha"), accountEvidence(accountB, "bravo")],
    referencedAccountIds: [accountA, accountB],
    source: {
      valid: true, playedAt, participantAccountIds: [accountA, accountB],
      participants: [
        { accountId: accountA, playerId: "alpha", kills: 3, damageDealt: 245, winPlace: 2 },
        { accountId: accountB, playerId: "bravo", kills: 3, damageDealt: 245, winPlace: 2 },
      ],
    },
    activeMapLease: false,
    pendingOrActiveDiscovery: false,
    pendingOrActivePerformanceJob: false,
    masterStoragePaths: [],
    objects: [personalMap(accountA, "alpha")],
    ...overrides,
  };
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function head(etag: string, size: number) {
  return { ETag: etag, ContentLength: size, ContentType: "application/json" };
}

function get(etag: string, body: Buffer) {
  return { ETag: etag, ContentLength: body.length, Body: { transformToByteArray: async () => Uint8Array.from(body) } };
}

describe("만료 전적 archive cleanup assessment", () => {
  function basicOnlyEvidence(): MatchRetentionAccountEvidence {
    const evidence = accountEvidence(accountB, 'bravo');
    return { ...evidence, basicMatch: { ...(evidence.basicMatch as object), retention_scope: 'basic_only' },
      detailReferenced: false, processedRows: [], retainedPerformanceRows: [] };
  }

  it('기본 수집 참가자의 상세 분석을 새로 만들지 않고 검증된 공통 원본만 정리한다', () => {
    const objects: MatchRetentionObjectCandidate[] = [{ kind: 'shared-source',
      key: buildSharedTelemetrySourceKey(matchId, 'steam'), etag: 'etag', sizeBytes: 100, sha256: 'a'.repeat(64) }];
    const result = assessMatchRetentionCleanup(eligibleInput({
      accounts: [accountEvidence(accountA, 'alpha'), basicOnlyEvidence()], objects,
    }));
    expect(result).toMatchObject({ eligible: true, retainedAccountCount: 2, plannedObjectCount: 1 });
  });

  it.each(['legacy', 'detail', undefined])('이전·상세·미분류 %s 기록은 요약 없이 허용하지 않는다', scope => {
    const evidence = basicOnlyEvidence();
    (evidence.basicMatch as any).retention_scope = scope;
    const result = assessMatchRetentionCleanup(eligibleInput({ accounts: [accountEvidence(accountA, 'alpha'), evidence] }));
    expect(result.reasons).toContain('account_snapshot_unverified');
  });

  it.each([true, undefined])('개인 자료 참조 확인이 %s이면 기본 수집 표시만으로 허용하지 않는다', detailReferenced => {
    const evidence = { ...basicOnlyEvidence(), detailReferenced };
    expect(assessMatchRetentionCleanup(eligibleInput({ accounts: [accountEvidence(accountA, 'alpha'), evidence] })).eligible).toBe(false);
  });

  it('기본 수집 표시라도 실제 분석 자료나 개인 객체가 있으면 요약을 요구한다', () => {
    const evidence = basicOnlyEvidence();
    evidence.processedRows = accountEvidence(accountB, 'bravo').processedRows;
    expect(assessMatchRetentionCleanup(eligibleInput({ accounts: [accountEvidence(accountA, 'alpha'), evidence] })).eligible).toBe(false);
    const basicEvidence = basicOnlyEvidence();
    expect(assessMatchRetentionCleanup(eligibleInput({ accounts: [accountEvidence(accountA, 'alpha'), basicEvidence],
      objects: [personalMap(accountB, 'bravo')] })).eligible).toBe(false);
  });

  it('기본 수집 기록의 공식 개인 스탯이 공통 원본과 다르면 원본 삭제를 막는다', () => {
    const evidence = basicOnlyEvidence();
    (evidence.basicMatch as any).kills = 4;
    const result = assessMatchRetentionCleanup(eligibleInput({ accounts: [accountEvidence(accountA, 'alpha'), evidence],
      objects: [{ kind: 'shared-source', key: buildSharedTelemetrySourceKey(matchId, 'steam'),
        etag: 'etag', sizeBytes: 100, sha256: 'a'.repeat(64) }] }));
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('shared_source_reference_not_preserved');
  });

  it("모든 참조 계정의 기본 전적과 compact identity/counters/rank/hash가 일치할 때 exact object만 계획한다", () => {
    const result = assessMatchRetentionCleanup(eligibleInput());

    expect(result).toMatchObject({ eligible: true, retainedAccountCount: 2, plannedObjectCount: 1, plannedBytes: 100 });
    expect(result.objects[0]).toMatchObject({ kind: "personal-map", accountId: accountA, playerId: "alpha" });
  });

  it.each([
    ["identity", { account_id: accountA }],
    ["kills", { summary: { matchId, stats: { name: "bravo", playerId: accountB, kills: 4, damageDealt: 245, winPlace: 2 } } }],
    ["damage", { summary: { matchId, stats: { name: "bravo", playerId: accountB, kills: 3, damageDealt: 250, winPlace: 2 } } }],
    ["rank", { summary: { matchId, stats: { name: "bravo", playerId: accountB, kills: 3, damageDealt: 245, winPlace: 4 } } }],
    ["checksum", { source_checksum: "b".repeat(64) }],
  ])("%s가 손상된 compact row는 보존 증거로 인정하지 않는다", (_label, retainedOverride) => {
    const accounts = [accountEvidence(accountA, "alpha"), accountEvidence(accountB, "bravo", retainedOverride)];
    const result = assessMatchRetentionCleanup(eligibleInput({ accounts }));

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("account_snapshot_unverified");
    expect(result.objects).toEqual([]);
  });

  it.each([
    ["recent", "2026-10-01T00:00:00.000Z"],
    ["future", "2026-10-07T00:00:00.000Z"],
    ["unknown", null],
  ])("%s 경기 시각이면 전체 정리를 막는다", (_label, date) => {
    const result = assessMatchRetentionCleanup(eligibleInput({ playedAt: date }));
    expect(result.eligible).toBe(false);
    expect(result.plannedObjectCount).toBe(0);
    expect(result.objects).toEqual([]);
  });

  it("compact row와 함께 남은 fullResult의 checksum이 불일치하면 차단한다", () => {
    const accounts = [accountEvidence(accountA, "alpha"), accountEvidence(accountB, "bravo")];
    accounts[1].processedRows = [{ match_id: matchId, platform: "steam", player_id: "bravo", data: { fullResult: { changed: true } } }];
    const result = assessMatchRetentionCleanup(eligibleInput({ accounts }));
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("account_snapshot_unverified");
  });

  it.each([
    ["map lease", { activeMapLease: true }],
    ["discovery work", { pendingOrActiveDiscovery: true }],
    ["performance work", { pendingOrActivePerformanceJob: true }],
  ])("%s가 있으면 참조된 객체 계획을 비운다", (_label, override) => {
    const result = assessMatchRetentionCleanup(eligibleInput(override));
    expect(result.eligible).toBe(false);
    expect(result.objects).toEqual([]);
  });

  it("참조된 다중 계정 중 compact snapshot이 하나라도 없으면 정리하지 않는다", () => {
    const result = assessMatchRetentionCleanup(eligibleInput({ accounts: [accountEvidence(accountA, "alpha")] }));
    expect(result.reasons).toContain("account_snapshot_missing");
    expect(result.eligible).toBe(false);
  });

  it("공유 source는 실제 match identity key에만 포함하고 master path가 있으면 제외한다", () => {
    const sourceObject: MatchRetentionObjectCandidate = {
      kind: "shared-source", key: buildSharedTelemetrySourceKey(matchId, "steam"),
      etag: '"source"', sizeBytes: 20, sha256: "c".repeat(64),
    };
    const result = assessMatchRetentionCleanup(eligibleInput({
      objects: [sourceObject], masterStoragePaths: [sourceObject.key],
    }));
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("master_storage_path_reference");
  });

  it("보호 이미지 key와 계정/경기가 맞지 않는 shared key를 계획에 넣지 않는다", () => {
    const result = assessMatchRetentionCleanup(eligibleInput({
      objects: [
        { ...personalMap(accountA, "alpha"), key: "crates/asset.webp" },
        { kind: "shared-source", key: "telemetry-source/v1/steam/another-match.json", etag: '"x"', sizeBytes: 10, sha256: "d".repeat(64) },
      ],
    }));
    expect(inspectDeletionKey("crates/asset.webp")).toEqual({ allowed: false, reason: "protected-prefix" });
    expect(result.objects).toEqual([]);
    expect(result.reasons).toContain("personal_object_identity_unverified");
    expect(result.reasons).toContain("shared_source_key_mismatch");
  });

  it("master storage path가 같은 personal map은 정확한 포인터 정리 대상으로 표시한다", () => {
    const map = personalMap(accountA, "alpha");
    const analysis = { ...map, kind: "personal-analysis" as const, key: map.key.replace(".json", "_analyze.json") };
    const result = assessMatchRetentionCleanup(eligibleInput({ objects: [map, analysis], masterStoragePaths: [map.key] }));
    expect(result.objects).toHaveLength(2);
    expect(result.objects.find((object) => object.kind === "personal-map")).toMatchObject({ masterPathReferenced: true });
  });
});

describe("R2 만료 전적 narrow delete guard", () => {
  beforeEach(() => {
    send.mockReset();
    process.env.CLOUDFLARE_R2_ENDPOINT = "https://r2.example.test";
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = "access";
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = "secret";
    process.env.CLOUDFLARE_R2_BUCKET_NAME = "telemetry";
  });

  it("exact key와 fresh bytes가 맞을 때 단일 객체를 지우고 missing HEAD를 확인한다", async () => {
    const { deleteExpiredPersonalMatchObjectFromR2 } = await import("../lib/pubg-analysis/r2Service");
    const body = Buffer.from('{"events":[]}');
    const key = buildTelemetryCacheKey({ matchId, platform: "steam", playerId: accountA, mode: "full", telemetryVersion: 73 });
    send
      .mockResolvedValueOnce(head('"etag-1"', body.length))
      .mockResolvedValueOnce(get('"etag-1"', body))
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }));

    await expect(deleteExpiredPersonalMatchObjectFromR2({
      kind: "personal-map", key, matchId, platform: "steam", accountId: accountA, playerId: "alpha",
      mode: "full", telemetryVersion: 73, playedAt, now, compactSnapshotPreserved: true, noActiveWork: true,
      expectedEtag: '"etag-1"', expectedSizeBytes: body.length, expectedSha256: sha256(body),
    })).resolves.toEqual({ deleted: true });

    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "HeadObjectCommand", "GetObjectCommand", "DeleteObjectsCommand", "HeadObjectCommand",
    ]);
    expect(send.mock.calls[2][0].input.Delete.Objects).toEqual([{ Key: key }]);
  });

  it("증거 누락·잘못된 identity·이미지 key는 R2 read/delete 전에 거부한다", async () => {
    const { deleteExpiredPersonalMatchObjectFromR2 } = await import("../lib/pubg-analysis/r2Service");
    const key = buildTelemetryCacheKey({ matchId, platform: "steam", playerId: accountA, mode: "full", telemetryVersion: 73 });
    const base = {
      kind: "personal-map" as const, key, matchId, platform: "steam" as const, accountId: accountA, playerId: "alpha",
      mode: "full" as const, telemetryVersion: 73, playedAt, now, compactSnapshotPreserved: true, noActiveWork: true,
      expectedEtag: '"etag"', expectedSizeBytes: 12, expectedSha256: "e".repeat(64),
    };

    await expect(deleteExpiredPersonalMatchObjectFromR2({ ...base, compactSnapshotPreserved: false }))
      .rejects.toThrow("r2-match-retention-personal-proof-invalid");
    await expect(deleteExpiredPersonalMatchObjectFromR2({ ...base, accountId: "not-an-account" }))
      .rejects.toThrow("r2-match-retention-personal-proof-invalid");
    await expect(deleteExpiredPersonalMatchObjectFromR2({ ...base, key: "crates/asset.webp" }))
      .rejects.toThrow("r2-match-retention-personal-proof-invalid");
    expect(send).not.toHaveBeenCalled();
  });

  it("fresh HEAD/GET checksum이나 ETag가 달라지면 삭제하지 않는다", async () => {
    const { deleteExpiredPersonalMatchObjectFromR2 } = await import("../lib/pubg-analysis/r2Service");
    const body = Buffer.from("replacement");
    const key = buildTelemetryCacheKey({ matchId, platform: "steam", playerId: accountA, mode: "full", telemetryVersion: 73 });
    send.mockResolvedValueOnce(head('"new-etag"', body.length)).mockResolvedValueOnce(get('"new-etag"', body));

    await expect(deleteExpiredPersonalMatchObjectFromR2({
      kind: "personal-map", key, matchId, platform: "steam", accountId: accountA, playerId: "alpha",
      mode: "full", telemetryVersion: 73, playedAt, now, compactSnapshotPreserved: true, noActiveWork: true,
      expectedEtag: '"old-etag"', expectedSizeBytes: body.length, expectedSha256: sha256(body),
    })).rejects.toThrow("r2-match-retention-personal-object-changed");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("shared source narrow delete는 canonical key와 경기일·모든 account participant를 다시 확인한다", async () => {
    const { deleteExpiredMatchSourceFromR2 } = await import("../lib/pubg-analysis/r2Service");
    const matchData = {
      data: { id: matchId, attributes: { createdAt: playedAt, mapId: "Baltic_Main", gameMode: "squad" } },
      included: [
        ...[accountA, accountB].map((accountId, index) => ({
          id: `participant-${index}`, type: "participant",
          attributes: { stats: { name: `player-${index}`, playerId: accountId, kills: 1, damageDealt: 100, winPlace: 2, timeSurvived: 500 } },
        })),
        { id: "roster", type: "roster", relationships: { participants: { data: [{ id: "participant-0" }, { id: "participant-1" }] } } },
      ],
    };
    const source = createSharedTelemetrySource(matchData, "steam", [
      { _T: "LogPlayerPosition", character: { accountId: accountA, name: "player-0" } },
      { _T: "LogPlayerPosition", character: { accountId: accountB, name: "player-1" } },
    ]);
    const body = Buffer.from(JSON.stringify(source));
    const key = buildSharedTelemetrySourceKey(matchId, "steam");
    send
      .mockResolvedValueOnce(head('"source-etag"', body.length))
      .mockResolvedValueOnce(get('"source-etag"', body))
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }));

    await expect(deleteExpiredMatchSourceFromR2({
      matchId, platform: "steam", playedAt, now, referencedAccountIds: [accountA, accountB],
      preservedAccountIds: [accountA, accountB], noActiveWork: true, expectedEtag: '"source-etag"',
      expectedSizeBytes: body.length, expectedSha256: sha256(body),
    })).resolves.toEqual({ deleted: true, key });
    expect(send.mock.calls[2][0].input.Delete.Objects).toEqual([{ Key: key }]);
  });

  it("shared source가 한 계정의 participant만 담거나 경기일이 proof와 다르면 삭제하지 않는다", async () => {
    const { deleteExpiredMatchSourceFromR2 } = await import("../lib/pubg-analysis/r2Service");
    const matchData = {
      data: { id: matchId, attributes: { createdAt: playedAt, mapId: "Baltic_Main", gameMode: "squad" } },
      included: [
        { id: "participant-0", type: "participant", attributes: { stats: { name: "alpha", playerId: accountA, kills: 1, damageDealt: 100, winPlace: 2, timeSurvived: 500 } } },
        { id: "roster", type: "roster", relationships: { participants: { data: [{ id: "participant-0" }] } } },
      ],
    };
    const body = Buffer.from(JSON.stringify(createSharedTelemetrySource(matchData, "steam", [
      { _T: "LogPlayerPosition", character: { accountId: accountA, name: "alpha" } },
    ])));
    send.mockResolvedValueOnce(head('"source-etag"', body.length)).mockResolvedValueOnce(get('"source-etag"', body));

    await expect(deleteExpiredMatchSourceFromR2({
      matchId, platform: "steam", playedAt, now, referencedAccountIds: [accountA, accountB],
      preservedAccountIds: [accountA, accountB], noActiveWork: true, expectedEtag: '"source-etag"',
      expectedSizeBytes: body.length, expectedSha256: sha256(body),
    })).rejects.toThrow("r2-match-retention-source-identity-invalid");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("일반 global deletion guard가 protected/shared keys를 계속 차단한다", async () => {
    const { deleteObjectsFromR2 } = await import("../lib/pubg-analysis/r2Service");
    const result = await deleteObjectsFromR2([
      "crates/asset.webp",
      "telemetry-source/v1/steam/match.retention-1.json",
      "backups/core.json",
      "telemetry-map/v73/steam/match.retention-1/hash/full.json",
    ]);

    expect(result.dryRun).toBe(true);
    expect(result.plannedCount).toBe(1);
    expect(result.blocked).toHaveLength(3);
    expect(send).not.toHaveBeenCalled();
  });
});
