# Phase 2 verification

The implementation follows the subagent-authored, source-revalidated [plan](phase-2-plan.md).
Both phases' feature scope and final review are complete on the documented macOS
profile, including the origin-scoped authentication follow-up. The checks below are
observed results, not a claim that all possible schedules or platforms were tested.

## Delivered scope

- Four active runtimes, including starting/stopping/cleanup reservations; 32 remembered
  records. Creation, reopen, explicit confirmed stop and remembered selection are bounded.
- Private versioned catalog, legacy metadata adopted without moving Pi files, per-record
  metadata locks, and canonical-path/inode transcript ownership. Pi remains the only writer.
- One authenticated socket fairly rotates original bounded session receivers. Subscriptions
  execute in wire order; slow clients detach rather than receive silently incomplete streams.
- Tabs retain session-local drafts, activity, transcript and pending commands. Only the
  selected conversation mounts. No replay on reconnect; drafts do not persist across reload.
- Shared project files are explicitly disclosed. No automatic worktrees, arbitrary browser
  paths, model picker, split views, database or orchestration were added.

## Parent-run checks

- `bun run test`: **121 Rust tests passed**; the final frontend rerun passed **45 tests**.
  Three native tests are opt-in and were also run explicitly.
- `bun run typecheck`, `bun run build`, `cargo fmt --all -- --check`, and
  `cargo clippy --locked --workspace --all-targets -- -D warnings` passed.
- `cargo test --locked --test session_lifecycle -- --ignored`: both Phase 1 native tests
  passed, including large-history child kill/restart. No inference.
- `cargo test --locked --test session_manager_native -- --ignored`: two installed native Pi
  children became ready independently; stopping/reopening A changed its epoch without
  disturbing B; all children shut down. No inference.
- `bun scripts/multiple-session-smoke.mjs --run --server /Users/joadithya/.cargo/target/debug/pi-web`:
  real authenticated HTTP/WebSocket routing passed with two deterministic children,
  independent cancellation, contiguous per-session sequences, reconnect during generation,
  stop/reopen, and four pipelined unsubscribe/subscribe pairs. A noisy A did not starve B's
  command: **10ms** in the final sampled run. This is a test observation, not a latency SLA.
- Production JS: **228.86kB**, gzip **87.79kB**, plus 5.91kB CSS. No new Phase 2 dependencies.

New regressions cover catalog validation, legacy migration/corruption, concurrent admission,
request deduplication, stale epochs, delayed catalog receipts, buffered obsolete subscriptions,
late-created hard links, stale browser errors, and transient notices after healthy reattachment.
Delayed Create/Open receipts retain an immutable target independently of current catalog
selection; later manual tab choices invalidate old selection intent. Both paths have
failing-before/fixed-after regression evidence, including invalid wire-target coverage.
Runtime status now exposes identity reconciliation instead of advertising prompt readiness
while admission is deliberately held closed. The full Phase 1 preservation suite still passes.

## Production Chrome observations

Installed Playwriter, task-owned tab, temporary project, deterministic mock Pi, Rust-served
production assets, no provider requests:

- Independent drafts across tabs and two simultaneous retrying conversations.
- Stop A settled it and recovered its queued draft while B remained retrying.
- Confirmed Stop session A, then Reopen, preserved the in-page draft and B's activity.
- Reload reattached to the still-running B; keyboard submission worked.
- After the final receipt-target fix, a fresh production browser run created and selected B,
  submitted with Ctrl Enter, and rendered the completed mock answer/tool output safely.
- The 390px layout had 390px document width, no horizontal overflow; screenshot inspected.
- Reopening initially retained an obsolete attachment-error notice despite a healthy
  subscription. A failing regression was added; after the fix, another stop/reopen had
  no stale notice. No application JS exceptions were observed.
- One blocked inline-style CSP warning occurred around screenshot capture, without an
  identified source; repeating capture with a policy-violation listener did not reproduce
  it. CSP was not weakened. Missing favicon requests in earlier runs were harmless 404s.

The owned browser tabs, server and mock children were closed, and that disposable project
was removed. The test does not measure four native models' concurrent memory or throughput.

## Independent review

Two read-only reviewers examined manager/ownership and transport/browser boundaries.
They found subscription completion-order and stale-incarnation races, delayed catalog
rollback, and an inode-reservation gap after a transcript materialized. A final ownership
review found that refreshing a delayed receipt lost its original operation target.
Parent regressions reproduced these failures before fixes. Follow-up reviews reported no
remaining supported substantive findings in their transport/security, ownership/receipt,
and attachment-notice scopes. The final follow-up was focused on its fix and surrounding
contract, not a renewed whole-code audit. Reviews inspected source; test execution and
browser measurements above were parent-run. No review guarantees absence of bugs.

## Post-handoff cancellation regression

A delayed pre-implementation architecture review prompted another check of immediate Stop.
`immediate_stop_cannot_overtake_an_accepted_prompt` failed with stdin order
`[clear_queue, prompt, abort]` instead of `[prompt, clear_queue, abort]`: control-priority
requests could overtake a prompt already accepted by the runtime actor. The runtime now
awaits that prompt's bounded stdin-write notification before sending clear/abort, while
continuing to service the actor. It does not wait for the prompt's RPC response.

