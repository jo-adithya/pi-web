# Phase 1 plan: lightweight Pi-Bolt web UI

**Status:** Phase 1 implementation and subsequent Phase 2 multiple-session work are authorized in conversation. Phase 2 must first be planned with a subagent after Phase 1. Use Bun, an `apps/` monorepo and `ts-rs`. Dependency installs, the documented nine-name one-install age exception, configured Codex smoke quota and the local read-only head adapter were separately approved. No commits, deployment or global changes are authorized by this document.

**Implementation checkpoint:** M0–M5 are complete on the recorded macOS arm64 profile. The Rust-served UI now performs real Codex/read turns, reconnects and restores saved Pi history. Production large-history continuation and browser responsiveness are measured. See `docs/phase-1-evidence.md` for current tests, regressions, browser results and remaining review items, and `docs/dependency-security.md` for dependency audit limitations.

Real Codex prompt/read/settled, active abort, recovery and exact-session restart pass (`docs/m0-rpc-evidence.md`). Large-history bounded-memory/ancestry and migration tests pass (`docs/m0-history-evidence.md`), using the approved bounded head adapter rather than aggregate transcript RPC (`docs/m0-head-evidence.md`). A >32 MiB session continues through Codex, and native late-history invalidation/startup-hook/dialog experiments pass (`docs/m0-handoff-evidence.md`). Bare `/lsp` remains terminal-only; `/lsp status` works. This is not blanket compatibility for every installed extension command. Production history adoption, browser reconnect/disconnect and chat/security/performance checks are implemented; final independent review reported no remaining substantive findings in its scope. Phase 2 planning follows.
**Research date:** 2026-10-29.

## 1. Recommendation and scope

Build a client-side **SolidJS 2 + TypeScript SPA**, statically served by one **Rust/Axum** executable. Use one same-origin WebSocket to a backend-owned session runtime. That runtime owns one long-running **`pi-bolt --mode rpc`** subprocess, its working directory, command correlation, and a bounded presentation snapshot. Pi-Bolt remains responsible for models, tools, credentials, context, and persistent conversation files.

Design the ownership boundary for multiple sessions now, but enforce **one active runtime** in Phase 1. A browser connection subscribes to a runtime; it does not own the process. A disconnect does not terminate generation.

Primary experience: readable prose, responsive streamed Markdown, unobtrusive tool activity, clear status, Send, Stop, and reliable resume. No file browser, Git UI, agent orchestration, workspace manager, model picker, image upload, terminal emulator, session branching UI, or remote hosting in this phase.

### Confirmed design-review decisions

- **Reliable resume, bounded reading window:** a history larger than the UI budget must not prevent resuming an otherwise usable Pi session. Full older-history browsing is deferred; the loading mechanism remains an M0 validation gate.
- **Simplest disconnect handling:** immediately cancel pending extension dialogs, with no reconnect grace timer and no automatic approval. A reload may interrupt an approval; ordinary generation otherwise continues.
- **Extensions are required:** support RPC-compatible extension tools, commands, and standard dialogs. Custom terminal-interface replacements are out of scope; a built-in-only MVP is not acceptable.
- **CLI-based session selection:** normal startup resumes the remembered session; use CLI `--new` / `--session <path>` to select another conversation. Browser New/Resume controls wait until Phase 2.

These choices settle product scope, not untested API capabilities or permission to implement.

### Existing repository

At planning time, `/Users/joadithya/documents/projects/pi-web` was a separate Git repository with no commits: `.gitignore`, `Cargo.toml`, and `src/main.rs` were untracked, and the Rust 2024 binary printed Hello World. The subsequently requested layout uses a root Cargo workspace containing `apps/server` and a root Bun workspace containing `apps/web`. The Rust package remains `pi-web` 0.1.0; startup now runs the local application rather than the original placeholder.

### Choices and simpler alternatives

| Choice | Why | Simpler alternative / cost |
|---|---|---|
| SPA, no SSR or SolidStart | Local app has no SEO requirement; static delivery needs no Node server | Plain HTML/JS would reduce build tooling, but loses requested Solid architecture |
| Axum owns the process, not the WebSocket handler | Survives reloads and naturally extends to independent sessions | Spawn per connection is smaller initially but breaks resume and duplicates agents |
| One session task with typed channels | Gives one owner of mutation and lifecycle without holding shared locks across I/O | A shared mutex becomes awkward around cancellation and concurrent events |
| Small application protocol, narrow Pi adapter | Enforces authorization, reliable snapshots, and UI contracts without reimplementing agent logic | Raw RPC proxy exposes unnecessary commands and gives the browser lifecycle responsibility |
| Pi files + one small app metadata file | No duplicated conversation store or database | CLI-only resume is even simpler, but loses convenient restart continuity |
| System fonts, Markdown parser + limited highlighter | Readable and small; avoids a large editor/design-system dependency | Plain streamed text is cheaper but fails the Markdown goal |
| Exact prerelease Solid pins | Meets Solid 2 requirement while containing churn | Stable Solid 1 is lower risk but would violate the requested stack; requires explicit approval |

## 2. Verified contracts and dependency baseline

### Evidence levels

- **Observed locally:** installed CLI reports `1.4.0 (Pi-Bolt 1.0.7)`, accepts `--mode rpc`, and exposes `--session`, `--continue`, `--session-dir`, and persistence controls.
- **Observed isolated RPC probe:** with temporary configuration/cwd, no persistence, extensions, MCP, skills, context files, or provider request: correlated `get_state`, `get_messages`, `get_entries`, `clear_queue`, and idle `abort` all succeeded (5/5). A `queue_update` event interleaved with responses. Closing stdin exited with code 0. Temporary probe resources were cleaned up.
- **Observed M0:** real streaming/prompt acceptance/settlement, tool read, active abort/recovery, exact-session restart, large-history continuation, standard dialogs and bounded head sampling. Retry/compaction recovery and production descendant cleanup remain explicit later-milestone tests.
- **Installation evidence:** macOS arm64 compiler binding, clean frozen installation, Rust/frontend tests, builds and dev/production browser fixtures pass. Axum/Markdown integration now has HTTP/security/component tests and production-browser evidence; no cross-platform claim.

Pi-Bolt is an independent Pi fork, not a timeless protocol alias. Its repository contains Pi sources with modifications. Research compared installed documentation and Pi-Bolt source at revision `7306219f2070af4429816e8879613057602ef814`; that fetched revision is not proof of the installed binary's source revision. Pin the installed Pi-Bolt version for the initial compatibility gate, record the actual executable path/version in diagnostics, and test before upgrading. No automatic Pi-Bolt update from this app.

