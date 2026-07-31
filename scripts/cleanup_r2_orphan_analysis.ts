/**
 * @fileoverview DB 에 매치가 없는 R2 분석 캐시(고아 객체)를 정리합니다.
 *
 * 루트의 `{matchId}_{nickname}_v{version}_analyze.json` 은 전적 조회 시 생성되는
 * 분석 결과 캐시입니다. 등록부에 기록되지 않아 기존 정리 대상에서 누락되어
 * 2026-07-24 이후 한 번도 삭제되지 않았습니다.
 *
 * 이 스크립트는 DB `match_master_telemetry` 에 존재하지 않는 매치의 캐시만
 * 삭제합니다. 참조하는 매치가 없으므로 기능 영향이 없습니다.
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

/** 분석 캐시 키 형태. 루트에 있고 매치 ID 로 시작합니다. */
const ANALYSIS_KEY_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_.+_analyze\.json$/i;

// 최근 생성된 캐시는 조회 직후일 수 있어 보호합니다.
// DB 반영과 캐시 생성 사이의 시차로 인한 오삭제를 막습니다.
export const ORPHAN_MIN_AGE_DAYS = 3;

// DB 조회 시 IN 절 크기. 과도한 쿼리 길이를 피합니다.
const MATCH_LOOKUP_CHUNK = 300;

export type OrphanCandidate = {
  key: string;
  matchId: string;
  sizeBytes: number;
  ageDays: number;
};

export type OrphanCleanupResult = {
  scannedObjects: number;
  analysisObjects: number;
  uniqueMatchIds: number;
  referencedMatchIds: number;
  orphanMatchIds: number;
  candidates: number;
  candidateBytes: number;
  blockedByGuard: number;
  deletedCount: number;
  failedCount: number;
  dryRun: boolean;
};

type ListClient = Pick<S3Client, "send">;
type MatchLookupClient = Pick<SupabaseClient, "from">;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** 분석 캐시 키에서 매치 ID 를 추출합니다. 형태가 다르면 null 을 반환합니다. */
export function extractMatchIdFromAnalysisKey(key: string): string | null {
  if (key.includes("/")) return null;
  const matched = key.match(ANALYSIS_KEY_PATTERN);
  return matched ? matched[1].toLowerCase() : null;
}

/** 나이 기준을 만족하는 고아 후보만 남깁니다. */
export function selectOrphanCandidates(
  objects: readonly OrphanCandidate[],
  referencedMatchIds: ReadonlySet<string>,
  minAgeDays = ORPHAN_MIN_AGE_DAYS,
): OrphanCandidate[] {
  return objects.filter((object) => (
    !referencedMatchIds.has(object.matchId) && object.ageDays >= minAgeDays
  ));
}

/** 버킷 전체를 순회해 분석 캐시 객체를 수집합니다. */
async function listAnalysisObjects(
  client: ListClient,
  bucket: string,
  now: Date,
): Promise<{ scanned: number; objects: OrphanCandidate[] }> {
  const objects: OrphanCandidate[] = [];
  let continuationToken: string | undefined;
  let scanned = 0;

  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    })) as { Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }>; IsTruncated?: boolean; NextContinuationToken?: string };

    for (const item of response.Contents ?? []) {
      scanned += 1;
      const key = item.Key ?? "";
      const matchId = extractMatchIdFromAnalysisKey(key);
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

/** DB 에 존재하는 매치 ID 집합을 조회합니다. */
async function fetchReferencedMatchIds(
  supabase: MatchLookupClient,
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

export async function runOrphanAnalysisCleanup(options: {
  apply?: boolean;
  env?: Record<string, string | undefined>;
  write?: (message: string) => void;
} = {}): Promise<OrphanCleanupResult> {
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
    throw new Error("r2-orphan-cleanup-supabase-credentials-missing");
  }
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("r2-orphan-cleanup-r2-credentials-missing");
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
  const { scanned, objects } = await listAnalysisObjects(s3, bucket, now);
  const uniqueMatchIds = [...new Set(objects.map((object) => object.matchId))];
  const referenced = await fetchReferencedMatchIds(supabase, uniqueMatchIds);
  const candidates = selectOrphanCandidates(objects, referenced);

  const { deletable, blocked } = partitionDeletionKeys(candidates.map((entry) => entry.key));
  const candidateBytes = candidates.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const orphanMatchIds = new Set(candidates.map((entry) => entry.matchId)).size;

  write(`스캔 객체: ${scanned.toLocaleString()}개`);
  write(`분석 캐시: ${objects.length.toLocaleString()}개 (고유 매치 ${uniqueMatchIds.length.toLocaleString()}개)`);
  write(`DB 참조 매치: ${referenced.size.toLocaleString()}개`);
  write(`삭제 대상: ${deletable.length.toLocaleString()}개 / ${formatBytes(candidateBytes)} (매치 ${orphanMatchIds.toLocaleString()}개, ${ORPHAN_MIN_AGE_DAYS}일 이상 경과)`);
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
    analysisObjects: objects.length,
    uniqueMatchIds: uniqueMatchIds.length,
    referencedMatchIds: referenced.size,
    orphanMatchIds,
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
  runOrphanAnalysisCleanup({ apply })
    .catch((error: unknown) => {
      const detail = error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : String(error);
      console.error(`R2 고아 분석 캐시 정리 실패: ${detail}`);
      process.exitCode = 1;
    });
}
