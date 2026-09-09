# Community agent implementation rulings

Preserved in chronological order from the implementation ledger; each includes its cost.

1. Ruling: Treat plan snippets as behavior contracts, not transcription where they omit fixture or error-handling code; implement complete passing tests and runtime checks — examples explicitly require integration — costs additional local code review if interpretation differs.

2. Ruling: Task5 must make partial policy writes update only supplied fields rather than resend a stale full policy — a concurrent category/source update must not undo an operator pause — costs a small store change plus a focused concurrency/patch regression test.

3. Ruling: Reject official search snippets and empty/title-only material, but allow verified official YouTube description text alongside official patch-note bodies as factual evidence — the spec explicitly includes official video announcements and distinguishes description from unseen video content, so the review demand for body-only evidence would incorrectly discard an authorized source — costs narrower provenance checks/tests and reliance on the already-required semantic verifier for claims actually supported by a description.

4. Ruling: Use the existing administrator configure/enabling-publication action to authorize a narrow internal same-day ready-dryrun promotion after evidence/hash checks, retaining direct dryrun publication denial — this reconciles the agreed activation flow with the permanent dry_run guard without adding a per-post approval UI or a new public run action — costs one private transition and SQL/flow coverage; an incorrect implementation could strand a same-day draft, so verify pause/date/hash races.

5. Ruling: In Task8 keep YouTube initially deselected, delete its raw evidence metadata within30days, and use static YouTube citation labels in permanent posts — current primary provider policy requires raw metadata refresh/deletion even under accepted analytics use, while the plan permits blocked/unconfigured sources — costs shorter source-history detail and one explicit source-enable step after usage conditions are verified; no broader claim of legal compliance is made.

6. Ruling: Task6 must retain daily expired-data cleanup when the publication schedule is disabled, using a narrow authenticated cleanup-only route/runner mode with the existing worker secret — start-only cleanup plus a workflow-wide disabled gate would retain expired excerpts indefinitely during an ordinary pause, conflicting with the retention requirement — costs one bounded endpoint and runner/workflow tests; it performs no collection/model/post actions and skips entirely if not configured.

7. Ruling: Exclude site news bodies from official evidence until a producer-owned original-source relationship is available; a copied official URL or administrator authorship alone does not establish that the body is official text — current storage has no such provenance, and the spec requires withholding unsupported facts — costs fewer official-news candidates for now; verified official YouTube descriptions remain supported, and trusted original-body integration can be added when evidence exists rather than inventing trust metadata in this fix.