### Candidate exact pins

These are published versions with compatible declared peers. The installed frontend/M0 pins are now verified on macOS arm64; backend/UI additions are validated as their milestones are implemented. Lockfiles are retained but not committed.

| Dependency | Candidate | Notes |
|---|---|---|
| Pi-Bolt | 1.0.7, reporting Pi 1.4.0 | Locally probed; use absolute executable path |
| Rust toolchain | 1.99.1 | Installed locally; record in `rust-toolchain.toml` during implementation |
| `axum` | 0.8.9 | Enable WebSocket support |
| `tokio` | 1.54.1 | Process, I/O, sync, time, signal, networking/runtime features only as needed |
| `solid-js` | 2.0.0-rc.19 | Official `next`; stable `latest` is 1.9.17 |
| `@solidjs/web` | 2.0.0-rc.19 | Renderer package; matched peer |
| `@solidjs/vite-plugin` | 3.0.0-next.52 | Scoped Solid 2 plugin; peers Vite 8/9 and rc.19 |
| `vite` | 8.2.4 | Security patch replaces vulnerable 8.2.1 candidate; fixture build verified |
| `typescript` | 5.9.3 | Conservative candidate, validate with package declarations |
| `markdown-it` | 15.0.3 | Raw HTML disabled; constrained rendering policy |
| `highlight.js` | 11.12.0 | Core + explicitly registered languages, not all languages |
| `vitest` | 4.1.12 | Patches two transitive mocker advisories; Vite 8 compatible metadata |
| `@solidjs/testing-library` | 1.0.0-rc.2 | Solid 2 peers |
| `jsdom` | 30.1.3 | Effective Node floor: 22.22.2 / 24.15.0 / 26+ |

Use Bun 1.4.4 (installed) for dependency installation and frontend scripts; retain the generated `bun.lock`, including the verified macOS arm64 compiler binding. Validate Vite/Vitest execution with this setup instead of assuming Bun compatibility. Tool CLI shebangs may still invoke installed Node 26.13.0; neither Node nor Bun is a production application server. Optional assertion helpers are not required; `@testing-library/jest-dom` 7.0.1 is a metadata-checked candidate if useful.

Other justified Rust dependencies: `serde`/`serde_json`, `tokio-util` for bounded line framing, `futures-util` for WebSocket stream/sink handling, `tower-http` for static assets, a UUID implementation, and small logging/error helpers only where needed. A Unix signal wrapper such as `nix` is justified for process-group cleanup. Resolve exact compatible patches in M0 and record `Cargo.lock`; do not invent a tested transitive matrix during planning. Use `ts-rs` 12.0.1 for the requested narrow Rust-to-TypeScript wire declarations, with explicit generation and a drift check. Generated types do not replace runtime validation or authorization. No SDK Node bridge, ORM, router library, or global frontend state library.

## 3. System and repository layout

```text
Browser: Solid 2 SPA
  App shell / connection status
    Session registry [one entry]
      SessionView(sessionId)
        Transcript + Markdown + ToolCard + Composer
                  |
             same-origin WS /ws
       sessionId + epoch + sequence + requestId
                  |
Rust / Axum: static assets, upgrade validation, client routing
  SessionManager { active: Option<SessionHandle> }
    SessionRuntime(appSessionId, cwd, epoch)
      serialized control + presentation reducer + snapshot
      pending RPC commands / extension dialogs
      process lifecycle + bounded queues
           |                       |
    stdin JSONL writer       stdout JSONL reader
           |                       |
           +---- Pi-Bolt RPC ------+
                      |
              native tools / provider access
                      |
              Pi-owned session JSONL

stderr --> bounded diagnostics, never stdout protocol parsing
App metadata --> app ID, cwd, Pi session path/ID (no transcript/keys)
```

Target layout (only the M0 workspace/type/compiler fixture is currently scaffolded):

```text
Cargo.toml / Cargo.lock / rust-toolchain.toml
package.json / bun.lock   Bun workspace; macOS arm64 compiler binding verified
apps/
  server/
    Cargo.toml
    src/
      main.rs            startup configuration, Axum wiring, shutdown
      lib.rs
      http.rs            static serving, WebSocket validation and client transport
      protocol.rs        Rust-owned browser wire types, derived with ts-rs
      session.rs         singleton manager, runtime ownership and transitions
      rpc.rs             child pipes, Pi command correlation and framing
      transcript.rs      presentation reducer and persisted-entry projection
      metadata.rs        private atomic metadata persistence
    examples/export_types.rs
    tests/
      protocol.rs / rpc_process.rs / session_lifecycle.rs / websocket.rs
      fixtures/          JSONL records and a test-only mock RPC executable
      real_pi_smoke/     opt-in isolated integration harness
  web/
    package.json
    vite.config.ts / tsconfig.json / index.html
    src/
      main.tsx / App.tsx / styles.css
      generated/protocol.ts   generated declarations; never edit manually
      transport.ts       one connection, routing, reconnect, version checking
      protocol.ts        runtime guards consuming generated declarations
      session-state.ts   per-session store and ordered event application
      components/
        SessionView.tsx / Transcript.tsx / Message.tsx
        Markdown.tsx / ToolCard.tsx / Composer.tsx / SessionStatus.tsx
    test/
    e2e/                 browser scenarios, added when their runner is selected
fixtures/protocol/       shared JSON examples checked by Rust and TypeScript
docs/phase-1-plan.md      this document
```

Keep modules concrete. Split `session.rs` only when actual complexity warrants it. Use rustdoc/JSDoc on ownership, ordering, cancellation, bounds, and recovery contracts—not wrapper layers or comments that restate types.

Production serves `apps/web/dist` from an explicit asset directory; bundling assets into the executable can wait. Development uses Vite's HTTP/WebSocket proxy to the loopback backend. The same security checks apply with an explicit development origin allowlist. Never serve the project directory or `.pi` as static assets.

## 4. Core ownership and state

### Three different identities

1. **Application session ID:** generated UUID, stable in app metadata; used in every session-specific browser command/event. Never a filesystem path.
2. **Runtime epoch:** fresh random identifier every process/runtime incarnation; prevents stale events, request IDs, and snapshots from an old child being accepted.
3. **Pi session ID + file:** returned by Pi; authoritative persisted conversation identity. May be absent before the first persisted interaction. Do not assume it equals the application ID.

`SessionManager` initially owns one optional handle. Its small boundary is lookup by application ID and start/stop the configured session. Reject attempts to create a second active runtime. Phase 2 changes this owner into a map; the runtime and UI remain session-local.

