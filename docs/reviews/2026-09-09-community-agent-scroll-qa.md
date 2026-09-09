# Community administration scrolling and controls

The admin layout constrains its children to the viewport and hides overflow. AdminBotPage previously returned the tab navigation and community panel without a scroll container, making the bottom of the page unreachable. The page now allocates the remaining height below the tabs to a scrollable community region. Chat retains its own scrolling layout.

The community panel puts DC, Naver cafe, and YouTube controls first, labels collection actions explicitly, and distinguishes current key presence from historical collection results. It explains draft generation, same-day terminal execution limits, and the separate scheduler requirement. No collection policy, API credential, database data, or publication setting was changed by this UI work.

Browser verification used the actual AdminBotPage, CommunityAgentPanel, SidebarFooterWrapper and global CSS in a local Vite harness. Authentication, provider/status responses and chat contents were mocked; no live collection or publishing occurred. Before the scroll fix, mouse wheel input left the draft heading at y=1158 and no scroll region existed. After the fix at 1280×720, scrollTop reached 697 and the heading became visible at y=461.

Verified 375×667, 390×844, 430×932 and 1280×720: mouse scrolling reaches the bottom and draft result, no horizontal overflow, YouTube toggle saves and updates its label, tabs remain reachable, and no browser page errors. Screenshots were visually inspected. Actual signed-in Next session was not automated; unauthenticated /admin/bot correctly redirects (307). Real device Safari behavior was not tested.

Validation: community suite 91 passed; targeted ESLint passed; TypeScript passed; git diff --check passed. Added behavioral checks for source-only configuration and disabled same-day terminal trial actions. Temporary harness and screenshots are under ignored tmp/community-ui-qa.


Follow-up: the subsequently requested manual retry feature replaces the same-day deferred/failed restriction described above. Terminal failures now expose a retry button; ready/published runs remain protected. The final community suite has 101 tests. Browser mocked retry flow completed one retry request and six stage requests with zero publication requests; mobile layout and scroll checks were repeated successfully. See the operations guide for the applied retry migration and real PostgreSQL concurrency verification.
