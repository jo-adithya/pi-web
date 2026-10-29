# Phase 1 integration evidence

Status: Phase 1 complete on the documented local macOS arm64 profile.
This records observed checks, not a guarantee for all extension profiles or machines.

## Delivered boundaries

`rpc/` owns bounded framing, correlation, independent pipe drains and Unix process
supervision. `session.rs` owns command admission, generation state, dialogs,
persistence and atomic snapshot/live ordering. `history/` projects recent active
ancestry without aggregate RPC. `http.rs` exposes only same-origin authenticated
static/WS traffic. The Solid client validates wire data and owns display/drafts,
not process lifetime. `protocol.rs` generates the shared TS declarations.

The runtime preserves prompt acceptance versus settlement, clear-queue-before-abort,
explicit recovery, stale-epoch rejection and one controller. Head/identity/file/live
revision checks reject stale history results. Final message replacement and tool
correlation avoid accumulated delta duplication.

## Mechanical checks

- `bun run test`: **104 Rust and 30 frontend tests passed** after the lifecycle,
  DOM-budget, HTTP-resource and epoch-boundary fixes. Two native tests are opt-in, not silently skipped.
- `bun run typecheck`, `bun run build`, `cargo fmt --all -- --check`, and
  `cargo clippy --locked --workspace --all-targets -- -D warnings` passed.
- `cargo test --locked --test session_lifecycle native_ -- --ignored --nocapture`
  explicitly passed **both** native tests: readiness/shutdown and 33 MiB history
  SIGKILL/restart/new-epoch/sustained-ready/reconnect. No provider requests.
- M0 native/provider/profile/migration/memory checks remain documented separately in
  `m0-rpc-evidence.md`, `m0-history-evidence.md`, `m0-head-evidence.md`, and
  `m0-handoff-evidence.md`.

Regressions demonstrated failure before fixes for tool-result double counting,
invalid browser frames/epoch handling, termination result loss, prompt admission
while Stop is pending, pending request cleanup on exit, duplicate termination,
same-document bootstrap URLs, historical tool-call omission, abort acknowledgment
before settlement, unexpected idle session replacement, and completed stale jobs
crossing an epoch boundary. Ordered RPC response checkpoints preserve new-session
live events while invalidating old-session work. Runtime tests also
cover a late history worker versus live events, slow subscribers, authoritative
message replacement, invalid deltas, history limits, crash/restart and immediate
dialog cancellation. Transport tests cover malformed/oversized records, pipe
fragmentation, response/event interleaving, queue pressure, stalled writers,
request timeouts, stderr tails and process-group TERM/KILL escalation.

## Production browser observations

Chrome via installed Playwriter, task-owned pages and temporary projects:

- Production Rust-served UI: prompt/stream/Stop, retry state, safe Markdown, tool
  cards, extension confirmation/cancellation, reload while running and preserved
  draft/no automatic replay. Keyboard submission, focus restoration and 390px
  responsive layout were inspected; no horizontal overflow was found.
- Native `openai-codex/gpt-6-astra`: harmless `read` of a temporary `smoke.txt`,
  streaming answer `UI_NATIVE_OK`, settlement, and exact saved transcript after
  server restart. No application configuration or provider credentials were exposed.
- A 33,655,478-byte synthetic native session resumed through the actual server;
  the UI mounted rows 500–599 with an older-history indicator, retained 500, and
  accepted one authorized Codex continuation `LARGE_UI_RESUMED` exactly once.
  Pi was isolated (read-only tool allowlist, no optional extensions/MCP). M0
  separately verified the configured user extensions and standard dialogs.
- Deliberate native child SIGKILL showed exited/failed. The actual `Restart Pi…`
  control and its confirmation restored ready/idle and 100 mounted recent rows;
  reload retained that state. Filling an unsent draft enabled Send. No inference
  was needed. Earlier waits used an incorrect button label or checked Send with
  an empty draft (correctly disabled), not evidence of a runtime recovery defect.
  A separate ignored native test verifies changed epoch and all 500 retained rows.
- Bootstrap tokens are removed from URLs. A same-document terminal-URL navigation
  originally failed to reauthenticate; a failing component regression now passes
  after installing/removing a scoped hash-change handler.
