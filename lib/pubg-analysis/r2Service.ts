import { createHash } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { gzipSync, gunzipSync } from 'node:zlib';
import { partitionDeletionKeys, type DeletionGuardReason } from './r2DeletionGuard';
import { buildSharedTelemetrySourceKey, parseSharedTelemetrySource } from './sharedTelemetrySourceContract';
import { getMatchDetailRetention } from './matchRetention';
import { buildTelemetryAnalyzeCacheKey, buildTelemetryCacheKey } from './telemetryCacheKey';

let r2ClientInstance: S3Client | null = null;

export type R2BucketUsage = {
  bucketName: string;
  fileCount: number;
  totalSizeBytes: number;
  scannedPages: number;
  truncated: boolean;
  configured: boolean;
};

export type R2DeletionResult = {
  /** 실제로 삭제된 키 수. dryRun 인 경우 항상 0 입니다. */
  deletedCount: number;
  /** 삭제 대상으로 판정된 키 수. */
  plannedCount: number;
  /** 보호 규칙에 걸려 제외된 키와 이유. */
  blocked: Array<{ key: string; reason: DeletionGuardReason }>;
  /** 삭제에 실패한 키와 이유. */
  failed: Array<{ key: string; message: string }>;
  /** 실제 삭제를 수행하지 않은 경우 true. */
  dryRun: boolean;
};

/**
 * Immutable read-back facts used by the benchmark recovery canary.  The
 * helper deliberately performs a HEAD and a GET for the exact key so callers
 * can bind the registry row to both object metadata and bytes without any
 * storage mutation.
 */
export type R2ObjectVerificationRead = {
  key: string;
  etag: string;
  sizeBytes: number;
  contentType: string | null;
  contentEncoding: string | null;
  body: Buffer;
};

export type R2RecoveryUploadResult = {
  key: string;
  etag: string;
  bodySha256: string;
};

export type R2ListedObject = { key: string; sizeBytes: number; etag: string };

// S3 DeleteObjects API 의 1회 요청 상한.
const DELETE_REQUEST_CHUNK = 1000;

/**
 * gzip 매직 넘버. 압축 여부를 내용으로 판별해 기존 비압축 객체와 호환합니다.
 * 압축 도입 이전에 저장된 객체가 다수 남아 있으므로 판별은 필수입니다.
 */
const GZIP_MAGIC_BYTES = [0x1f, 0x8b] as const;

// 압축 수준. 6은 크기와 CPU 사용의 균형점입니다.
const GZIP_LEVEL = 6;

function isGzipBuffer(buffer: Buffer): boolean {
  return buffer.length >= 2
    && buffer[0] === GZIP_MAGIC_BYTES[0]
    && buffer[1] === GZIP_MAGIC_BYTES[1];
}

/**
 * 텍스트를 gzip 으로 압축합니다.
 * 실측 기준 텔레메트리 JSON 에서 약 94% 절감됩니다.
 */
export function compressJsonText(text: string): Buffer {
  return gzipSync(Buffer.from(text, 'utf8'), { level: GZIP_LEVEL });
}

/**
 * 버퍼를 텍스트로 변환합니다.
 * gzip 매직 넘버가 있으면 압축을 해제하고, 없으면 그대로 해석합니다.
 */
export function decodeMaybeGzip(buffer: Buffer): string {
  if (isGzipBuffer(buffer)) {
    return gunzipSync(buffer).toString('utf8');
  }
  return buffer.toString('utf8');
}

const cleanEnv = (val: string | undefined) => (val || '').replace(/['";\s]+/g, '').trim();

function getR2Client(): S3Client {
  if (!r2ClientInstance) {
    const endpoint = cleanEnv(process.env.CLOUDFLARE_R2_ENDPOINT);
    const accessKeyId = cleanEnv(process.env.CLOUDFLARE_R2_ACCESS_KEY_ID);
    const secretAccessKey = cleanEnv(process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY);

    r2ClientInstance = new S3Client({
      region: 'auto',
      endpoint: endpoint || undefined,
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 3_000,
        socketTimeout: 10_000,
      }),
      credentials: {
        accessKeyId: accessKeyId || '',
        secretAccessKey: secretAccessKey || '',
      },
      forcePathStyle: true,
    });
  }
  return r2ClientInstance;
}

function getBucketName(): string {
  return cleanEnv(process.env.CLOUDFLARE_R2_BUCKET_NAME) || 'telemetry';
}

