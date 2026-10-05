import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

export function parseCollectionCronArgs(args: string[]) {
  if (args.some(arg => !['--apply', '--disable'].includes(arg))
    || new Set(args).size !== args.length || args.length > 1) {
    throw new Error('collection-cron-invalid-options');
  }
  return args[0] === '--apply' ? 'enable' : args[0] === '--disable' ? 'disable' : 'status';
}

export function resolveCollectionCronSecret(defaultSecret: string | undefined, fileSecret?: string) {
  return fileSecret ?? defaultSecret;
}

export async function main(args = process.argv.slice(2)) {
  const mode = parseCollectionCronArgs(args);
  dotenv.config({ path: process.env.BGMS_ENV_FILE || '.env.local', quiet: true });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error('collection-cron-credentials-missing');
  const db = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }) },
  });
  if (mode !== 'status') {
    const secretFile = process.env.BGMS_COLLECTION_ENV_FILE;
    const fileSecret = mode === 'enable' && secretFile
      ? dotenv.parse(readFileSync(secretFile)).PUBG_MATCH_COLLECTION_SECRET : undefined;
    if (mode === 'enable' && secretFile && !fileSecret) throw new Error('collection-cron-secret-file-invalid');
    const secret = resolveCollectionCronSecret(process.env.PUBG_MATCH_COLLECTION_SECRET, fileSecret);
    if (mode === 'enable' && (!secret || secret.length < 32 || secret.length > 1024)) {
      throw new Error('collection-cron-secret-invalid');
    }
    const { error } = await db.rpc('configure_pubg_collection_cron', {
      p_enabled: mode === 'enable', p_base_url: 'https://bgms.kr',
      p_secret: mode === 'enable' ? secret : null,
    });
    if (error) throw new Error('collection-cron-configure-failed');
  }
  const { data, error } = await db.rpc('pubg_collection_cron_status');
  if (error) throw new Error('collection-cron-status-failed');
  return { mode, ...data };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('collection-cron-command-failed'); process.exitCode = 1;
  });
}
