import { authorizeBearerSecret } from '@/lib/server/secretAuth';
import { runScheduledDiscoveryBatch } from '@/lib/pubg/scheduledDiscovery.server';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** A fixed, bounded batch. Query parameters and request bodies cannot expand it. */
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  if (!authorizeBearerSecret(request, ['PUBG_MATCH_COLLECTION_SECRET'])) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401, headers });
  }
  try {
    const summary = await runScheduledDiscoveryBatch();
    return Response.json({ ok: true, ...summary }, { headers });
  } catch {
    // Do not expose keys, account identities, or upstream request details.
    return Response.json({ ok: false, error: 'pubg-collection-failed' }, { status: 503, headers });
  }
}
