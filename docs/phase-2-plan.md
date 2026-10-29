# Phase 2 — multiple conversations

The planning subagent reviewed the current ownership boundaries after Phase 1 passed. This is the implementation plan, revalidated against `session.rs`, `metadata.rs`, `http.rs`, and `App.tsx`.

**Status: implemented and verified.** See [Phase 2 evidence](phase-2-evidence.md) for
checks, review scope and platform limits. No commits or deployment were performed.

## Scope and decisions

- Up to four active independent Pi runtimes in one operator-selected project; bounded remembered catalog (32 entries).
- Tabs, New, explicit confirmed Stop session, Reopen, per-session status/dialogs/drafts, one multiplexed authenticated WebSocket.
- Browser disconnect does not stop runtimes. Default startup opens only the remembered selection. Shutdown awaits every child, including starting/stopping children.
- Concurrent conversations share files: this is **not filesystem isolation**. No automatic worktrees, arbitrary browser paths, transcript discovery, model picker, or split views. Those are independent features rather than prerequisites for multiple conversations.
- Preserve Phase 1 metadata in place. A private versioned catalog references the legacy root record and new generated child directories. Corruption is explicit; orphan records are not auto-launched. Pi remains the only transcript writer.
- Keep the root metadata lock for the manager's entire lifetime, sharing its store with the legacy runtime rather than releasing the lock when that runtime stops.
- Establish and persist stable app identities before exposing new catalog entries. Reserve canonical transcript files across runtimes, including identity replacement; failed cleanup retains the reservation.

## Implementation slices

1. Add bounded atomic catalog storage and a shared transcript-ownership registry. Extract prepared runtime startup and observable lifecycle identity without changing the existing actor's cancellation/history barriers.
2. Add manager create/list/open/stop/lookup/shutdown operations. Count starting/stopping slots, deduplicate management requests, reject stale stop epochs, and await cleanup without blocking other session commands.
3. Multiplex the existing ordered runtime receivers over one socket. Keep frame permits through writes, bounded management replies, fair session scheduling, and reliable per-runtime disconnect. Reuse Host/Origin/capability/size/rate/heartbeat protections.
4. Split workspace connection/catalog ownership from per-session UI state. Render only the active tab; keep bounded inactive state and independent drafts, notices, pending requests, and dialog indicators. Never replay uncertain prompts or creates.
5. Exercise isolation and failure paths, update usage/evidence, and independently review/fix until no supported substantive findings remain.

## Acceptance evidence

- Mock integration: A/B simultaneous activity, independent cancellation, duplicate request IDs, four-runtime admission, competing controllers, stop/reopen epoch changes, reconnect, missing/corrupt metadata, canonical duplicate transcript rejection, shutdown of all children.
- Transport/UI: per-session ordering and routing, noisy-session fairness, slow-client handling, tab/draft/dialog isolation, reauthentication uncertainty, keyboard/mobile behavior.
- Preserve all Phase 1 tests and both native checks; add two-native-child readiness/stop/reopen/shutdown without inference.
- Full tests, type generation/typecheck, production build, formatting/clippy, final source/VCS inspection, production Chrome verification, independent correctness/security review.

Count/byte limits bound app-owned state, not native Pi/provider memory or external tool side effects. No dependency additions are anticipated. Live/shared data is not used for migration tests; commits, publishing and deployment remain unauthorized.
