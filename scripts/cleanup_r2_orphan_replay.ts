/**
 * @fileoverview 등록부에 없는 R2 리플레이 캐시(고아 객체)를 정리합니다.
 *
 * `telemetry-map/v{version}/{platform}/{matchId}/{playerHash}/{mode}.json` 은
 * 지도 리플레이 재생 데이터 캐시입니다. 정상 경로에서는 생성 시
 * telemetry_map_cache_entries 에 등록되고 정리 대상으로 추적됩니다.
 *
 * 그러나 R2 삭제 코드가 없던 기간에 등록부 행만 정리되어 파일이 남은 객체가
 * 존재합니다. 실측 결과 미등록 객체는 전부 3일 이상 경과했고 대부분 DB 에
 * 매치가 없는 고아입니다.
 *
 * 이 스크립트는 다음 세 조건을 모두 만족하는 객체만 삭제합니다.
 *   1. 등록부(storage_path)에 없음
 *   2. DB match_master_telemetry 에 매치가 없음
 *   3. 생성 후 최소 경과일을 넘김
 *
 * 기본은 dry-run 입니다. 실제 삭제는 `--apply` 를 명시해야 수행됩니다.
 * 이미지 자산은 r2DeletionGuard 가 구조적으로 차단합니다.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { deleteObjectsFromR2 } from "../lib/pubg-analysis/r2Service";
import { partitionDeletionKeys } from "../lib/pubg-analysis/r2DeletionGuard";

/** 리플레이 캐시 접두사. 이 경로만 조회 대상으로 삼습니다. */
export const REPLAY_KEY_PREFIX = "telemetry-map/";

// 최근 생성분은 등록 처리 중일 수 있어 보호합니다.
export const REPLAY_ORPHAN_MIN_AGE_DAYS = 3;

// 등록부 및 매치 조회 페이지 크기.
const REGISTRY_PAGE_SIZE = 1000;
const MATCH_LOOKUP_CHUNK = 300;

export type ReplayObject = {
  key: string;
  matchId: string;
  sizeBytes: number;
  ageDays: number;
};

export type ReplayCleanupResult = {
  scannedObjects: number;
  registryPaths: number;
  unregisteredObjects: number;
  uniqueMatchIds: number;
  referencedMatchIds: number;
  candidates: number;
  candidateBytes: number;
  blockedByGuard: number;
  deletedCount: number;
  failedCount: number;
  dryRun: boolean;
};

type ListClient = Pick<S3Client, "send">;
type SupabaseLike = Pick<SupabaseClient, "from">;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * 리플레이 캐시 키에서 매치 ID 를 추출합니다.
 * 형태가 다르면 null 을 반환해 삭제 대상에서 제외합니다.
 */
export function extractMatchIdFromReplayKey(key: string): string | null {
  if (!key.startsWith(REPLAY_KEY_PREFIX)) return null;

  // telemetry-map / v60 / platform / matchId / playerHash / mode.json
  const segments = key.split("/");
  if (segments.length !== 6) return null;
  if (!/^v\d+$/i.test(segments[1])) return null;
  if (!segments[2] || !segments[4]) return null;
  if (!segments[5].toLowerCase().endsWith(".json")) return null;

  const matchId = segments[3];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(matchId)) {
    return null;
  }

  return matchId.toLowerCase();
}

/**
 * 삭제 후보를 선별합니다.
 * 등록부에 있거나, DB 에 매치가 있거나, 경과일이 부족하면 제외합니다.
 */
export function selectReplayOrphanCandidates(
  objects: readonly ReplayObject[],
  registryPaths: ReadonlySet<string>,
  referencedMatchIds: ReadonlySet<string>,
  minAgeDays = REPLAY_ORPHAN_MIN_AGE_DAYS,
): ReplayObject[] {
  return objects.filter((object) => (
    !registryPaths.has(object.key)
    && !referencedMatchIds.has(object.matchId)
    && object.ageDays >= minAgeDays
  ));
}

/** 리플레이 캐시 객체를 수집합니다. */
async function listReplayObjects(
  client: ListClient,
  bucket: string,
  now: Date,
): Promise<{ scanned: number; objects: ReplayObject[] }> {
  const objects: ReplayObject[] = [];
  let continuationToken: string | undefined;
  let scanned = 0;

  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: REPLAY_KEY_PREFIX,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    })) as {
      Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }>;
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    };

    for (const item of response.Contents ?? []) {
      scanned += 1;
      const key = item.Key ?? "";
      const matchId = extractMatchIdFromReplayKey(key);
      if (!matchId) continue;

      const modifiedAt = item.LastModified?.getTime() ?? now.getTime();
      objects.push({
        key,
        matchId,
        sizeBytes: item.Size ?? 0,
        ageDays: Math.floor((now.getTime() - modifiedAt) / 86_400_000),
      });
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return { scanned, objects };
}