export function isR2Configured(): boolean {
  return Boolean(
    cleanEnv(process.env.CLOUDFLARE_R2_ENDPOINT)
      && cleanEnv(process.env.CLOUDFLARE_R2_ACCESS_KEY_ID)
      && cleanEnv(process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY),
  );
}

/**
 * R2 객체를 삭제합니다.
 *
 * 이미지 자산 삭제를 구조적으로 막기 위해 모든 키가 r2DeletionGuard 를 통과해야
 * 합니다. 가드에 걸린 키는 요청에 포함되지 않으며 blocked 로 보고됩니다.
 *
 * dryRun 이 true 이면 삭제 요청을 보내지 않고 대상만 계산합니다.
 * 운영 정리 작업은 반드시 dryRun 으로 대상을 확인한 뒤 실행해야 합니다.
 */
export async function deleteObjectsFromR2(
  keys: readonly string[],
  options: { dryRun?: boolean } = {},
): Promise<R2DeletionResult> {
  const dryRun = options.dryRun !== false;
  const { deletable, blocked } = partitionDeletionKeys(keys);

  const result: R2DeletionResult = {
    deletedCount: 0,
    plannedCount: deletable.length,
    blocked,
    failed: [],
    dryRun,
  };

  if (dryRun || deletable.length === 0) {
    return result;
  }

  if (!isR2Configured()) {
    console.warn('[R2 Warning] Cloudflare R2 Credentials are not configured. Skipping deletion.');
    return result;
  }

  const bucketName = getBucketName();

  for (let index = 0; index < deletable.length; index += DELETE_REQUEST_CHUNK) {
    const chunk = deletable.slice(index, index + DELETE_REQUEST_CHUNK);
    const response = await getR2Client().send(new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: {
        Objects: chunk.map((key) => ({ Key: key })),
        Quiet: true,
      },
    }));

    for (const error of response.Errors ?? []) {
      result.failed.push({
        key: error.Key || '(unknown)',
        message: error.Message || error.Code || 'unknown error',
      });
    }

    result.deletedCount += chunk.length - (response.Errors?.length ?? 0);
  }

  return result;
}

/**
 * Uploads a text/binary buffer file to Cloudflare R2 Bucket
 * @param key The destination path or filename in the bucket
 * @param body The stringified JSON or file content buffer
 * @param contentType The MIME content type of the file
 */
export async function uploadToR2(
  key: string,
  body: string | Buffer,
  contentType: string = 'application/json',
  options: { compress?: boolean } = {},
): Promise<void> {
  if (!cleanEnv(process.env.CLOUDFLARE_R2_ENDPOINT)) {
    console.warn('[R2 Warning] Cloudflare R2 Credentials are not configured. Skipping upload.');
    return;
  }

  // 문자열 JSON 은 기본으로 압축한다. 실측 기준 약 94% 절감된다.
  // 이미지 등 바이너리는 이미 압축되어 있어 대상이 아니다.
  const shouldCompress = options.compress ?? (typeof body === 'string' && contentType === 'application/json');
  const payload = shouldCompress ? compressJsonText(body as string) : body;

  const command = new PutObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    Body: payload,
    ContentType: contentType,
    // Presigned URL 로 브라우저가 직접 받을 때 자동 해제되도록 인코딩을 명시한다.
    ...(shouldCompress ? { ContentEncoding: 'gzip' } : {}),
  });

  try {
    await getR2Client().send(command);
  } catch (error) {
    console.error(`[R2 Error] Failed to upload file to R2: ${key}`, error);
    throw error;
  }
}

/**
 * Strict recovery upload. `IfNoneMatch: "*"` makes the deterministic target
 * an atomic create: an existing object is reported as a conflict and can
 * never be overwritten by this worker. The returned ETag and body hash are
 * retained as immutable evidence for postcondition verification; callers must
 * not delete on an ambiguous transport failure.
 */
export async function uploadRecoveryObjectToR2(
  key: string,
  body: string | Buffer,
  contentType: string = "application/json",
): Promise<R2RecoveryUploadResult> {
  if (!isR2Configured()) throw new Error("r2-credentials-missing");
  const payload = typeof body === "string" && contentType === "application/json"
    ? compressJsonText(body)
    : body;
  const response = await getR2Client().send(new PutObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    Body: payload,
    ContentType: contentType,
    IfNoneMatch: "*",
    ...(typeof body === "string" && contentType === "application/json" ? { ContentEncoding: "gzip" } : {}),
  }));
  const etag = typeof response?.ETag === "string" ? response.ETag.trim() : "";
  if (!etag) throw new Error("r2-recovery-upload-etag-missing");
  return {
    key,
    etag,
    bodySha256: createHash("sha256").update(payload).digest("hex"),
  };
}

