/**
 * @fileoverview 이미 저장된 R2 JSON 캐시를 gzip 으로 재압축합니다.
 *
 * 압축 도입 이전에 저장된 텔레메트리 캐시가 비압축 상태로 남아 있습니다.
 * 실측 기준 gzip 으로 약 94% 절감되므로, 무료 한도를 넘긴 상황에서
 * 기존 객체를 재압축하면 즉시 사용량을 줄일 수 있습니다.
 *
 * 안전 장치:
 *   - 이미지 자산은 r2DeletionGuard 의 보호 규칙과 동일한 기준으로 제외합니다.
 *   - JSON 이 아닌 객체, 이미 gzip 인 객체는 건너뜁니다.
 *   - 내려받은 내용을 JSON 으로 파싱해 유효성을 확인한 뒤에만 재업로드합니다.
 *   - 재업로드 후 다시 내려받아 원본과 일치하는지 검증합니다.
 *   - 검증에 실패하면 원본을 그대로 복원하고 해당 객체를 실패로 기록합니다.
 *
 * 기본은 dry-run 입니다. 실제 재압축은 `--apply` 를 명시해야 수행됩니다.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { compressJsonText, decodeMaybeGzip } from "../lib/pubg-analysis/r2Service";
import { inspectDeletionKey } from "../lib/pubg-analysis/r2DeletionGuard";

// 한 번 실행에서 처리할 최대 객체 수. 중단·재실행이 가능하도록 제한합니다.
export const RECOMPRESS_BATCH_LIMIT = 500;

// 동시 처리 수. 객체 하나당 다운로드·업로드·검증 왕복이 3회 발생하므로
// 순차 처리 시 대량 객체에 과도한 시간이 걸립니다.
export const RECOMPRESS_CONCURRENCY = 12;

export type RecompressCandidate = {
  key: string;
  sizeBytes: number;
};

export type RecompressResult = {
  scannedObjects: number;
  jsonObjects: number;
  alreadyCompressed: number;
  skippedByGuard: number;
  candidates: number;
  candidateBytes: number;
  processed: number;
  savedBytes: number;
  failed: Array<{ key: string; message: string }>;
  remaining: number;
  dryRun: boolean;
};

type S3Like = Pick<S3Client, "send">;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * 재압축 대상 여부를 판정합니다.
 * 이미지 보호 규칙을 그대로 적용하고, JSON 확장자만 허용합니다.
 */
export function isRecompressTarget(key: string): boolean {
  // 이미지 및 보호 경로는 삭제 가드와 동일 기준으로 제외한다.
  if (!inspectDeletionKey(key).allowed) return false;
  return key.toLowerCase().endsWith(".json");
}

async function readObject(
  client: S3Like,
  bucket: string,
  key: string,
): Promise<{ bytes: Buffer; contentEncoding?: string }> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key })) as {
    Body?: AsyncIterable<Uint8Array>;
    ContentEncoding?: string;
  };
  if (!response.Body) throw new Error("본문이 비어 있습니다.");

  const chunks: Buffer[] = [];
  for await (const chunk of response.Body) chunks.push(Buffer.from(chunk));
  return { bytes: Buffer.concat(chunks), contentEncoding: response.ContentEncoding };
}