`SessionRuntime` owns cwd/model configuration, child supervision, pending commands, run state, active tools/dialogs, and the presentation snapshot. A single task serializes state changes. Pipe I/O and WebSocket senders are separate tasks; the runtime never awaits a full agent run or a blocked browser write inside its event loop. Waiting for an RPC response is represented in a pending-command table, not a blocking receive loop that would prevent processing cancellation or stdout.

### Orthogonal state

- Transport: connecting / connected / disconnected; not equivalent to agent status.
- Process: starting / ready / stopping / exited / failed.
- Agent: idle / submitting / running / retrying / compacting / awaiting-input / cancelling.
- Last outcome: success / aborted / error, with recoverable error details.

Show a simple Running, Idle, or Error label, with details such as “retrying” or “waiting for confirmation.” A tool error is not necessarily a session failure. Preserve completed text on failure. An aborted partial response is explicitly labeled, not presented as a successful completion.

### Single-writer rules

Allow one controlling browser connection per session in Phase 1; reject another with a clear “already attached” response until the previous connection closes or times out. This is not multi-user collaboration. A heartbeat detects dead sockets; reconnect acquires control and a fresh snapshot.

Set `submitting` **before** writing a prompt. A simultaneous second submission receives `busy`; do not rely only on disabled UI buttons. During a run, permit Stop and outstanding extension-dialog replies, not another prompt. Steering/follow-up UI and model/session switching wait. Deduplicate a request ID within a bounded runtime-epoch cache; same ID with different payload is an error. Never automatically replay a prompt after reconnect or backend restart: ambiguous delivery is shown as such for user inspection.

## 5. Pi-Bolt RPC integration

### Startup and framing

- Resolve the operator-configured Pi-Bolt executable to an absolute path. Use `tokio::process::Command`, argument arrays, `current_dir(canonical_cwd)`, and piped stdin/stdout/stderr. Never `sh -c`, shell interpolation, or browser-supplied executable/flags/environment.
- Keep one process alive across prompts. Use existing Pi credentials/configuration on the server. Extensions are required in the normal application profile; extension-disabled startup is only an isolated diagnostic/test profile. Record and test the intended RPC-compatible extension set without changing the user's terminal configuration. The application is not a sandbox.
- Start RPC with persistence enabled. On resume use `--session <validated exact path>`; fresh startup omits a session selector. Do not use interactive `--resume` picker or depend on “most recent” `--continue` for app identity.
- Start pipe readers before sending `get_state` / history requests. Wait for successful initialization before accepting prompts. RPC emits no JSON-mode session header.
- stdin is a single writer queue. Serialize one JSON object + LF per command; flush and report write failures. Generate internal RPC IDs and map them to browser request IDs where applicable; extension UI IDs have a separate namespace.
- Split stdout on **LF only**, tolerate CRLF. UTF-8 may cross read boundaries. U+2028/U+2029 inside JSON strings are not record boundaries. Use a length-limited codec, not unbounded `read_line` or whole-process `output()`.
- Continuously drain stderr independently in fixed-size chunks into a capped tail. No merged streams, terminal escape execution, or raw diagnostic forwarding by default.
- Unknown additive event types: bounded diagnostic + ignore. Malformed JSON or invalid required lifecycle data: visible protocol failure, reject pending work and shut down/recover deliberately. Do not silently skip data necessary for consistency.

### Events and completion

| Pi record | Required treatment |
|---|---|
| `response` with matching `id` | Resolve the command; verify `command` and `success` |
| Prompt `data.disposition` | `started`, `queued`, or `handled`: describes acceptance, **not completion** |
| `agent_start` | Mark active; events may arrive before the prompt acknowledgment |
| `message_start` | Allocate a runtime-local message ID; track role/content blocks |
| `message_update` | Delta-only wire event; append by `contentIndex`, not SDK cumulative `partial` |
| `text_end` / `thinking_end` / `toolcall_end` | Replace the corresponding partial block with authoritative completed content |
| `message_end` | Replace the whole reconstructed message with the authoritative final message |
| `tool_execution_start/update/end` | Correlate by `toolCallId`; final `result` is authoritative |
| `turn_end` | End one assistant turn plus tools, not the full request |
| `agent_end` | Low-level run ended; retries, compaction recovery, or queues may still continue |
| `agent_settled` | Session-level automatic work finished; reconcile outcome and readiness |
| Retry/compaction/queue events | Keep status truthful; do not declare idle from a transient `isStreaming: false` |

For `handled`, no generation may occur; return to idle only after reconciling observed activity/state, without waiting forever for a nonexistent completion event. A `queued` disposition is unexpected for our normal idle-only submission path but must be represented, not treated as success-complete. Generic tool `partialResult` is not guaranteed to be an append-only string. Display the latest bounded partial update as a preview; preserve tool-specific unknown details without inventing concatenation semantics. Final tool result and persisted `toolResult` must render once, not as duplicate cards.

Pi message bodies include text, thinking, tool calls, images, and custom roles. Support ordinary user/assistant/tool text; hide system messages/provider signatures, collapse available thinking text, display a safe placeholder for unsupported images/custom content, and honor custom `display: false`. Do not import SDK event types blindly: JSON/RPC removes cumulative snapshots from `message_update`.

### Cancellation and extension UI

Stop means: enter `cancelling`, send `clear_queue`, await its response, then send `abort`. Pi documents that abort waits for idle; queued work can otherwise continue. Keep processing all events while awaiting these responses. Show cancelled only after confirmed settlement/abort completion, not merely after enqueueing Stop. Preserve returned queued text as a recoverable draft if present. Timeouts show “cancellation unconfirmed” and offer a separately confirmed `terminate` action; do not mark idle based on a timer. Only the controlling connection may terminate its current session/epoch, and only after cancellation has timed out. This invokes the supervisor's process-group TERM/KILL escalation directly, without waiting for the stalled RPC writer or pending abort. It accepts no PID, executable, or signal from the browser. Mark partial work interrupted, fail pending requests, and allow explicit restart only after the old child is reaped and runtime cleanup completes; never automatically replay the prompt. Warn that termination cannot undo edits and may lose unpersisted output. Direct RPC `bash` is not exposed, so `abort_bash` is outside the normal UI path.

RPC-compatible extension tools, commands, and standard dialogs are required in Phase 1. Ignoring RPC UI requests can hang execution. Include minimal native dialogs for `confirm`, `select`, `input`, and `editor`, matched by Pi request ID; forward only validated responses to currently pending dialogs. Never auto-approve. Render `notify` as plain text; status/title/editor hints are optional and must not overwrite a user's draft silently. TUI `custom()` components and terminal renderer hooks are not available through RPC.