/** 등록부에 기록된 storage_path 전체를 수집합니다. */
async function fetchRegistryPaths(supabase: SupabaseLike): Promise<Set<string>> {
  const paths = new Set<string>();

  for (let from = 0; ; from += REGISTRY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("telemetry_map_cache_entries")
      .select("storage_path")
      .range(from, from + REGISTRY_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`telemetry_map_cache_entries 조회 실패: ${error.message}`);
    }

    const rows = (data ?? []) as Array<{ storage_path: string | null }>;
    for (const row of rows) {
      if (row.storage_path) paths.add(row.storage_path);
    }

    if (rows.length < REGISTRY_PAGE_SIZE) break;
  }

  return paths;
}

/** DB 에 존재하는 매치 ID 집합을 조회합니다. */
async function fetchReferencedMatchIds(
  supabase: SupabaseLike,
  matchIds: readonly string[],
): Promise<Set<string>> {
  const referenced = new Set<string>();

  for (let index = 0; index < matchIds.length; index += MATCH_LOOKUP_CHUNK) {
    const batch = matchIds.slice(index, index + MATCH_LOOKUP_CHUNK);
    const { data, error } = await supabase
      .from("match_master_telemetry")
      .select("match_id")
      .in("match_id", batch);

    if (error) {
      throw new Error(`match_master_telemetry 조회 실패: ${error.message}`);
    }

    for (const row of (data ?? []) as Array<{ match_id: string | null }>) {
      if (row.match_id) referenced.add(row.match_id.toLowerCase());
    }
  }

  return referenced;
}

export async function runReplayOrphanCleanup(options: {
  apply?: boolean;
  env?: Record<string, string | undefined>;
  write?: (message: string) => void;
} = {}): Promise<ReplayCleanupResult> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((message: string) => console.info(message));
  const apply = options.apply === true;

  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const endpoint = env.CLOUDFLARE_R2_ENDPOINT?.trim();
  const accessKeyId = env.CLOUDFLARE_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.CLOUDFLARE_R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.CLOUDFLARE_R2_BUCKET_NAME?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("r2-replay-cleanup-supabase-credentials-missing");
  }
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("r2-replay-cleanup-r2-credentials-missing");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const s3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  const now = new Date();
  const { scanned, objects } = await listReplayObjects(s3, bucket, now);
  const registryPaths = await fetchRegistryPaths(supabase);

  const unregistered = objects.filter((object) => !registryPaths.has(object.key));
  const uniqueMatchIds = [...new Set(unregistered.map((object) => object.matchId))];
  const referenced = await fetchReferencedMatchIds(supabase, uniqueMatchIds);

  const candidates = selectReplayOrphanCandidates(objects, registryPaths, referenced);
  const { deletable, blocked } = partitionDeletionKeys(candidates.map((entry) => entry.key));
  const candidateBytes = candidates.reduce((sum, entry) => sum + entry.sizeBytes, 0);

  write(`리플레이 캐시 객체: ${scanned.toLocaleString()}개 (파싱 성공 ${objects.length.toLocaleString()}개)`);
  write(`등록부 기록: ${registryPaths.size.toLocaleString()}건`);
  write(`미등록 객체: ${unregistered.length.toLocaleString()}개 (고유 매치 ${uniqueMatchIds.length.toLocaleString()}개)`);
  write(`  그중 DB 에 매치 존재: ${referenced.size.toLocaleString()}개 (삭제 제외)`);
  write(`삭제 대상: ${deletable.length.toLocaleString()}개 / ${formatBytes(candidateBytes)} (${REPLAY_ORPHAN_MIN_AGE_DAYS}일 이상 경과)`);
  if (blocked.length > 0) {
    write(`가드 차단: ${blocked.length.toLocaleString()}개`);
  }

  const deletion = await deleteObjectsFromR2(deletable, { dryRun: !apply });

  if (deletion.dryRun) {
    write("dry-run 이므로 삭제하지 않았습니다. 실제 삭제는 --apply 를 사용하세요.");
  } else {
    write(`삭제 완료: ${deletion.deletedCount.toLocaleString()}개`);
    if (deletion.failed.length > 0) {
      write(`삭제 실패: ${deletion.failed.length.toLocaleString()}개`);
      deletion.failed.slice(0, 5).forEach((entry) => write(`  ${entry.key}: ${entry.message}`));
    }
  }

  return {
    scannedObjects: scanned,
    registryPaths: registryPaths.size,
    unregisteredObjects: unregistered.length,
    uniqueMatchIds: uniqueMatchIds.length,
    referencedMatchIds: referenced.size,
    candidates: deletable.length,
    candidateBytes,
    blockedByGuard: blocked.length,
    deletedCount: deletion.deletedCount,
    failedCount: deletion.failed.length,
    dryRun: deletion.dryRun,
  };
}

const isDirectRun = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  const apply = process.argv.includes("--apply");
  runReplayOrphanCleanup({ apply })
    .catch((error: unknown) => {
      const detail = error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : String(error);
      console.error(`R2 고아 리플레이 캐시 정리 실패: ${detail}`);
      process.exitCode = 1;
    });
}