/**
 * Generates a Secure Presigned URL for Direct Client Download with expiration time
 * @param key The filename/key of the file stored in the R2 bucket
 * @param expiresInSeconds Duration in seconds for the link to remain active (default: 3600s / 1 Hour)
 */
export async function getPresignedUrlFromR2(key: string, expiresInSeconds: number = 3600): Promise<string> {
  if (!cleanEnv(process.env.CLOUDFLARE_R2_ENDPOINT)) {
    console.warn('[R2 Warning] Cloudflare R2 Credentials are not configured. Returning local mock URL.');
    return `/mock-telemetry/${key}`;
  }

  const command = new GetObjectCommand({
    Bucket: getBucketName(),
    Key: key,
  });

  try {
    const url = await getSignedUrl(getR2Client(), command, { expiresIn: expiresInSeconds });
    return url;
  } catch (error) {
    console.error(`[R2 Error] Failed to generate Presigned URL for key: ${key}`, error);
    throw error;
  }
}

/**
 * Downloads a text/JSON file directly from Cloudflare R2 bucket
 * @param key The filename/key of the file to retrieve
 */
export async function downloadFromR2(key: string): Promise<string | null> {
  if (!cleanEnv(process.env.CLOUDFLARE_R2_ENDPOINT)) {
    console.warn('[R2 Warning] Cloudflare R2 Credentials are not configured. Returning null.');
    return null;
  }

  const command = new GetObjectCommand({
    Bucket: getBucketName(),
    Key: key,
  });

  try {
    const response = await getR2Client().send(command);
    if (!response.Body) return null;
    // 압축 도입 이전 객체와 혼재하므로 내용으로 판별해 해제한다.
    const bytes = await response.Body.transformToByteArray();
    return decodeMaybeGzip(Buffer.from(bytes));
  } catch (error: any) {
    // If object does not exist, return null gracefully instead of crashing
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return null;
    }
    console.error(`[R2 Error] Failed to download file from R2: ${key}`, error);
    throw error;
  }
}

/**
 * Calculates R2 bucket usage with pagination without holding every object in memory.
 */
export async function getR2BucketUsage(options: { maxObjects?: number; pageSize?: number } = {}): Promise<R2BucketUsage> {
  const bucketName = getBucketName();
  if (!cleanEnv(process.env.CLOUDFLARE_R2_ENDPOINT)) {
    console.warn('[R2 Warning] Cloudflare R2 Credentials are not configured. Returning zero usage.');
    return {
      bucketName,
      fileCount: 0,
      totalSizeBytes: 0,
      scannedPages: 0,
      truncated: false,
      configured: false
    };
  }

  const maxObjects = Math.max(1, options.maxObjects || 100000);
  const pageSize = Math.min(Math.max(options.pageSize || 1000, 1), 1000);
  let continuationToken: string | undefined;
  let fileCount = 0;
  let totalSizeBytes = 0;
  let scannedPages = 0;
  let truncated = false;

  try {
    do {
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        MaxKeys: Math.min(pageSize, maxObjects - fileCount),
        ContinuationToken: continuationToken,
      });
      const response = await getR2Client().send(command);
      scannedPages += 1;
      response.Contents?.forEach(item => {
        if (fileCount >= maxObjects) return;
        fileCount += 1;
        totalSizeBytes += item.Size || 0;
      });
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      if (fileCount >= maxObjects && continuationToken) {
        truncated = true;
        break;
      }
    } while (continuationToken);

    return {
      bucketName,
      fileCount,
      totalSizeBytes,
      scannedPages,
      truncated,
      configured: true
    };
  } catch (error) {
    console.error('[R2 Error] Failed to calculate R2 bucket usage', error);
    throw error;
  }
}

/**
 * R2 에서 바이너리 파일을 Buffer 로 내려받습니다.
 *
 * 주의: 이 함수는 gzip 해제를 수행하지 않습니다. 이미지 등 이미 압축된
 * 바이너리 전용입니다. JSON 텍스트는 uploadToR2 가 gzip 으로 저장하므로
 * 반드시 downloadFromR2 를 사용해야 합니다.
 *
 * @param key 내려받을 객체 키
 */