If a dialog has a Pi timeout, treat later replies as potentially stale. On detected controller disconnect, immediately cancel outstanding dialogs with `cancelled: true` and cancel any newly arriving blocking dialog while no controller exists. There is no reconnect grace-period timer. Notify on reconnect that input was cancelled; a routine page reload can interrupt a pending approval. This simplicity trade-off is accepted. Cancellation is not a sandbox guarantee: extension authors control their cancellation behavior. Ordinary generation otherwise continues while disconnected; never auto-approve to keep a task moving.

### Shutdown and crash

Normal server shutdown: stop new commands, cancel dialogs, clear queues/abort with a deadline, close stdin, await process exit, then escalate if needed. The isolated probe verified idle stdin EOF exit; active cleanup still needs testing. Initial proposed deadlines: 10 seconds for graceful abort, 3 seconds after TERM, then KILL and reap.

On macOS/Linux, create a process group and signal that group on forced termination; `kill_on_drop(true)` is only a child-handle safety net, not descendant cleanup. Explicitly await `wait()`/`kill()` and join reader tasks. Detached descendants can escape a group; document this residual limit. Windows Job Objects are a separate portability task—initial release targets this macOS environment, with Linux validation before claiming Linux support.

Unexpected exit fails all pending requests, marks active content interrupted, captures exit status and a bounded diagnostic tail, and keeps the last view visible. Do not auto-restart and replay a prompt that may already have edited files. Offer explicit restart of the same Pi session. An abruptly lost partial assistant response may not be persisted by Pi; disclose that rather than pretending to recover it from disk.

## 6. Browser communication and reconnection

Version the application protocol independently of Pi (`v: 1`). Every session-scoped record carries `sessionId`; mutations also carry the expected `epoch`. A minimal message family:

| Direction/type | Payload / semantics |
|---|---|
| Server `hello` | Protocol version, sole session descriptor, runtime epoch; no credentials or raw config |
| Client `attach` | `sessionId`; requests control and a current snapshot |
| Client `prompt` | `requestId`, `sessionId`, `epoch`, `text` |
| Client `cancel` | `requestId`, `sessionId`, `epoch` |
| Client `ui_reply` | `requestId`, session/epoch, pending `dialogId`, typed answer/cancel |
| Client `terminate` | Explicit confirmation, `requestId`, `sessionId`, `epoch`; controller-only after cancellation timeout; supervisor escalates termination of its owned child group |
| Client `restart` | Explicit confirmation, request/session/epoch; permitted only after exit/failure and confirmed child reaping/runtime cleanup (or startup failure before a child existed) |
| Server `result` | Matching request ID, success/error and optional acceptance disposition |
| Server `snapshot` | Session/epoch, `throughSeq`, status, retained messages, active tools/dialogs and truncation metadata |
| Server `event` | Session/epoch, increasing `seq`, a small presentation delta or status/dialog change |
| Server `error` | Scoped code, safe message, recoverability; transport errors can be unscoped |

Presentation events need only message started/delta/final, tool changed, status changed, and dialog/notice changes. Map known Pi records directly into these; do not design a universal provider-neutral agent protocol. Use shared JSON fixtures to keep Rust and TypeScript discriminated unions aligned. Runtime-validate browser input; TypeScript types alone are not validation.

### Reconnect without replay races

The backend runtime is the presentation authority. An attach operation is processed in that same serialized task: enqueue a snapshot through sequence N, then subsequent events N+1 onward to that connection's queue. No separate `get_messages` call during reconnect; it cannot reconstruct a currently streaming partial response reliably.

The frontend replaces its session state on the snapshot, then accepts only the current epoch and contiguous later sequences. A gap requests a fresh attachment/snapshot; no concatenating stale deltas. Queue admission for the snapshot and subscription must be atomic from the runtime's perspective. If the snapshot cannot fit the transport budget, send a smaller documented retained window, not an oversized blocking write.

No durable event log, replay ring, cross-restart exactly-once guarantee, or browser transcript storage is needed. Browser local storage can retain a draft and chosen session ID only, opt-in for sensitive drafts. Runtime request-result cache handles short-lived duplicates; loss across restart produces an explicit unknown outcome. Reconnect uses capped exponential backoff and stops hammering a rejected protocol/auth connection.

## 7. Persistence, history, and resume

Pi is the **only transcript writer**. Use its normal session system; never rewrite JSONL, copy credentials, or emulate context compaction.

App metadata lives outside the repository, in an OS user-data directory with private permissions, e.g. a small `state.json` containing schema version, application session ID, canonical cwd, and Pi session ID/path. Atomic temp-file + rename writes; no tokens or message bodies. Persist the actual session path from `get_state` once available, including after the first completed interaction. A fresh empty Pi session may not have a file yet; represent that explicitly. Corrupt/missing metadata should produce a recoverable startup choice, never silently load another “most recent” session.

**Confirmed Phase 1 resume UX:** start/restart the application with its remembered session; allow an explicit operator CLI `--session <path>` override or `--new` for a fresh session. Show current project/session and whether persistence is available. Starting a different conversation requires restarting with the appropriate CLI selection. No browser New/Resume controls, session picker, or arbitrary browser-entered path in Phase 1; defer those controls to Phase 2.

**Confirmed contract:** resume an otherwise usable Pi session even when its total history exceeds the UI budget; display a bounded recent reading window with an explicit older-history indicator. This does not promise that Pi itself can load unlimited or corrupt files. Pi resumes through `--session`; history retrieval is only for display. Do not make successful retrieval of the entire history a prerequisite for prompt admission.

At initial startup/restart, obtain `get_state` and establish Pi readiness independently of history rendering. `get_entries` returns all entries, including pre-compaction history and abandoned branches. Its optional `since` cursor returns everything after that entry, **not a bounded page or the latest N messages**. Unrestricted `get_entries` is therefore not the production startup strategy. `get_messages` is not a documented bounded-history alternative either, and does not guarantee every pre-compaction message.

**M0-selected approach, production integration still required:** use the bounded, read-only projection of the exact validated Pi session file, returning recent display entries without retaining the full transcript. Keep it within the transcript module; no new database, transcript writer, watcher service, or agent-context implementation. Before selecting an algorithm, verify active-branch/leaf identification, old-format migration timing, compaction/custom entries, individual oversized records, and a stable handoff to live RPC events. A file tail alone is not sufficient evidence of the active branch. Bound parser working memory as well as retained messages. Use Pi's current session identity and validated path; never expose arbitrary file reads to the browser.

