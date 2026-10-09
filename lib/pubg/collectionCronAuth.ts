import { createHmac } from 'node:crypto';
import { matchesSecret, readBearerToken } from '@/lib/server/secretAuth';

export function signCollectionCronRequest(secret: string, timestamp: string) {
  return createHmac('sha256', secret).update(timestamp + '\nPOST\n/api/internal/pubg/collect').digest('hex');
}

/** SQL networking may expose queued headers to DB roles; never enqueue the key. */
export function authorizeCollectionCronRequest(request: Request, now = Date.now()) {
  const secret = process.env.PUBG_MATCH_COLLECTION_SECRET;
  const timestamp = request.headers.get('X-BGMS-Collection-Time');
  if (!secret || secret.length < 32 || !timestamp || !/^\d{10}$/.test(timestamp)) return false;
  const ageSeconds = now / 1000 - Number(timestamp);
  if (ageSeconds < -5 || ageSeconds > 120) return false;
  return matchesSecret(signCollectionCronRequest(secret, timestamp), readBearerToken(request));
}
