# Community agent final fix wave

Base: `bc81a5f`. Scope: the six findings from the final whole-branch review plus the named PostgreSQL extension-schema compatibility check. No production DB, deployment, public post, provider API, paid service, or external community write was used.

## Resolutions and rulings

1. **Critical — active publication pause.** The panel now sends `{enabled:false,publishingEnabled:false}` when pausing. A later `수집 재개` sends only `{enabled:true}`, so collection resumes while publication remains off. The existing partial-patch behavior remains unchanged for unrelated policy edits. The focused panel test starts from both flags true and checks the exact atomic request. The disposable PostgreSQL scenario invokes the same patch as `service_role` and proves both stored fields are false under the real table constraint. Cost: an operator must explicitly turn automatic publication back on after any pause.
2. **Important — unproven local official-body provenance.** `CommunityStore.loadOfficialEvidence()` now returns no site-local news bodies. A trusted URL copied into a published `배그 소식` post, including an administrator-authored post, does not prove a producer-owned original-body relationship. Verified official YouTube descriptions remain eligible through the existing validator and semantic verification. Cost: fewer official-news candidates and more safe deferrals until a trusted original producer integration exists; no provenance metadata was invented and patch sync was not changed.
3. **Important — stale approved title/HTML hash at publication.** `publish_community_post` recomputes SHA-256 from the locked `approved_title + '\n' + approved_html` immediately before the board writer. A mismatch returns `not_ready` without a post or run publication mutation. The `published_at` early return remains first, preserving response-loss/deleted-post idempotence. All legitimate fixtures now use exact hashes, and a title-tamper scenario proves rejection. Cost: one deterministic hash computation per publication attempt.
4. **Important — numeric fact guard omitted title/question.** The deterministic validator applies the official-evidence rule to the complete published text while retaining paragraph-specific checks. Numeric game-stat claims in either title or question are rejected without verified official evidence; an ordinary nonnumeric question remains accepted. Cost: ambiguous numeric drafts can be held conservatively for evidence.
5. **Important — permanent citation provenance.** Rendered citations use server-owned source and access labels plus the evidence `fetchedAt` check time. External titles are not permanent labels; YouTube keeps the static `YouTube 공식 영상` / `YouTube 공개 댓글` labels required by the 30-day raw metadata policy. Tests assert exact labels/times, unsafe title exclusion, sanitized HTML, and stable hash output. Cost: slightly longer citation HTML and a corresponding content hash change for newly rendered drafts.
6. **Minor — configured invalid provider credentials.** Naver HTTP 401 and YouTube's explicit `keyInvalid` reason map to `needs_setup` with safe fixed reasons. YouTube quota, general forbidden, and comments-disabled paths keep their distinct failure/partial meanings. All fixtures use injected responses and make no provider live calls. Cost: deliberately narrow classification can leave unknown provider errors as failures for an operator to inspect instead of guessing they are credentials.
7. **Named compatibility check — pgcrypto schema.** The verifier preinstalls `pgcrypto` under `extensions` and asserts it stays there. Runtime hash calculation uses the PostgreSQL core `pg_catalog.sha256(bytea)` plus qualified UTF-8 conversion/hex encoding, so it does not depend on the extension schema. The formula remains byte-for-byte compatible with Node SHA-256 over `title + '\n' + html`. This fixture does not claim to inspect the production extension layout.

## Red evidence

- Focused Vitest run after adding regressions: 4 files, 8 failed and 42 passed. Failures covered the active pause payload, local official evidence reuse, numeric title/question, citation provenance, and Naver/YouTube credential states.
- Disposable PostgreSQL 17 after adding the `extensions`-schema fixture: failed at `public.digest(bytea, unknown) does not exist`, confirming the schema assumption.
- Controller browser harness before the UI change: active `enabled=true,publishingEnabled=true` pause sent `{enabled:false}`, received fixture constraint 503, and left both flags true.

## Fresh green evidence

```text
npm run verify:community
  9 files, 88 tests passed

bash scripts/verify_community_agent_migration.sh
  PostgreSQL 17, pgcrypto in extensions, service_role pause, stale-title rejection,
  board rollback, single concurrent publish, deleted-post retry, publish/stop lock: passed

npm run verify:admin
  19 files, 382 tests passed

npm run verify:core
  exit 0; TypeScript 0 errors; ESLint 0 errors and baseline 52 warnings

git diff --check
  passed
```

Controller browser harness after the UI change: the same active state sent `{enabled:false,publishingEnabled:false}`, persisted both false without an alert, then `수집 재개` persisted enabled true while publishing stayed false. The harness used mock auth/API and a fixture DB invariant; it is not production Next/auth/DB or device Safari proof.

## Verification boundaries and cost

The run used fixed source/credential fixtures, an in-memory flow store, a disposable local PostgreSQL 17 container, and an isolated browser harness. The documentation lookups for current Supabase changes, PostgreSQL SHA-256, Naver 401 authentication semantics, and YouTube error separation did not call provider APIs. No new model call was made. Existing recorded development smoke remains five editorial/writer calls with 14,347 recorded tokens plus one earlier minimal connectivity call without token metadata; billing was not inspected.
