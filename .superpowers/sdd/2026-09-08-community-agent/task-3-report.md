# Task 3: bounded public community evidence collection

## Implemented

- Added an injected-fetch HTTP boundary that permits only the three authorized HTTPS provider hosts, refuses redirects and credential-bearing URLs, limits each request to six seconds, and streams at most 1 MiB without logging response bodies or URLs.
- Added a 40-second dispatch deadline and collectors for the authorized DCInside PUBG gallery, Naver Cafe Search API, and the official `PUBG_KR` YouTube channel.
- DCInside reads at most two list pages, verifies the exact `battlegrounds` view URL and numeric post ID, limits candidate and body fetches (60 and 10), and caps body request concurrency at two. It removes navigation, ads, images, profiles, contact details, and IP addresses before retaining a 500-character excerpt.
- Naver makes at most three bounded queries, reports missing credentials as `needs_setup`, accepts only an exact authorized cafe URL and a direct verified article URL, and retains snippets with an unknown publication time.
- YouTube resolves or verifies the channel and uploads playlist, reads at most three videos from the last seven days, emits official description evidence separately from public comment evidence, limits comment requests to two concurrent requests, and records a per-video 403 comment restriction as `youtube_comments_disabled` instead of a source-wide failure.
- Evidence uses UUIDs, normalized title/excerpt SHA-256 hashes, and never retains author identity or provider credentials. It remains a `SourceReport` only; persistence is still owned by the existing store.

## TDD evidence

### RED

Command:

```text
npx vitest run tests/community-agent-sources.test.ts
```

Before implementation, Vitest failed during suite loading with:

```text
Cannot find module '../lib/community-agent/http'
```

This was expected because the requested HTTP boundary and collectors did not exist.

### GREEN

Commands:

```text
npx vitest run tests/community-agent-sources.test.ts
npx tsc --noEmit --pretty false
npx eslint lib/community-agent/http.ts lib/community-agent/sources.ts lib/community-agent/sources/dc.ts lib/community-agent/sources/naver.ts lib/community-agent/sources/youtube.ts tests/community-agent-sources.test.ts
```

Results:

```text
Test Files  1 passed (1)
Tests  8 passed (8)
```

TypeScript and focused ESLint completed with exit code 0 and no output.

## Files changed

- `lib/community-agent/http.ts`
- `lib/community-agent/sources.ts`
- `lib/community-agent/sources/dc.ts`
- `lib/community-agent/sources/naver.ts`
- `lib/community-agent/sources/youtube.ts`
- `tests/community-agent-sources.test.ts`
- `tests/fixtures/community-agent/dc.html`
- `tests/fixtures/community-agent/naver.json`
- `tests/fixtures/community-agent/youtube.json`

## Self-review

- Verified all outbound requests go through the host allowlist and use injected fetch.
- Verified no raw response, credential value, author profile, or URL is written to logs or reports.
- Verified source states distinguish missing configuration, normal emptiness, partial body/comment availability, selector/format blocking, and request failures.
- Did not run a live provider read: Naver and YouTube credentials are absent, and fixed fixtures cover their provider contracts. The prior authorized DC read-only probe already confirmed the selected list selector and link shape.

## Concerns

None. A future operation should still perform the separately authorized dry-run using configured Naver and YouTube credentials before enabling any scheduled production collection.

## Review fix round 1

- A verified DC list table that explicitly says there are no posts now reports `empty`; a missing list structure or an unrecognized empty shape remains `failed` as a block/format signal.
- The final evidence sanitizer now redacts Korean landline and VoIP formats plus full and compressed IPv6 forms, in addition to the original mobile, email, and IPv4 checks. `privacy.html` fixes those representative forms at the collector boundary.
- YouTube non-success responses retain only a small structured provider reason code. Only `commentsDisabled` is recorded as the normal comment restriction; another 403 such as `quotaExceeded` remains a partial collection failure cause.
- YouTube caps parsed top-level comments at 30 even for malformed upstream results. Its `fetchedCount` now covers retained descriptions and comments, so it matches `retainedCount` and cannot be clamped by the run-report store.

### Fix verification

Commands:

```text
npx vitest run tests/community-agent-sources.test.ts
npx tsc --noEmit --pretty false
npx eslint lib/community-agent/http.ts lib/community-agent/sources.ts lib/community-agent/sources/dc.ts lib/community-agent/sources/youtube.ts tests/community-agent-sources.test.ts
```

Results:

```text
Test Files  1 passed (1)
Tests  11 passed (11)
```

TypeScript and focused ESLint completed with exit code 0 and no output.
