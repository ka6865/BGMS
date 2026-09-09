# Community human review verification

## Behavior
- Verified runs create real private draft posts; publish API/SQL legacy path requires human approval.
- BGMS AI reserved profile is shared by posts and replies.
- SQL locks serialize approve/reject and writes; target snapshots and category/daily limits are checked.
- Dedicated review queue has RLS and no anon/authenticated grants. Service-only SQL uses security invoker and fixed search_path.
- Existing operations webhook is selected, public community webhook excluded. Direct Discord components need bot token and owner ID; existing webhook has application_id=null.

## Checks
- Disposable PostgreSQL17 with actual board image writer and actual comment writer: enqueue idempotency, private draft, unauthorized actor, edited body/comment, pause, approval/rejection, repeated decisions, bot loop exclusion, exact reply text, concurrent publication passed.
- Browser: actual AdminBotPage + SidebarFooterWrapper + CommunityAgentPanel + CommunityReviewQueue + app CSS, mocked auth/API, 375x667,390x844,430x932,1280x720. No document/card horizontal overflow, approve/reject update state, no browser errors. This is not a live authenticated production end-to-end test.
- Evidence: ignored tmp/community-ui-qa/review-{375,390,430,1280}.png and reviews-check.mjs.
- Live migration creates only one private queue table and service-only functions, renames configured bot profile, disables unconditional publication. Existing user content is not deleted.
- Existing ready run materialized into post168 with status draft; review pending. No new Gemini call needed for this post.

## Operational limits
Production app deployment and real Discord dispatch/interaction are not yet verified. The active develop environment lacks the review bot config. The original workspace contains a valid existing BGMS bot token; API lookup confirmed owner kangheesung_, but the bot receives 403 on the operations channel and has no interactions endpoint. Its public key differs from the active legacy slash bot configuration. Worker scheduling is not activated. Newly created drafts must not be represented as public posts.

Supabase advisory for new queue: INFO rls_enabled_no_policy is intentional for service-only data, with all anon/authenticated grants revoked ([linter documentation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)). Existing unrelated warnings retained unchanged.

Final pre-login-return checks: 14 test files /136 tests, TypeScript and scoped ESLint passed. Live draft168 remains draft/pending, author BGMS AI, notification message ID null. Queue plus indexes 81,920bytes.

Login return and dual Discord app signatures: full suite158 tests in16files, TypeScript and scoped ESLint passed. Anonymous API check confirmed draft168 returns no rows and review queue deniesSELECT(42501). Read-only independent SQL review found no authorization/atomicity/snapshot/cap blocker; terminal initial notification labeling fix is included before final handoff.

Final verification after terminal-alert correction: `npm run verify:community` now includes the new review/login/outbox/reply/Discord tests; 16files/160tests passed. TypeScript, scoped ESLint and diff whitespace checks passed. Temporary QA server4178 stopped; actual development server3000 retained. Both SQL migrations applied. Existing Discord bot channel permissions and production deployment/interaction setup remain pending; no real Discord alert was sent and no public post/reply was created.
