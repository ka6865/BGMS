#!/usr/bin/env bash
set -euo pipefail
REVIEW_CONTAINER="bgms-review-check-$$"
trap 'docker rm -f "$REVIEW_CONTAINER" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$REVIEW_CONTAINER" -e POSTGRES_PASSWORD=test postgres:17 >/dev/null
for _ in $(seq 1 30); do if docker exec "$REVIEW_CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi; sleep 1; done
sql() { docker exec -i "$REVIEW_CONTAINER" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
sql < tests/fixtures/community-agent/prerequisites.sql
sql < supabase/migrations/20260718203104_board_image_storage_ownership.sql
sql < supabase/migrations/20260909061622_community_agent_persistence.sql
sql < supabase/migrations/20260909100149_community_agent_manual_retry.sql
sql < tests/fixtures/community-agent/review-prerequisites.sql
sql < supabase/migrations/20260719000000_create_published_post_comment.sql
sql < supabase/migrations/20260909111045_community_content_reviews.sql
sql < supabase/migrations/20260909111823_community_review_notification_outcomes.sql
sql < tests/fixtures/community-agent/review-scenarios.sql
# Simultaneous approvals create one published post from the existing draft.
sql -c "update public.community_agent_runs set published_at=now()-interval '1 day' where published_at is not null; insert into public.agent_runs(id,message) values('44444444-4444-4444-8444-444444444444','concurrent review'); insert into public.community_agent_runs(run_id,day,status,approved_title,approved_html,approved_category,approved_hash,validation) select '44444444-4444-4444-8444-444444444444',day-1,'ready','race fixture',approved_html,approved_category,encode(sha256(convert_to('race fixture'||E'\\n'||approved_html,'UTF8')),'hex'),jsonb_build_object('passed',true,'contentHash',encode(sha256(convert_to('race fixture'||E'\\n'||approved_html,'UTF8')),'hex')) from public.community_agent_runs limit 1; select public.enqueue_community_post_review('44444444-4444-4444-8444-444444444444');" >/dev/null
RID=$(sql -Atc "select id from public.community_content_reviews where run_id='44444444-4444-4444-8444-444444444444'")
sql -c "begin; select public.decide_community_review('$RID','approve','22222222-2222-4222-8222-222222222222'); select pg_sleep(1); commit;" >/tmp/bgms-review-a-$$ &
FIRST=$!
sql -c "select public.decide_community_review('$RID','approve','22222222-2222-4222-8222-222222222222');" >/tmp/bgms-review-b-$$ &
SECOND=$!
wait "$FIRST"
wait "$SECOND"
sql -c "do \$\$ begin if (select count(*) from public.posts where title='race fixture' and status='published')<>1 then raise exception 'duplicate concurrent publication'; end if; end \$\$;"
rm -f /tmp/bgms-review-a-$$ /tmp/bgms-review-b-$$
echo 'Community review SQL scenarios passed'