Within the retained window, follow active-branch ancestry, preserve original historical text and visible summary markers, and exclude abandoned branches. Context edits affect model input, not historical reading. History-only errors must be shown separately from process readiness and must not terminate a healthy agent. A warning-only empty history is a recovery mode, not a substitute for passing the required large-session/recent-window acceptance test. If the proposed reader cannot meet that contract, stop at M0 and review a supported alternative; do not silently revert to refusing large sessions or raising memory limits.

Use persisted entry IDs for restored messages and epoch-local IDs for subsequent live messages. Browser reload uses the backend snapshot, preserving those live IDs. Backend restart replaces the presentation snapshot; verify the history-to-live handoff so late history cannot erase or duplicate new messages. Refresh Pi identity after settled runs; if an extension unexpectedly switches sessions, stop prompt admission and rebuild the snapshot under a new epoch rather than mixing transcripts. Session-changing extension commands remain outside the supported Phase 1 UI.

Full older-history browsing and session discovery can wait; reliable resume cannot. Prevent duplicate writers from this app via session-file/runtime ownership; warn not to open the same live Pi file in another TUI/process, which the app cannot globally guarantee without cooperating locks.

## 8. SolidJS 2 state and reading UX

### Current APIs, not Solid 1 defaults

Use `createStore`, `createSignal`, and derived `createMemo` from **`solid-js`**; render with **`@solidjs/web`**. Configure `jsx: "preserve"` and `jsxImportSource: "@solidjs/web"`, with **`@solidjs/vite-plugin`**, not `vite-plugin-solid`. Solid 2 does not export `solid-js/store` or `solid-js/web`.

Use one owned per-session store, exposed to `SessionView(sessionId)`; a small registry contains one entry now. Keep draft, scroll position, expanded tools, connection attachment, and message state keyed by session. Keep the WebSocket itself in the app-owned transport, not one socket per message or component. No module-global mutable singleton chat state.

Solid 2 store setters mutate a **draft**, not old path-setter calls. Ordinary writes are staged until the next microtask; immediate read-after-set sees committed old state. Keep sequence bookkeeping in the ordered transport/reducer boundary or within draft updates, not a read-after-write signal check. Use `flush` only at necessary imperative/test boundaries, not per token; `batch` is removed. Effects use tracked compute + untracked effect functions, with cleanup returned from the effect. Use current `onSettled`/owner disposal guidance, not copied `onMount` examples. Sockets/timers/subscriptions need explicit owning cleanup. Avoid async memos for transcript state; Solid's async scheduling is unnecessary here and can couple updates if misused.

### Visual design

- System proportional stack for prose and composer; system monospace only for fenced/inline code and terminal-like tool output.
- Reading column about 70–80 characters, responsive gutters, 17–18px baseline, line-height about 1.6, real paragraph/list spacing; adjustable font size and light/dark themes without a design system.
- Clear role headings and restrained message separation, not dense terminal logs or oversized speech bubbles.
- Tool cards collapsed by default: tool name, concise arguments summary, status/duration/error badge. Expanded content is plain preformatted text with wrapping toggle and copy action. Escape all tool arguments/output.
- Streaming text updates at most once per animation frame, optionally capped near 30Hz. Completed messages do not reparse when a new token arrives elsewhere.
- Start with re-rendering only the active Markdown message on a short throttle (approximately 50ms). For an unusually large active message, show the unfinished tail as plain text and finalize Markdown at a boundary/end. Do not claim a naive blank-line splitter is a correct incremental CommonMark parser: fences, lists, and references can span boundaries.
- Highlight completed code fences, with a limited language set (Rust, TS/JS, JSON, shell, Python, CSS/HTML). Unknown languages stay escaped text; no expensive auto-detection. Avoid re-highlighting the full message per token. Very large blocks remain unhighlighted with an explicit notice.
- Autoscroll only when already near the bottom. Scrolling upward suspends following; show “Jump to latest.” Preserve position during tool expansion and snapshot replacement where possible. Do not animate every token scroll; respect reduced motion.
- Keyboard-accessible tool toggles, visible focus, labeled input, Enter/Shift+Enter behavior documented, Send disabled while busy and Stop always accessible. Avoid announcing every token to screen readers; announce status/completion instead.

For large conversations, mount the latest approximately 100 messages and offer local “show earlier” within retained data. Do not mount collapsed tool bodies. A retained-window/truncation indicator is mandatory. Virtualized variable-height Markdown, search, and worker-based parsing wait until profiling demonstrates a need.

### Content security

Treat assistant Markdown and tool output as untrusted. Disable raw Markdown HTML and plugins that inject arbitrary HTML; allowlist link schemes, set safe external-link attributes, and disable remote images by default (privacy/network leakage). No `file:` links, script URLs, executable command links, or automatic URL fetches. Use only renderer-generated HTML at the narrow HTML insertion boundary, with explicit escaping for code and custom renderers. Security fixtures must cover the parser/highlighter combination; add a maintained sanitizer only if raw HTML or unsafe plugins become a requirement. CSP is defense-in-depth, not a substitute for safe rendering.

## 9. Resource budgets and backpressure

Initial values below are **proposed testable budgets, not measurements or immutable API promises**:

| Boundary | Initial budget / behavior |
|---|---|
| Browser command | 64 KiB WS message cap, prompt text <=32 KiB; reject before forwarding |
| Pi RPC JSONL record | 32 MiB hard cap, configurable by operator; oversized live records are explicit protocol failures. Do not request aggregate history that can exceed this cap; it is not a session-file size limit |
| stdin command queue | 16 commands with byte accounting; reject overload; reserve cancellation/control capacity |
| stdout-to-runtime queue | Bounded by count and bytes (e.g. 64 records / 64 MiB); drain independently of browser |
| Runtime presentation | Recent ~500 messages AND ~8 MiB text budget; explicit eviction marker; cap individual previews |
| Browser outbound queue | <=16 MiB and bounded message count; one bounded snapshot must fit; slow subscriber disconnects/resyncs |
| stderr | Fixed chunks, 64 KiB retained tail; no unbounded newline wait |
| Tool preview | ~64 KiB per active/completed preview; visibly truncated, original remains in Pi storage where recorded |
| Outstanding RPC requests | <=32; expire according to command class, clear on child exit |
| Request-result dedupe | ~128 recent small results per runtime; no claim beyond retention/restart |

Account for serialized bytes, decoded objects, and active message/tool content—not just channel length. One enormous `message_end`, image, or unrestricted `get_entries` response can dominate memory. Avoid aggregate history responses rather than raising the RPC limit to fit a session. The candidate file projection needs separate bounded parsing/scan budgets, verified during M0, including oversized individual entries; clipping data only after parsing a whole large record is insufficient. Measure peak memory and use bounded blocking work where filesystem projection would monopolize the runtime. Display projections omit base64 images/provider signatures and truncate large text with explicit markers; do not truncate the underlying Pi state.

