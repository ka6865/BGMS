import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { partitionDeletionKeys, type DeletionGuardReason } from './r2DeletionGuard';

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

// S3 DeleteObjects API 의 1회 요청 상한.
const DELETE_REQUEST_CHUNK = 1000;

const cleanEnv = (val: string | undefined) => (val || '').replace(/['";\s]+/g, '').trim();

function getR2Client(): S3Client {
  if (!r2ClientInstance) {
    const endpoint = cleanEnv(process.env.CLOUDFLARE_R2_ENDPOINT);
    const accessKeyId = cleanEnv(process.env.CLOUDFLARE_R2_ACCESS_KEY_ID);
    const secretAccessKey = cleanEnv(process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY);

    r2ClientInstance = new S3Client({
      region: 'auto',
      endpoint: endpoint || undefined,
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
export async function uploadToR2(key: string, body: string | Buffer, contentType: string = 'application/json'): Promise<void> {
  if (!cleanEnv(process.env.CLOUDFLARE_R2_ENDPOINT)) {
    console.warn('[R2 Warning] Cloudflare R2 Credentials are not configured. Skipping upload.');
    return;
  }

  const command = new PutObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    Body: body,
    ContentType: contentType,
  });

  try {
    await getR2Client().send(command);
  } catch (error) {
    console.error(`[R2 Error] Failed to upload file to R2: ${key}`, error);
    throw error;
  }
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
    return await response.Body.transformToString();
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
 * Downloads a binary file as a Buffer from Cloudflare R2 bucket
 * @param key The filename/key of the file to retrieve
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