export async function runR2Recompression(options: {
  apply?: boolean;
  limit?: number;
  env?: Record<string, string | undefined>;
  write?: (message: string) => void;
} = {}): Promise<RecompressResult> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((message: string) => console.info(message));
  const apply = options.apply === true;
  const limit = Math.max(1, Math.min(options.limit ?? RECOMPRESS_BATCH_LIMIT, 5000));

  const endpoint = env.CLOUDFLARE_R2_ENDPOINT?.trim();
  const accessKeyId = env.CLOUDFLARE_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.CLOUDFLARE_R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.CLOUDFLARE_R2_BUCKET_NAME?.trim();

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("r2-recompress-credentials-missing");
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  // 1단계: 대상 후보 수집
  const candidates: RecompressCandidate[] = [];
  let scanned = 0;
  let jsonObjects = 0;
  let skippedByGuard = 0;
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    })) as {
      Contents?: Array<{ Key?: string; Size?: number }>;
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    };

    for (const item of response.Contents ?? []) {
      scanned += 1;
      const key = item.Key ?? "";
      if (!key) continue;

      if (!inspectDeletionKey(key).allowed) {
        skippedByGuard += 1;
        continue;
      }
      if (!isRecompressTarget(key)) continue;

      jsonObjects += 1;
      candidates.push({ key, sizeBytes: item.Size ?? 0 });
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  // 큰 객체부터 처리해 조기 효과를 극대화한다.
  candidates.sort((left, right) => right.sizeBytes - left.sizeBytes);

  const result: RecompressResult = {
    scannedObjects: scanned,
    jsonObjects,
    alreadyCompressed: 0,
    skippedByGuard,
    candidates: candidates.length,
    candidateBytes: candidates.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    processed: 0,
    savedBytes: 0,
    failed: [],
    remaining: 0,
    dryRun: !apply,
  };

  write(`스캔 객체: ${scanned.toLocaleString()}개`);
  write(`보호 자산 제외: ${skippedByGuard.toLocaleString()}개`);
  write(`JSON 후보: ${candidates.length.toLocaleString()}개 / ${formatBytes(result.candidateBytes)}`);

  if (!apply) {
    write(`dry-run 이므로 재압축하지 않았습니다. 실제 실행은 --apply 를 사용하세요.`);
    write(`이번 실행 처리 예정: 최대 ${limit.toLocaleString()}개`);
    return result;
  }

  // 2단계: 재압축
  const targets = candidates.slice(0, limit);

  /** 객체 하나를 재압축합니다. 검증 실패 시 원본을 복원합니다. */
  const recompressOne = async (candidate: RecompressCandidate): Promise<void> => {
    const { bytes, contentEncoding } = await readObject(s3, bucket, candidate.key);

    // 이미 gzip 이면 건너뛴다. 매직 넘버와 헤더 둘 다 확인한다.
    const isGzip = (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)
      || contentEncoding === "gzip";
    if (isGzip) {
      result.alreadyCompressed += 1;
      return;
    }

    const text = bytes.toString("utf8");

    // JSON 으로 해석되지 않으면 건드리지 않는다.
    JSON.parse(text);

    const compressed = compressJsonText(text);

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: candidate.key,
      Body: compressed,
      ContentType: "application/json",
      ContentEncoding: "gzip",
    }));

    // 3단계: 재업로드 결과를 다시 읽어 원본과 대조한다.
    const verify = await readObject(s3, bucket, candidate.key);
    if (decodeMaybeGzip(verify.bytes) !== text) {
      // 검증 실패 시 원본을 복원한다.
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: candidate.key,
        Body: bytes,
        ContentType: "application/json",
      }));
      throw new Error("재압축 검증 실패로 원본을 복원했습니다.");
    }

    result.processed += 1;
    result.savedBytes += bytes.length - compressed.length;
  };

  // 객체당 왕복이 3회라 순차 처리는 대량에서 지나치게 느리다.
  // 청크 단위 병렬 처리로 진행하되 실패는 개별 기록해 전체를 중단하지 않는다.
  for (let index = 0; index < targets.length; index += RECOMPRESS_CONCURRENCY) {
    const chunk = targets.slice(index, index + RECOMPRESS_CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map((candidate) => recompressOne(candidate)));

    settled.forEach((outcome, offset) => {
      if (outcome.status === "rejected") {
        const reason = outcome.reason;
        result.failed.push({
          key: chunk[offset].key,
          message: reason instanceof Error ? reason.message : String(reason),
        });
      }
    });

    const done = result.processed + result.alreadyCompressed + result.failed.length;
    if (done % 500 < RECOMPRESS_CONCURRENCY) {
      write(`  진행: ${result.processed.toLocaleString()}개 완료 / 절감 ${formatBytes(result.savedBytes)}`);
    }
  }

  // 이번 실행에서 확인하지 못한 후보 수. limit 로 잘린 뒤 남은 대상만 센다.
  result.remaining = Math.max(0, candidates.length - targets.length);

  write(`이미 압축됨: ${result.alreadyCompressed.toLocaleString()}개`);
  write(`재압축 완료: ${result.processed.toLocaleString()}개 / 절감 ${formatBytes(result.savedBytes)}`);
  if (result.failed.length > 0) {
    write(`실패: ${result.failed.length.toLocaleString()}개`);
    result.failed.slice(0, 5).forEach((entry) => write(`  ${entry.key}: ${entry.message}`));
  }
  write(`남은 후보: ${result.remaining.toLocaleString()}개 (다음 실행에서 이어서 처리)`);

  return result;
}

const isDirectRun = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  const apply = process.argv.includes("--apply");
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number.parseInt(limitArg.split("=")[1], 10) : undefined;

  runR2Recompression({ apply, limit: Number.isFinite(limit) ? limit : undefined })
    .catch((error: unknown) => {
      const detail = error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : String(error);
      console.error(`R2 재압축 실패: ${detail}`);
      process.exitCode = 1;
    });
}