- Browser logs had no application JS exceptions in successful flows. Missing
  favicon requests returned 404. Expected WS errors occurred while a server was
  deliberately offline or its per-launch credential had become invalid. These original
  observations used the cookie bootstrap, since replaced after cross-port review;
  the current explicit origin-scoped proof is verified in `phase-2-evidence.md`.

All completed browser runs closed their own pages and servers. During deliberate
native termination the Playwriter relay also disappeared; the CLI reconnected and
recovered only the known task-owned page. This external relay interruption is not
counted as an application success. Temporary diagnostic fixtures remain under the
OS temp directory; no user project transcripts were altered.

## Performance sample (not an SLA)

Synthetic no-provider fixture `runtime_mock.py`, command `benchmark`: 500 retained
messages then 104,160 streamed text bytes (210 × 496 bytes, 40ms spacing). The
presentation visibly caps a message at 64 KiB. Production bundle in Chrome:

- 100 mounted messages, with local reveal control; 500 remain in bounded state.
- 40 composer edits: input-to-next-animation-frame p95 **17.2ms**, max **17.6ms**.
  This automation-inclusive frame latency is a paint proxy, not physical-display
  instrumentation. No >50ms main-thread long tasks were observed over streaming.
- Idle CDP `TaskDuration` over one second: **0.117%** main-thread task time.
- Post-stream JS heap sample: **6,701,640 bytes** (not browser process RSS/peak).
- Rust server RSS sample: **11,824 KiB**, separate mock child **14,128 KiB**.
- Real large-history server RSS sample: **9,472 KiB**, native Pi **337,216 KiB**.
  These are samples, not peaks or promises; M0 separately measured projection
  peak RSS and documented why native Pi still owns its full transcript/context.

The first benchmark exposed mounting all 500 messages. That requirement was fixed
with a tested 100-message window and unmounted collapsed tool bodies, then measured
again. One Playwriter call exceeded its default 10-second execution timeout; its
already-collected metrics were recovered without rerunning a provider.

## Review and remaining limits

Independent runtime reviews found cancellation/restart/dialog and pending-request
correlation defects; parent regression fixes are in place. A security review found
unbounded unauthenticated HTTP work and HTTP-drain-dependent Pi cleanup. Parent
reproduced stalled auth/shutdown regressions, then added a two-second auth deadline,
64 lifetime TCP slots with ten-second idle timeout, eight asset-worker slots held
inside the blocking work, and immediate agent shutdown with a three-second HTTP
drain limit. All affected checks pass; the follow-up security review found no further
substantive findings in that scope. A later runtime review caught completed jobs
surviving `abort_all`; a failing regression now passes by replacing the entire job
set. Follow-up scrutiny also caught a pending old-epoch prompt consuming
new-session events before identity reconciliation. A deterministic actor-pause test
reproduced this; the runtime now holds the already-bounded event queue while state
queries reconcile, including overlapping queries. Disconnect/cancellation controls
remain live. Stop results wait for that reconciliation and queued settlements;
post-Stop admission regression tests pass. An excessive pre-response event burst
can hit the documented transport overload deadline and fail explicitly rather than
retain an unbounded replay buffer. The final independent source review found no
substantive findings in this barrier/cancellation scope. Both native checks passed
again afterward. A final frontend self-review also fixed same-epoch reauthentication
leaving an unacknowledged prompt stuck as Sending: a failing component regression
now passes, preserving the draft and delivery-uncertainty notice without replay.
Reviews are source scrutiny, not proof of absence of bugs. M0 history scanner/head adapter also had bounded independent
reviews; later changes are covered by explicit tests and parent self-review.

The native test initially mistook Pi-Bolt's internal spawn helper for a second RPC
engine because it retains identical argv in a separate process group. Independent
process-tree/executable investigation and launcher disassembly identified the
helper; the test now kills only the unique direct child and cleans up both.

The repeated Bun audit returned `{}`. The 78-crate OSV audit has one old-series
block-buffer applicability mismatch, retained in `block-buffer-advisory.md` rather
than silently ignored. No new dependencies were added for the HTTP hardening.

No remote hosting, multi-user sandbox, full-history browser, terminal-only UI parity,
or guarantee to reap deliberately detached tool descendants. Current platform claims
are macOS arm64 only. Phase 2 subsequently received its required subagent plan and
implementation; see `phase-2-plan.md` and `phase-2-evidence.md`.