The original regression now passes. Additional tests verify cancellation while the prompt
response remains unanswered, separate write notification, and failed admission never
reporting a successful write. The full suite, three no-inference native checks, build,
typecheck, formatting, Clippy and authenticated multi-session smoke were rerun successfully.
The smoke was first invoked without its required `--server` argument and rejected usage;
the documented complete command above passed. Browser code was unchanged; prior Chrome
observations were not rerun for this backend-only fix. An independent source reviewer
found no substantive defects in the write-notice, timeout, epoch and cleanup paths. The
reviewer did not execute tests; the complete passing rerun above was parent-run. Dedicated
tests for queued-request expiry and a delayed old prompt acknowledgment remain additional
coverage opportunities, not observed failures.

## Post-handoff late-dialog regression

A delayed runtime-review follow-up identified another Stop race: new extension dialogs
were admitted after the initial pending-dialog drain. The regression
`dialogs_arriving_during_stop_are_cancelled_without_becoming_visible` first failed with
`Stop published a late extension dialog`. Its child emits confirm/select/input/editor
requests after `clear_queue` and withholds abort completion until they are all cancelled.

Incoming dialogs now receive cancellation while the cancellation gate is held, including
unconfirmed cancellation; they never become interactive browser modals during Stop.
The regression verifies four cancelled replies, no visible dialog and successful settlement.
The full suite, all three no-inference native checks, authenticated multi-session smoke,
build, typecheck, formatting and Clippy passed again. Browser code did not change, so the
prior Chrome observations were not rerun. Independent follow-up source review found no
substantive defects in the guard, regression or surrounding cancellation lifecycle. The
reviewer confirmed the gate remains held through unconfirmed cancellation; that later
state was source-reviewed, not separately exercised by the new regression. Tests above
were parent-run, not independently executed by the reviewer.

## Post-handoff cross-port authentication regression

A delayed security review identified that a host-only HttpOnly/SameSite cookie is not
port-isolated: another service on `127.0.0.1` can receive it. A port-specific cookie name
does not fix that boundary. Regression tests first demonstrated cookie-only replay
reaching upgrade validation (400) rather than being rejected as unauthorized (401),
and that bootstrap still issued an ambient credential.

The capability now lives in origin-scoped tab session storage and memory, never cookies.
Bootstrap removes the fragment, verifies via non-redirecting same-origin HTTP, and
issues no credential. Each socket explicitly offers the public protocol and capability;
the server validates exact Host/Origin plus the unambiguous proof before upgrade, then
echoes only the public protocol. Missing, wrong, duplicate, malformed and cookie-only
proofs fail. There is no compatibility fallback. An independent design oracle favored
this pre-upgrade proof over adding a first-frame unauthenticated socket state machine.

Frontend regressions cover storage absence/malformed values, rejected credentials,
same-document reauthentication, reload, memory-only operation when storage is blocked,
and the explicit socket offer. The real HTTP/WebSocket multi-session smoke passed with
cookie replay rejected, the public-only negotiated protocol, independent generation,
ordered subscriptions and reconnect. The complete Rust suite (121 tests), final frontend suite (45 tests), typecheck,
build, formatting and Clippy passed after these changes. The three native no-inference
checks listed above and two Python cleanup regressions were also rerun successfully.
The repeated Bun audit returned `{}`; the separate Rust advisory assessment still applies.

A fresh production Chrome check used a disposable mock-backed app and a separate
loopback listener, with no provider requests. The fragment was removed; reload
reauthenticated. Navigating the same tab to the other port exposed no stored capability,
and the listener's three observed requests contained no capability. Returning to the
original origin without a fragment reauthenticated; a new independent tab without the
terminal URL did not authenticate. The owned tabs, servers and fixture were cleaned up.
These are browser observations, not a claim of confidentiality against the local OS or
same-origin script compromise. Session storage is intentionally readable by this app's
JavaScript. Strict CSP, safe rendering and trusted static assets remain security boundaries.

Independent read-only security follow-up found no exploitable vulnerability or material
correctness defect in the authentication, storage, stale-socket and rendering boundaries
reviewed. It did not run tests. Its remaining verification requests were completed by
the parent: actual protocol echo, reload/cross-port isolation, older accepted/rejected/
network-failed authentication finishing after a newer success, and a real Chrome socket
close followed by automatic reconnect. That reconnect preserved the unsent draft,
negotiated only `pi-web.v1`, and produced no new browser errors. The owned tab, app and
foreign listener were cleaned up. The two newly added older-auth failure cases are test-
only additions after review; production code was unchanged. These observations do not
turn a focused source review into a security guarantee.

## Remaining limits

Platform verification is macOS arm64 with the pinned Rust/Bun/Solid/Pi profile. Windows
process supervision is not supported. Native Pi/provider memory and tool side effects are
outside app-owned queue budgets. Sessions share OS authority and project files; this is not
multi-user isolation. The existing block-buffer advisory applicability assessment remains
in [dependency security](dependency-security.md); no audit result is a malware guarantee.