export async function downloadBufferFromR2(key: string): Promise<Buffer | null> {
  if (!cleanEnv(process.env.CLOUDFLARE_R2_ENDPOINT)) {
    console.warn('[R2 Warning] Cloudflare R2 Credentials are not configured. Returning null.');
    return null;
  }

  const command = new GetObjectCommand({
    Bucket: getBucketName(),
    Key: key,
  });

  try {
    const response = await getR2Client().send(command);
    if (!response.Body) return null;
    const byteArray = await response.Body.transformToByteArray();
    return Buffer.from(byteArray);
  } catch (error: any) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return null;
    }
    console.error(`[R2 Error] Failed to download buffer from R2: ${key}`, error);
    throw error;
  }
}

/**
 * Reads one exact R2 key for a postcondition proof.
 *
 * A missing key is represented as null. Other HEAD/GET errors are propagated
 * so a canary cannot turn an unavailable or ambiguous storage read into a
 * successful verification. The HEAD ETag must be present and, when returned
 * by GET, must match the same immutable object.
 */
export async function readObjectForVerification(
  key: string,
  options: { maxBytes?: number } = {},
): Promise<R2ObjectVerificationRead | null> {
  if (!isR2Configured()) {
    throw new Error("r2-credentials-missing");
  }

  const bucket = getBucketName();
  let head: { ETag?: string; ContentLength?: number; ContentType?: string; ContentEncoding?: string };
  try {
    head = await getR2Client().send(new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    })) as typeof head;
  } catch (error: any) {
    if (error?.name === "NotFound"
      || error?.name === "NoSuchKey"
      || error?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    console.error("[R2 verification] HEAD failed", { statusCode: error?.$metadata?.httpStatusCode });
    throw error;
  }

  const etag = typeof head.ETag === "string" ? head.ETag.trim() : "";
  if (!etag) throw new Error("r2-verification-etag-missing");
  const sizeBytes = head.ContentLength;
  if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0) {
    throw new Error("r2-verification-size-missing");
  }
  if (options.maxBytes !== undefined && (sizeBytes as number) > options.maxBytes) {
    throw new Error("r2-verification-size-limit");
  }

  let response: { ETag?: string; ContentLength?: number; ContentType?: string; ContentEncoding?: string; Body?: { transformToByteArray(): Promise<Uint8Array> } };
  try {
    response = await getR2Client().send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })) as typeof response;
  } catch (error: any) {
    if (error?.name === "NotFound"
      || error?.name === "NoSuchKey"
      || error?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    console.error("[R2 verification] GET failed", { statusCode: error?.$metadata?.httpStatusCode });
    throw error;
  }
  if (!response.Body) throw new Error("r2-verification-body-missing");
  const getEtag = typeof response.ETag === "string" ? response.ETag.trim() : "";
  if (getEtag && getEtag !== etag) throw new Error("r2-verification-etag-changed");
  const bytes = await response.Body.transformToByteArray();
  const body = Buffer.from(bytes);
  if (body.length !== sizeBytes || (response.ContentLength !== undefined && response.ContentLength !== sizeBytes)) {
    throw new Error("r2-verification-size-changed");
  }
  return {
    key,
    etag,
    sizeBytes: sizeBytes as number,
    contentType: response.ContentType ?? head.ContentType ?? null,
    contentEncoding: response.ContentEncoding ?? head.ContentEncoding ?? null,
    body,
  };
}

/**
 * The ordinary deletion guard protects every telemetry-source object. This
 * narrow path permits only the canonical shared source for an expired match,
 * after checking the database-derived account snapshot gate and the source's
 * own match identity/date again. R2 has no verified conditional-delete contract
 * here, so a concurrent replacement between the final GET and DELETE remains
 * a small, explicit race window.
 */
