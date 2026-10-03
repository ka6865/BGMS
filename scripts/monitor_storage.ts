import { createClient } from '@supabase/supabase-js';
import { getR2BucketUsage } from '../lib/pubg-analysis/r2Service';
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

  const { data, error } = await supabase.rpc('get_db_size').abortSignal(AbortSignal.timeout(30_000));
  if (error) {
    throw error;
  }
  const bytes = Number(data);
  if (data === null || !Number.isFinite(bytes) || bytes < 0) throw new Error('database-size-invalid');
  return bytes;
}

async function getR2BucketSize(): Promise<number> {
  const usage = await getR2BucketUsage();
  if (!usage.configured || usage.truncated) throw new Error('r2-size-unavailable-or-incomplete');
  return usage.totalSizeBytes;
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
  } catch {
    console.error('DB 용량 측정 불가 · 정상 용량으로 판단하지 않습니다.');
    process.exitCode = 1;
  }

  console.log('');

  // 2. Cloudflare R2 Size Checking
  try {
    const r2Size = await getR2BucketSize();
    const r2UsagePercent = (r2Size / R2_LIMIT_BYTES) * 100;
    console.log(`\x1b[1m[Cloudflare R2 Bucket Size]\x1b[0m`);
    console.log(`  - Used: ${formatBytes(r2Size)} / ${formatBytes(R2_LIMIT_BYTES)} (${r2UsagePercent.toFixed(2)}%)`);
    console.log(`  - Status: ${getStatusLabel(r2UsagePercent)}`);
  } catch {
    console.error('R2 용량 측정 불가 또는 일부만 조회됨 · 정상 용량으로 판단하지 않습니다.');
    process.exitCode = 1;
  }

  console.log(`\x1b[1;36m===============================================================\x1b[0m\n`);
}

main().catch(err => {
  console.error('❌ 모니터링 실행 중 오류가 발생했습니다:', err);
  process.exit(1);
});
