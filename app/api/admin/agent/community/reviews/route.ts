import { after, NextResponse } from 'next/server';
import { createCommunityStore, resolveCommunityActor } from '@/lib/community-agent/auth';
import { enqueuePostReview, notifyNextReview, syncReviewDecisionNotification } from '@/lib/community-agent/reviews';
import { processReplyDraft } from '@/lib/community-agent/replies';

export const maxDuration = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const actor = await resolveCommunityActor(request);
  if (actor instanceof Response) return actor;
  if (actor.kind !== 'admin') return NextResponse.json({ code: 'forbidden' }, { status: 403 });
  try {
    const { client } = createCommunityStore();
    const requestedId = new URL(request.url).searchParams.get('id');
    if (requestedId && !UUID.test(requestedId)) return NextResponse.json({ code: 'invalid_request' }, { status: 400 });
    let query = client.from('community_content_reviews').select('*').order('created_at', { ascending: false }).limit(50);
    if (requestedId) query = query.eq('id', requestedId);
    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ reviews: data, discordMode: process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_COMMUNITY_APPROVER_ID ? 'buttons' : 'review_link' });
  } catch { return NextResponse.json({ code: 'storage_unavailable' }, { status: 503 }); }
}

export async function POST(request: Request) {
  const actor = await resolveCommunityActor(request);
  if (actor instanceof Response) return actor;
  // Bound request before parsing, including chunked bodies.
  let text = '';
  if (!request.body) return NextResponse.json({ code: 'invalid_request' }, { status: 400 });
  const reader = request.body.getReader();
  try {
    let size = 0;
    const decoder = new TextDecoder();
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 2048) { await reader.cancel(); throw new Error('too_large'); } text += decoder.decode(chunk.value, { stream: true }); }
    text += decoder.decode();
  } catch { return NextResponse.json({ code: 'invalid_request' }, { status: 400 }); }
  finally { reader.releaseLock(); }
  let body: { action?: string; id?: string };
  try { body = JSON.parse(text); } catch { return NextResponse.json({ code: 'invalid_request' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !['approve','reject','process','notify'].includes(body.action ?? '') || Object.keys(body).some(k => !['action','id'].includes(k))) return NextResponse.json({ code: 'invalid_request' }, { status: 400 });
  if (actor.kind !== 'admin' && body.action !== 'process') return NextResponse.json({ code: 'forbidden' }, { status: 403 });
  try {
    const { client, store } = createCommunityStore();
    if (body.action === 'approve' || body.action === 'reject') {
      if (!body.id || !UUID.test(body.id)) return NextResponse.json({ code: 'invalid_request' }, { status: 400 });
      const { data, error } = await client.rpc('decide_community_review', { p_review_id: body.id, p_decision: body.action, p_actor_id: actor.userId });
      if (error) throw error;
      if (["published","rejected","expired"].includes(data?.code)) after(() => syncReviewDecisionNotification(body.id!));
      return NextResponse.json({ result: data });
    }
    if (body.action === 'notify') return NextResponse.json({ notification: await notifyNextReview() });
    // Recover an interrupted enqueue without recollecting or invoking Gemini for the post.
    for (const run of await store.recentRuns(7)) if (run.status === 'ready') await enqueuePostReview(run.id);
    const result = await processReplyDraft();
    const notification = await notifyNextReview();
    return NextResponse.json({ result, notification });
  } catch { return NextResponse.json({ code: 'review_operation_failed' }, { status: 503 }); }
}