export async function deleteExpiredMatchSourceFromR2(input: {
  matchId: string;
  platform: "steam" | "kakao";
  playedAt: string;
  referencedAccountIds: string[];
  preservedAccountIds: string[];
  noActiveWork: boolean;
  expectedEtag: string;
  expectedSizeBytes: number;
  expectedSha256: string;
  now?: number;
}): Promise<{ deleted: boolean; key: string }> {
  const key = buildSharedTelemetrySourceKey(input.matchId, input.platform);
  const retention = getMatchDetailRetention(input.playedAt, input.now);
  const refs = [...new Set(input.referencedAccountIds)];
  const preserved = new Set(input.preservedAccountIds);
  if (retention.status !== "expired" || !input.noActiveWork || refs.length === 0
    || refs.some((id) => !/^account\.[A-Za-z0-9_-]+$/.test(id) || !preserved.has(id))
    || !/^\"?[^\"]+\"?$/.test(input.expectedEtag)
    || !Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes <= 0
    || !/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
    throw new Error("r2-match-retention-source-proof-invalid");
  }

  const object = await readObjectForVerification(key);
  if (!object) throw new Error("r2-match-retention-source-missing");
  const hash = createHash("sha256").update(object.body).digest("hex");
  if (object.etag !== input.expectedEtag || object.sizeBytes !== input.expectedSizeBytes
    || hash !== input.expectedSha256) {
    throw new Error("r2-match-retention-source-changed");
  }
  let source;
  try {
    source = parseSharedTelemetrySource(JSON.parse(decodeMaybeGzip(object.body)), input.matchId, input.platform);
  } catch {
    source = null;
  }
  const sourceDate = source?.matchData?.data?.attributes?.createdAt;
  const participants = source?.matchData?.included?.filter((participant: any) => participant?.type === "participant") ?? [];
  const participantIds = new Set<string>(participants.map((participant: any) =>
    participant?.attributes?.stats?.playerId || participant?.attributes?.accountId).filter((id: unknown): id is string => typeof id === "string"));
  if (!source || typeof sourceDate !== "string" || Date.parse(sourceDate) !== Date.parse(input.playedAt)
    || refs.some((id) => !participantIds.has(id))) {
    throw new Error("r2-match-retention-source-identity-invalid");
  }

  // S3 DeleteObjects has no If-Match condition in the Cloudflare R2 path used
  // here. Keep this single-key request immediately adjacent to the verified GET.
  const response = await getR2Client().send(new DeleteObjectsCommand({
    Bucket: getBucketName(),
    Delete: { Objects: [{ Key: key }], Quiet: true },
  }));
  if (response.Errors?.length) throw new Error("r2-match-retention-source-delete-failed");
  const after = await readObjectForVerification(key);
  if (after) throw new Error("r2-match-retention-source-delete-unverified");
  return { deleted: true, key };
}

/** Lists only a bounded root prefix; callers must still match complete keys to DB identities. */
export async function listR2ObjectsByPrefix(
  prefix: string,
  options: { maxPages: number; maxObjects: number },
): Promise<{ objects: R2ListedObject[]; pages: number; truncated: boolean }> {
  if (!isR2Configured()) throw new Error("r2-credentials-missing");
  if (!/^[A-Za-z0-9._-]{1,160}_$/.test(prefix) || prefix.includes("..")
    || !Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 20
    || !Number.isInteger(options.maxObjects) || options.maxObjects < 1 || options.maxObjects > 100) {
    throw new Error("r2-prefix-list-bound-invalid");
  }
  const objects: R2ListedObject[] = [];
  let token: string | undefined;
  let pages = 0;
  let truncated = false;
  do {
    const response = await getR2Client().send(new ListObjectsV2Command({
      Bucket: getBucketName(),
      Prefix: prefix,
      MaxKeys: Math.min(1000, Math.max(1, options.maxObjects - objects.length)),
      ContinuationToken: token,
    }));
    pages += 1;
    for (const item of response.Contents ?? []) {
      if (objects.length >= options.maxObjects) { truncated = true; break; }
      if (typeof item.Key !== "string" || !Number.isSafeInteger(item.Size) || typeof item.ETag !== "string") continue;
      objects.push({ key: item.Key, sizeBytes: item.Size as number, etag: item.ETag });
    }
    token = response.IsTruncated ? response.NextContinuationToken : undefined;
    if (token && (pages >= options.maxPages || objects.length >= options.maxObjects)) truncated = true;
  } while (token && !truncated);
  return { objects, pages, truncated };
}

