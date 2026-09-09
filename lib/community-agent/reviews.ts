import { createCommunityStore } from './auth';
import { sendReviewNotification, type Review } from './discord-review';

export async function getReview(id: string): Promise<Review | null> {
  const { client } = createCommunityStore();
  const { data, error } = await client.from('community_content_reviews').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error('review_lookup_failed');
  return data as Review | null;
}

export async function enqueuePostReview(runId: string) {
  const { client } = createCommunityStore();
  const { data, error } = await client.rpc('enqueue_community_post_review', { p_run_id: runId });
  if (error) throw new Error('review_enqueue_failed');
  return data;
}

export async function decideDiscordReview(id: string, decision: 'approve' | 'reject', userId: string, messageId: string): Promise<{ code: string; postId?: number; commentId?: number }> {
  // No caller (including a worker) may use a Discord identity other than the configured owner.
  if (!process.env.DISCORD_COMMUNITY_APPROVER_ID || userId !== process.env.DISCORD_COMMUNITY_APPROVER_ID.trim()) throw new Error('review_owner_required');
  const { client } = createCommunityStore();
  const { data, error } = await client.rpc('decide_community_review', {
    p_review_id: id, p_decision: decision, p_actor_id: null, p_discord_user_id: userId, p_message_id: messageId,
  });
  if (error) throw new Error('review_decision_failed');
  return data;
}

/** Persisted outbox claim: failed sends remain retryable without regenerating the draft. */
export async function notifyNextReview(): Promise<{ code: string; reviewId?: string }> {
  const { client } = createCommunityStore();
  const { data: stale, error: staleError } = await client.from('community_content_reviews').select('id').eq('notification_error', 'discord_decision_update_failed').limit(1);
  if (staleError) throw new Error('review_notification_lookup_failed');
  if (stale?.[0]) await syncReviewDecisionNotification(stale[0].id);
  const { data: review, error } = await client.rpc('claim_community_review_notification');
  if (error) throw new Error('review_notification_claim_failed');
  if (!review) return { code: 'no_work' };
  try {
    const sent = await sendReviewNotification(review as Review);
    const { error: saved } = await client.from('community_content_reviews').update({
      discord_message_id: sent.messageId, notification_error: null, notification_lease_until: null,
    }).eq('id', review.id).eq('notification_attempts', review.notification_attempts);
    if (saved) throw new Error('review_notification_save_failed');
    const latest = await getReview(review.id);
    if (latest && latest.status !== review.status) await syncReviewDecisionNotification(review.id);
    return { code: 'notified', reviewId: review.id };
  } catch {
    const { error: saved } = await client.from('community_content_reviews').update({
      notification_error: 'discord_notification_failed',
      notification_lease_until: new Date(Date.now() + 5 * 60_000).toISOString(),
    }).eq('id', review.id).eq('notification_attempts', review.notification_attempts);
    if (saved) throw new Error('review_notification_save_failed');
    return { code: 'notification_failed', reviewId: review.id };
  }
}

/** Keep the existing Discord alert in sync after an authenticated web decision. */
export async function syncReviewDecisionNotification(id: string): Promise<void> {
  const review = await getReview(id);
  if (!review?.discord_message_id) return;
  const { updateReviewNotification } = await import('./discord-review');
  try {
    await updateReviewNotification(review);
    const { client } = createCommunityStore();
    await client.from('community_content_reviews').update({ notification_error: null }).eq('id', id);
  }
  catch {
    const { client } = createCommunityStore();
    await client.from('community_content_reviews').update({ notification_error: 'discord_decision_update_failed' }).eq('id', id);
  }
}