Slow WebSocket readers must never stop stdout consumption. Enqueue nonblocking, disconnect/resnapshot lagging browsers, and continue updating bounded canonical state. Never silently drop text deltas while continuing a supposedly contiguous sequence. If the runtime itself cannot keep up, bounded pipe backpressure is acceptable temporarily; on sustained overload fail visibly rather than allocate without limit. Keep cancellation processing responsive and test this separately from normal token throughput.

Set Axum limits explicitly: documented defaults are 64 MiB incoming messages, 16 MiB frames, and unlimited maximum write buffer. Transport send deadlines and application queues matter; Axum's write-buffer option alone is not the whole backpressure solution. Bound active tools/dialogs and terminal caches too. No periodic transcript polling or background database/index service.

## 10. Local privileged-service security

1. Bind to `127.0.0.1` by default, not `0.0.0.0`. Support `::1` only deliberately; print the exact browser URL.
2. Validate HTTP Host and exact WebSocket Origin (scheme/host/port), rejecting missing/`null` origins for the browser endpoint. This guards cross-site WebSocket use and DNS rebinding; CORS alone does not protect WebSockets.
3. No permissive CORS. In production serve only the same origin. Development origins are explicit, not wildcard or “any localhost port.”
4. Add a per-launch random browser capability delivered in a URL fragment printed to the operator, then clear the fragment. Verify it over same-origin HTTP without issuing cookies; retain it in origin-scoped tab session storage (memory-only with a warning if storage is unavailable). Require the explicit capability in the WebSocket subprotocol offer before upgrade, and echo only the public protocol. Validate Origin/Host on both routes. Cookies are deliberately not authentication: they cross loopback ports. Do not log tokens or put them in query strings. This is a small local capability, not an account/login system; loopback HTTP means no claim of transport confidentiality. This supersedes the original cookie design after the cross-port security review; see phase-2-evidence.md.
5. Configure one canonical project cwd at backend startup. Browser requests reference session IDs, never arbitrary cwd/paths or executable options. Validate CLI resume paths against configured Pi session roots and verify their cwd header matches the selected project. Reject traversal/symlink escapes after canonicalization; revalidate at open. The operator can explicitly choose a different allowed project when restarting.
6. Keep provider credentials entirely in Pi's server-side environment/config. Do not return environment dumps, provider configuration, or raw logs. Transcripts/tool output can themselves contain secrets; suppressing config endpoints does not make conversations secret-free.
7. Expose only the narrow browser commands above. No generic RPC passthrough, shell endpoint, arbitrary file reads, export-path endpoint, or model-config mutation endpoint.
8. Serialize mutations; one child per Pi session file within the manager. Apply size/rate limits and fail stale session/epoch commands.
9. Serve only built assets; CSP restricts scripts/connect destinations to self, disallows objects/framing, and limits images/fonts. No third-party analytics, fonts, or CDN runtime assets.
10. Make trust explicit: the agent can execute shell commands and follow trusted project/extension instructions with the user's OS privileges. Cwd restriction prevents API misuse, **not filesystem confinement** of tools. Never launch as root; do not automatically approve untrusted project files or extension installation.

Before any remote access: require a deliberate redesign/review for TLS, strong authentication/session revocation, authorization, CSRF, network exposure controls, per-user isolation, credential management, process/filesystem sandboxing, audit policy, and resource quotas. Changing a bind address is not sufficient. Worktrees are not a security sandbox either.

## 11. Implementation milestones and tests

Each milestone ends with observable evidence. Implementation, dependency installation, the documented nine-package one-install release-age exception, smoke tests using the configured Codex subscription/extensions, and the project-local read-only history-head adapter were approved in conversation. New providers, spending arrangements, or policy exceptions require separate approval.

| Milestone | Work | Exit gate |
|---|---|---|
| **M0 — compatibility and history gate** | Resolve exact candidate pins; minimal Solid 2 render/store/compiler fixture; isolated real Pi probe; evaluate bounded read-only history projection; record supported binary, platform and extension profile | Clean lockfile install, TypeScript check, dev + production build, staged update/disposal test; real Pi prompt -> tool -> settled and active abort contracts verified; large-history experiment proves recent-window correctness, bounded added memory and continued prompt readiness |
| **M1 — RPC transport** | Typed commands, bounded LF decoder/writer, correlation, stderr drain, process supervision | Mock process tests pass for fragmentation, interleaving, errors, queue pressure and EOF; no leaked child |
| **M2 — session runtime** | Singleton manager, IDs/epochs, reducer, startup/history, metadata and transitions | Deterministic tests for duplicate/busy requests, retry/compaction settlement, cancellation, resume, and crash recovery |
| **M3 — secured WebSocket** | Static routing, Host/Origin/capability checks, attach snapshots, bounded client queues | Integration tests reject hostile/stale/oversized requests; disconnect/reconnect during tool streaming is gap-free or explicitly resynced |
| **M4 — readable vertical slice** | Per-session Solid store, composer/status, streamed Markdown, code, tool cards, minimal dialogs | Component tests + browser prompt/read/stop/reload flow; keyboard/focus/scroll and hostile content tests |
| **M5 — persistence and hardening** | Real restart/resume, slow-client/resource tests, shutdown escalation, polished errors | Opt-in Pi smoke passes; budgets measured; final acceptance checklist and unsupported limits documented |

M0 runs only after implementation authorization; it is not work authorized by this plan review. If rc.19, the actual Pi binary, the required extension profile, or the large-history approach fails, stop and choose a supported alternative or explicitly approved scope adjustment before building atop it. Expected solo effort is roughly 2–3 focused weeks, with prerelease/extension integration uncertainty; checkpoints are more meaningful than a fixed deadline.

### Mock-subprocess tests

Use a test-only executable that reads the same stdin JSONL and emits scripted stdout/stderr. No trait framework or fake model provider is required for most backend tests. Cover:

- Byte-by-byte records; multiple records per read; CRLF; split UTF-8; embedded Unicode separators; malformed JSON; oversized record; partial last line/EOF.
- Responses out of order with events between them, absent/unknown IDs, rejected prompt, disposition `handled` with no run, events before prompt acknowledgment, no duplicate response after acceptance.
- Multiple content blocks; authoritative text/message replacement; tool partial snapshot versus delta assumptions; one card per tool ID; unknown additive events.
- `agent_end` followed by retry/compaction/another run before `agent_settled`; terminal provider error; user abort; tool failure that still allows a successful answer.
- Burst of simultaneous prompts, duplicate IDs, full queues, cancellation while output is heavy, `clear_queue` before `abort`, stalled abort, pending extension confirmation and disconnect cancellation.
- Crashes/broken stdin, noisy stderr without newlines, never-exiting child, process-group escalation, pending request cleanup, failed startup readiness, no automatic prompt replay. A mock abort that never responds must permit confirmed termination, reject restart until reaping/cleanup finishes, then permit explicit restart. Reject premature termination, stale epochs, and non-controller requests.
- History with branches, compaction, custom/context-edit entries, empty session path, missing/corrupt metadata, mismatched cwd, unexpected Pi session change. Add separate projection fixtures whose total size exceeds both presentation and RPC budgets: resume must still work and only a correct recent window is retained. Include oversized individual records, partial trailing writes, migration/replacement during startup, unavailable history with a healthy child, and history-to-live handoff without erasure/duplication; measure peak added memory.

### Frontend and WebSocket tests

Use Vitest + jsdom + the Solid 2 testing library: set jsdom environment explicitly, browser/development resolution conditions per official docs, cleanup owners after each test, `flush()` for staged synchronous writes and async queries for promises. Verify two **in-memory test stores** remain isolated, without launching two production sessions.

Use golden protocol fixtures and reducer tests for snapshot + live ordering, stale epochs, sequence gaps, truncation, reconnect/draft behavior and disconnected-versus-idle distinction. Test script/HTML/link/code injection, remote-image suppression, unknown languages, incomplete fences, tables/lists and long responses. Browser tests—not jsdom—verify layout, focus, text selection/copy, scroll anchoring, responsive width, reduced motion and large-history responsiveness. Choose/install the browser runner only during approved implementation.

Backend security tests include hostile/missing/null Origin, wrong Host, missing/wrong explicit socket capability, rejected cookie-only replay, oversized prompt, unknown session, stale epoch, duplicate controller, invalid dialog ID, and path escape validation.

### Real Pi-Bolt integration smoke

Opt-in, never CI-default against a personal project. Use a disposable project/session directory, an explicitly chosen configured test provider, and an allowlist of harmless tools for the test. Provider calls may incur cost; require the operator's test authorization. Do not overwrite global Pi settings or touch real work.

1. Start the pinned real binary and verify correlated readiness/history.
2. Prompt for short Markdown and a harmless file read; observe text deltas, tool start/update/end, message finalization and `agent_settled`.
3. Cancel a longer response; verify clear-queue/abort semantics, final outcome, next prompt readiness.
4. Reload/disconnect during streaming; ensure the existing process continues and snapshot restoration does not duplicate text or rerun tools.
5. Stop server, restart with its saved Pi path, verify persisted conversation/cwd, then continue successfully. Repeat with a disposable session whose history exceeds the UI and RPC-record budgets; verify the recent window and explicit older-history indicator without rejecting resume, then send another prompt.
6. Terminate the child deliberately; verify interrupted UI, no automatic replay, explicit recovery, and cleanup of test-owned processes/files.
7. Repeat with the intended real extension profile: exercise required RPC-compatible tools/commands and standard dialogs, including immediate cancellation on disconnect with no automatic approval. TUI-only interfaces are explicitly unsupported; extension-disabled smoke tests do not satisfy this gate.

Report actual versions, commands, provider/tool profile, observed events, timing/memory, cleanup, and skips. Current evidence includes the isolated no-model probe and the Codex prompt/read/abort/recovery/restart smoke documented in `m0-rpc-evidence.md`. The separate head/history probes verify bounded metadata and large-history loading without inference; the handoff probe also verifies one Codex continuation from >32 MiB history. Full chat/browser interaction is recorded in `phase-1-evidence.md`; both final native recovery checks pass.

## 12. Phase 1 acceptance criteria

- [x] One static frontend + Rust server + one persistent Pi-Bolt RPC child; no Node production server/database.
- [x] Proportional prose/composer and monospace code/tool output, comfortable reading width, clear roles; keyboard and screen-reader basics work.
- [x] Tokens stream responsively, final Markdown/code render correctly, completed messages remain stable, tools collapse and correlate correctly.
- [x] Prompt acknowledgment is never labeled generation completion; retry/compaction cannot cause a false idle state; Stop confirms or clearly reports failure.
- [x] Browser reload during text/tool streaming restores a consistent snapshot without restarting Pi or replaying a prompt.
- [x] Server restart resumes the exact saved Pi session in the correct cwd; interrupted/unpersisted content is clearly distinguished. A session whose history exceeds the UI and RPC-record budgets still resumes, displays a bounded recent active-branch window, and accepts another prompt; memory measurements confirm the app does not retain its entire history.
- [x] RPC-compatible extension tools, commands, and standard dialogs work with the intended profile. Pending dialogs cancel immediately on detected disconnect, with no grace timer or automatic approval; reconnect explains the cancellation.
- [x] Normal startup restores the remembered session; CLI `--new` / `--session <path>` selects a different conversation. Browser session selection and custom terminal-interface replacements remain out of scope.
- [x] Errors and process exits are visible, pending requests resolve/fail, explicit restart works, and normal shutdown leaves no test-owned child/tool processes.
- [x] Backend rejects concurrent prompts and a second controlling tab; session IDs/epochs appear on all scoped wire messages; two isolated frontend stores pass tests.
- [x] Host/Origin/capability checks and malicious-content/path tests pass; no credentials/config endpoints or arbitrary RPC proxy.
- [x] Bounded queues/retention verified under a slow-client and large-output test; truncation/resync is visible, never silent corruption.
- [x] Proposed performance targets: on the recorded development machine, typical 100 KiB streamed answer with 500 retained messages keeps input-to-paint p95 under 100ms; streaming adds no sustained main-thread tasks above 50ms; idle interface CPU near zero apart from heartbeat. Measure Rust/SPA overhead separately from Pi/provider cost; no unsupported memory promise.
- [x] Lockfiles, supported Pi version/platform, commands to build/run/test, limits, trust model and recovery instructions documented; all M0–M5 gates complete or an explicit scope decision recorded.

## 13. Phase 2 evolution: design now versus defer

**Design now:** session-local runtime ownership; app ID distinct from Pi ID; epoch and routing fields; per-session cwd/model configuration; one controller rule; per-session Solid store and `SessionView(sessionId)`; no global transcript or process; no assumption that browser lifetime equals process lifetime.