/** One-object 14-day cache deletion with a fresh exact-key HEAD/GET immediately before DELETE. */
export async function deleteExpiredPersonalMatchObjectFromR2(input: {
  kind: "personal-map" | "personal-analysis" | "legacy-analysis";
  key: string;
  matchId: string;
  platform: "steam" | "kakao";
  accountId: string;
  playerId: string;
  mode?: "lite" | "full";
  telemetryVersion: number;
  playedAt: string;
  now?: number;
  compactSnapshotPreserved: boolean;
  noActiveWork: boolean;
  expectedEtag: string;
  expectedSizeBytes: number;
  expectedSha256: string;
}): Promise<{ deleted: boolean }> {
  const retention = getMatchDetailRetention(input.playedAt, input.now);
  const accountIdValid = /^account\.[A-Za-z0-9_-]+$/.test(input.accountId);
  let expectedKey = "";
  try {
    if (input.kind === "legacy-analysis") {
      const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expectedKey = new RegExp(`^${escape(input.matchId)}_${escape(input.playerId.trim().toLowerCase())}_v${input.telemetryVersion}_analyze\\.json$`)
        .test(input.key) ? input.key : "";
    } else {
      if (!input.mode) throw new Error("identity");
      const identity = { matchId: input.matchId, platform: input.platform, playerId: input.accountId,
        mode: input.mode, telemetryVersion: input.telemetryVersion };
      expectedKey = input.kind === "personal-map"
        ? buildTelemetryCacheKey(identity) : buildTelemetryAnalyzeCacheKey(identity);
    }
  } catch { expectedKey = ""; }
  if (retention.status !== "expired" || !accountIdValid || !input.compactSnapshotPreserved
    || !input.noActiveWork || !expectedKey || expectedKey !== input.key
    || !input.expectedEtag.trim() || !Number.isSafeInteger(input.expectedSizeBytes)
    || input.expectedSizeBytes <= 0 || input.expectedSizeBytes > 32 * 1024 * 1024
    || !/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
    throw new Error("r2-match-retention-personal-proof-invalid");
  }
  const latest = await readObjectForVerification(input.key, { maxBytes: 32 * 1024 * 1024 });
  if (!latest || latest.etag !== input.expectedEtag || latest.sizeBytes !== input.expectedSizeBytes
    || createHash("sha256").update(latest.body).digest("hex") !== input.expectedSha256) {
    throw new Error("r2-match-retention-personal-object-changed");
  }

  // R2's current compatibility table does not document conditional DELETE.
  // The cleanup caller therefore relies on expired-writer blocking, freshly
  // rechecked leases/DB state, and this immediately preceding exact GET. A
  // concurrent writer in the request gap remains a narrow race.
  const result = await deleteObjectsFromR2([input.key], { dryRun: false });
  if (result.deletedCount !== 1 || result.failed.length || result.blocked.length) {
    throw new Error("r2-match-retention-personal-delete-failed");
  }
  if (await readObjectForVerification(input.key, { maxBytes: 32 * 1024 * 1024 })) {
    throw new Error("r2-match-retention-personal-delete-unverified");
  }
  return { deleted: true };
}

/** Restore an exact encrypted-artifact object without overwriting a concurrent replacement. */
export async function restoreR2ObjectFromRetentionBackup(input: {
  key: string;
  body: Buffer;
  sha256: string;
  contentType: string | null;
  contentEncoding: string | null;
}): Promise<void> {
  if (createHash("sha256").update(input.body).digest("hex") !== input.sha256) {
    throw new Error("r2-match-retention-restore-backup-invalid");
  }
  if (!isR2Configured()) throw new Error("r2-credentials-missing");
  try {
    await getR2Client().send(new PutObjectCommand({
      Bucket: getBucketName(),
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType ?? "application/octet-stream",
      ...(input.contentEncoding ? { ContentEncoding: input.contentEncoding } : {}),
      IfNoneMatch: "*",
    }));
  } catch (error: any) {
    if (error?.name !== "PreconditionFailed" && error?.$metadata?.httpStatusCode !== 412) throw error;
  }
  const restored = await readObjectForVerification(input.key, { maxBytes: 32 * 1024 * 1024 });
  if (!restored || createHash("sha256").update(restored.body).digest("hex") !== input.sha256) {
    throw new Error("r2-match-retention-restore-readback-failed");
  }
}

/**
 * HeadObject API를 사용하여 Cloudflare R2 버킷에 파일이 존재하는지 가볍게 검증합니다.
 * @param key 버킷 내 파일 경로/이름
 */
export async function checkObjectExists(key: string): Promise<boolean> {
  if (!cleanEnv(process.env.CLOUDFLARE_R2_ENDPOINT)) {
    console.warn('[R2 Warning] Cloudflare R2 Credentials are not configured. Returning false.');
    return false;
  }

  const command = new HeadObjectCommand({
    Bucket: getBucketName(),
    Key: key,
  });

  try {
    await getR2Client().send(command);
    return true;
  } catch (error: any) {
    // 오브젝트가 없는 경우는 에러 이름 혹은 status 코드로 감지하여 안전하게 false 반환
    if (
      error.name === 'NotFound' ||
      error.name === 'NoSuchKey' ||
      error.$metadata?.httpStatusCode === 404
    ) {
      return false;
    }
    console.error(`[R2 Error] Failed to check object existence for key: ${key}`, error);
    return false;
  }
}
