import { createClient } from '@supabase/supabase-js';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
import path from 'path';
import {
  getSupabaseDatabaseLimitBytes,
  R2_FREE_STORAGE_LIMIT_BYTES,
} from '../lib/admin-agent/storage-limits';

// Load .env.local for local testing
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const r2Endpoint = process.env.CLOUDFLARE_R2_ENDPOINT;
const r2AccessKey = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
const r2SecretKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
const r2BucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME || 'telemetry';

const DB_LIMIT_BYTES = getSupabaseDatabaseLimitBytes();
const R2_LIMIT_BYTES = R2_FREE_STORAGE_LIMIT_BYTES;

// Parse command line arguments
const args = process.argv.slice(2);
let label = 'STORAGE STATUS';
const labelIdx = args.indexOf('--label');
if (labelIdx !== -1 && args[labelIdx + 1]) {
  label = args[labelIdx + 1].toUpperCase();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function getStatusLabel(usagePercent: number): string {
  if (usagePercent >= 80) {
    return '\x1b[31m[경고] 조절 바람 (용량 확보 필요)\x1b[0m'; // Red
  } else if (usagePercent >= 60) {
    return '\x1b[33m[주의] 모니터링 필요\x1b[0m'; // Yellow
  } else {
    return '\x1b[32m[양호] 저장 공간 여유\x1b[0m'; // Green
  }
}

async function getDatabaseSize(): Promise<number> {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Supabase credentials are missing');
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data, error } = await supabase.rpc('get_db_size');
  if (error) {
    throw error;
  }
  return Number(data);
}

async function getR2BucketSize(): Promise<number> {
  if (!r2Endpoint || !r2AccessKey || !r2SecretKey) {
    throw new Error('Cloudflare R2 credentials are missing');
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: r2Endpoint,
    credentials: {
      accessKeyId: r2AccessKey,
      secretAccessKey: r2SecretKey,
    },
    forcePathStyle: true,
  });

  let totalSize = 0;
  let continuationToken: string | undefined = undefined;

  do {
    const command: ListObjectsV2Command = new ListObjectsV2Command({
      Bucket: r2BucketName,
      ContinuationToken: continuationToken,
    });

    const response = await s3.send(command);
    if (response.Contents) {
      for (const item of response.Contents) {
        totalSize += item.Size || 0;
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return totalSize;
}

async function main() {
  console.log(`\n\x1b[1;36m=================== BGMS ${label} MONITORING ===================\x1b[0m`);

  // 1. Supabase Database Size Checking
  try {
    const dbSize = await getDatabaseSize();
    const dbUsagePercent = (dbSize / DB_LIMIT_BYTES) * 100;
    console.log(`\x1b[1m[Database Size]\x1b[0m`);
    console.log(`  - Used: ${formatBytes(dbSize)} / ${formatBytes(DB_LIMIT_BYTES)} (${dbUsagePercent.toFixed(2)}%)`);
    console.log(`  - Status: ${getStatusLabel(dbUsagePercent)}`);
  } catch (err: any) {
    console.error(`❌ DB 용량 조회 실패: ${err.message}`);
  }

  console.log('');

  // 2. Cloudflare R2 Size Checking
  try {
    const r2Size = await getR2BucketSize();
    const r2UsagePercent = (r2Size / R2_LIMIT_BYTES) * 100;
    console.log(`\x1b[1m[Cloudflare R2 Bucket Size]\x1b[0m`);
    console.log(`  - Used: ${formatBytes(r2Size)} / ${formatBytes(R2_LIMIT_BYTES)} (${r2UsagePercent.toFixed(2)}%)`);
    console.log(`  - Status: ${getStatusLabel(r2UsagePercent)}`);
  } catch (err: any) {
    console.error(`❌ Cloudflare R2 용량 조회 실패: ${err.message}`);
  }

  console.log(`\x1b[1;36m===============================================================\x1b[0m\n`);
}

main().catch(err => {
  console.error('❌ 모니터링 실행 중 오류가 발생했습니다:', err);
  process.exit(1);
});