**Phase 2 changes:** replace `Option<SessionHandle>` with a map keyed by app ID; add validated create/list/stop session commands; subscribe one WebSocket to multiple IDs; each process has its own stdin writer, pending commands, event sequence, transcript and limits. Add tabs/split views that instantiate existing session views. Store one metadata record per session. Add per-session model selection when idle, process-count/aggregate memory limits, fair WebSocket scheduling, and tests proving Stop in A cannot affect B. Existing per-session reducer and RPC adapter should not change their contracts.

**Defer:** generalized orchestration/schedulers, persistent event replay, multi-user permissions, browser workspaces, a filesystem browser, task dependencies, generalized transport abstraction, complex state library, virtualized transcript engine and database.

Before concurrent agents edit the same repository, offer explicit separate Git worktrees/branches with separate cwd values. Never create worktrees automatically in Phase 1. In Phase 2 require user-authorized creation/removal, dirty-tree checks, branch naming and cleanup policies, awareness of shared ports/dependencies, and a deliberate merge/review workflow. Worktrees isolate working files, not credentials, filesystem permissions, external services, or all repository-level state. Multiple processes must not open the same Pi session file concurrently.

## 14. Risks, unresolved gates, and approval points

| Risk | Decision / mitigation |
|---|---|
| Solid 2 remains RC and compiler/plugin packages are prerelease | Exact pins, official v2 docs, M0 build + state/disposal test. Stable 1 fallback only with approval |
| Pi protocol evolution / installed-versus-source mismatch | Record binary version; fixtures and real smoke gate upgrades; require `agent_settled` capability rather than invent old-version completion heuristics |
| Installed extensions write stdout or rely on terminal UI | Separate stderr; fail malformed protocol visibly; minimal dialog support; test actual profile; no blanket promise of TUI parity |
| Long history is delivered as a large RPC record | Reliable resume with a recent window is required; no fake pagination or full-history startup request. Bounded read-only projection is an unverified M0 candidate; validate branch correctness, large records, handoff and memory before committing to it |
| Cancellation cannot undo edits or guarantee every detached process stops | Confirm settlement; process-group escalation; warn about already performed actions and detached descendants |
| Backend failure loses live in-memory text/request dedupe | Pi persisted finals survive; never promise exactly-once execution or replay automatically |
| Markdown correctness versus per-token CPU | Throttled active-only parsing, final authoritative render, plain-text tail for oversized live content; measure before adding worker/parser architecture |
| Localhost is privileged, not safe merely by being local | Host/Origin validation + local capability + narrow commands + safe content rendering; no remote bind shortcut |
| “Lightweight” cannot eliminate browser/Pi transcript memory | Bound the app's added state and DOM; measure browser/backend overhead independently; Pi owns its own full context |

The product decisions in Section 1 are confirmed: reliable large-session resume with bounded display, immediate dialog cancellation, RPC-compatible extensions, and CLI/remembered-session selection. Rejecting otherwise usable sessions solely because history exceeds the UI budget is no longer an acceptable alternative. The **Solid 2 RC dependency baseline** and **macOS-first/local-only release** remain as described. M0 compatibility/history feasibility is now verified on the recorded profile; production integration, security and resource gates now pass on that profile. Updating this plan does not itself expand authorization.

## 15. Sources and evidence ledger

Primary sources accessed on the research date:

1. [Pi-Bolt repository](https://github.com/opensec-git/Pi-Bolt), particularly its explanation of Pi sources plus fork changes. Installed `pi-bolt --version` / `--help` are the binary evidence.
2. Installed matching references under `/Users/joadithya/.pi-bolt/pi-bolt-darwin-arm64-jit/docs/`: `rpc.md`, `rpc-commands.md`, `json.md`, `rpc-extension-ui.md`, `message-types.md`, `sessions.md`, `session-format.md`; examples under the installation's `examples/rpc-client.ts`. These establish local documented behavior, not a perpetual upstream contract.
3. [Pi-Bolt RPC source at researched revision](https://github.com/opensec-git/Pi-Bolt/blob/7306219f2070af4429816e8879613057602ef814/packages/coding-agent/src/modes/rpc/rpc-mode.ts), and [JSON event documentation](https://github.com/opensec-git/Pi-Bolt/blob/7306219f2070af4429816e8879613057602ef814/packages/coding-agent/docs/json.md). Source confirms prompt preflight response, command correlation, state/history and abort handling.
4. [Official Solid 2 migration guide](https://v2.solidjs.com/migration/from-solid-1), [testing guide](https://v2.solidjs.com/guides/testing), [render reference](https://v2.solidjs.com/reference/solid-web/rendering-ssr/render), [onSettled reference](https://v2.solidjs.com/reference/solid-js/lifecycle-actions/on-settled), and [RC announcement](https://github.com/solidjs/solid/discussions/2995).
5. npm publication metadata: [Solid next](https://registry.npmjs.org/solid-js/next), [renderer next](https://registry.npmjs.org/@solidjs/web/next), [scoped plugin](https://registry.npmjs.org/@solidjs/vite-plugin/latest), [Vite 8.2.1](https://registry.npmjs.org/vite/8.2.1), [TypeScript 5.9.3](https://registry.npmjs.org/typescript/5.9.3), [Vitest 4.1.11](https://registry.npmjs.org/vitest/4.1.11), [testing-library next](https://registry.npmjs.org/@solidjs/testing-library/next), [jsdom 30.1.3](https://registry.npmjs.org/jsdom/30.1.3). Dist-tags can change; the table records the observed values.
6. [Axum WebSocketUpgrade](https://docs.rs/axum/latest/axum/extract/ws/struct.WebSocketUpgrade.html), [Tokio Command](https://docs.rs/tokio/latest/tokio/process/struct.Command.html), [LinesCodec](https://docs.rs/tokio-util/latest/tokio_util/codec/struct.LinesCodec.html); [Axum registry](https://crates.io/api/v1/crates/axum), [Tokio registry](https://crates.io/api/v1/crates/tokio).
7. [Markdown-it publication](https://registry.npmjs.org/markdown-it/latest), [highlight.js publication](https://registry.npmjs.org/highlight.js/latest), [highlight.js selective imports](https://highlightjs.readthedocs.io/en/latest/readme.html). Rendering safety is a required implementation/test contract, not a claim that a parser/highlighter sanitizes arbitrary HTML automatically.

**Original planning research limits:** no dependency installs, application scaffold, provider/model requests, real file-editing tool execution, UI browser test, or new runtime implementation was performed during the planning research. At that point only this plan was added to the repository. Subsequent M0 work is recorded in the checkpoint above and the root README. Dependency compatibility beyond declared peers and the no-model RPC probe remains an explicit implementation gate.
