# Pi Web

A local Solid 2 browser UI backed by Rust/Axum and persistent Pi-Bolt RPC processes.
Phase 1 and the Phase 2 multiple-conversation implementation run on the documented
macOS arm64 profile. No Node/Bun production server or database.

## Build and run

Verified on macOS arm64 with Rust 1.99.1, Bun 1.4.4, and
`pi-bolt` reporting `1.4.0 (Pi-Bolt 1.0.7)`. Install Pi-Bolt separately;
the application never installs or upgrades it.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
cargo run --locked -p pi-web -- --cwd /absolute/path/to/project
```

Open the **exact URL printed in the terminal**. Its fragment capability is
removed from the address bar, verified without cookies, and retained in this tab's
origin-scoped session storage for reloads. WebSocket handshakes explicitly present it
only to the same origin; other loopback ports receive no credential. A fresh independent
tab needs the terminal URL. If browser storage is blocked, authentication lasts only until reload.
The server binds only `127.0.0.1` (default port 9876). Keep that terminal running.

```sh
cargo run --locked -p pi-web                         # restore last workspace
cargo run --locked -p pi-web -- --cwd /project --new
cargo run --locked -p pi-web -- --cwd /project --session /allowed/session.jsonl
cargo run --locked -p pi-web -- --help
```

`--session-root PATH` explicitly allows additional existing Pi session roots.
The file's canonical cwd must match the selected project. No browser API accepts
session-file paths or executable arguments. The authenticated **Add workspace** form
accepts an existing absolute project folder after explicit trust confirmation.
`--pi`, `--web-dir`,
`--head-adapter`, `--state-dir`, and `--port` are operator-only options.
`--isolated` disables optional extensions, MCP/context discovery and all tools
except `read`, for disposable smoke tests.

Without `--cwd`, startup restores the last selected workspace (the shell's current
folder is used on first launch). `--cwd` selects or registers a particular project.
Normal startup opens only that workspace's remembered conversation and resumes its exact
Pi file. Other conversations remain stopped until reopened. Application metadata lives
under `~/Library/Application Support/pi-web/<project-key>/`; Pi alone writes its
transcript. The private workspace registry lives under the sibling `workspaces/`
directory. With `--state-dir`, the registry uses `<state-dir>/workspaces/`, the original
project metadata stays in place, and added projects use `<state-dir>/projects/<project-key>/`.
Missing previously saved files or unavailable folders fail explicitly when their conversation
is opened. Unavailable folders remain remembered without blocking healthy workspaces; if the
last-selected folder is unavailable at startup, use `--cwd /available/project` to select another.
Unsaved empty sessions can restart fresh; the UI distinguishes persistence and interrupted output.

## Use and limits

- Send with Enter, the button or Ctrl/⌘ Enter; Shift+Enter inserts a newline. Stop clears queued prompts, then requests
  abort; only `agent_settled` means completion. An unconfirmed cancellation offers
  separately confirmed process termination. Failed/exited children require explicit
  restart; prompts are never replayed automatically.
- Type `/` at the start of a message to complete loaded extension commands, prompt
  templates and skills. Use ↑/↓ to choose, Tab/Enter or a click to insert, and Esc
  to dismiss. Selection never sends the message; add arguments and send normally.
  Suggestions are conversation-local, refresh when its runtime starts/restarts,
  and exclude Pi's terminal built-ins. Extension commands may still require a
  terminal-only UI; argument completion and hot-reload refresh are not supported.
- The composer shows the current **Model** and **Thinking** level. Pick from Pi's
  configured models and the selected model's supported thinking levels while idle;
  controls remain on the confirmed values until Pi accepts a change. Thinking output
  stays hidden in the transcript. The **codex-fast** extension's status is displayed
  when available; “requested” describes a preference, not confirmed provider routing.
- Enable **Notifications** from the three-dot session menu to receive private,
  generic completion alerts for connected conversations, including background ones.
  Browser permission is requested only when enabled; click an alert to open its
  conversation. Requires a supported browser and HTTPS or localhost, with this tab
  open and connected. This is not background push: closed/disconnected tabs do not
  notify, reconnect does not replay alerts, and cancellations do not trigger them.
- Reloading/disconnecting keeps the child and generation alive. Pending extension
  dialogs cancel on detected disconnect. Standard select/confirm/input/editor
  dialogs work; terminal-only custom extension UIs do not (`/lsp status` works,
  bare `/lsp` does not). Cancellation cannot undo completed edits.
- Conversations are grouped by workspace in the left sidebar (a menu drawer on
  smaller screens). Use the **+** beside Workspaces to add a trusted project folder
  on the server machine; folders are remembered across launches. Selecting a workspace
  restores its selected conversation without automatically launching a stopped runtime.
  **New conversation** creates in the currently selected workspace. The compact
  composer grows with your message. Choose **System**, **Light**, or **Dark** in the
  sidebar; the preference is saved locally and System follows your OS setting.
- Use **New conversation** and the sidebar for up to **four active Pi
  runtimes across all workspaces**, with at most **16 workspaces** and
  **32 remembered conversations per workspace**. Each has independent
  drafts, transcript, activity, cancellation and dialogs. **Stop session…** closes
  only that child; **Reopen session** retains its app identity and starts a fresh epoch.
  Each sidebar conversation has a three-dot menu with **Rename…** and **Delete…**.
  Names are saved across restarts (up to 64 UTF-8 bytes). Renaming leaves the
  underlying Pi transcript unchanged.
  **Delete conversation…** in the top menu (or **Delete…** in the sidebar) confirms removal from Pi Web, stops
  its runtime, discards its page-local draft, and permanently deletes its saved Pi
  transcript. Project files are not deleted. This cannot be undone.
  Deleting a workspace's last conversation creates a blank stopped replacement;
  reopen it to start chatting. Failed cleanup or transcript deletion leaves the entry
  visible. If the transcript was deleted but saving the catalog fails, an explicit
  notice asks you to retry to finish removing the entry. If you restart before
  retrying and startup reports a missing remembered session, launch with `--new`
  and delete the old sidebar entry again.
  Unsent drafts live in this page, not persistent storage; reloading loses them.
- One controller owns each runtime. A second controlling tab is rejected for that
  session; Reattach retries after ownership is released. One authenticated WebSocket
  multiplexes bounded per-session streams fairly. Reconnect adopts fresh snapshots;
  delivery interrupted before acknowledgment is uncertain, not automatically retried.
- Conversations within a workspace share its project files. Different workspaces use
  separate project folders, but are **not security sandboxes or isolated worktrees**:
  coordinate concurrent edits. Split views are not supported.
  Existing project histories and legacy metadata are adopted in place.
- Recent display is bounded to 500 messages/8 MiB and 64 KiB per message, with
  explicit omission markers. Initially only 100 messages mount; reveal earlier
  **retained** messages locally. Tool calls and results are omitted from the web
  transcript, as are internal subagent completion notifications. Pi still receives
  those results, executes tools, and keeps its full session history.
- Large Pi files are resumed without fetching aggregate history over RPC. The
  read-only projection caps scan work at 128 MiB, decoded entries at 64 KiB,
  and retained decoded nodes at 16,384; dense/oversized records may yield a shorter
  window or an explicit history-only warning. Pi still owns full model context.
- The composer footer shows Pi's current context-window estimate beside **Saved by Pi**.
  It refreshes at startup, message completion, compaction and settings/session changes.
  **Context —** means unavailable (including immediately after compaction), not zero.
  This is context occupancy, not cumulative billed tokens or cache hit percentage.
- Pi Web defaults to `pi-bolt` (overridable with `--pi`) and uses its normal RPC
  session machinery. It sends prompt text without rebuilding history from the UI;
  metadata/context queries do not invoke the model. RPC alone should not reduce
  prompt caching, but cache reuse still depends on provider retention, session,
  model, instructions, tools, extensions and configuration matching the terminal.
- RPC records cap at 32 MiB; browser commands at 64 KiB, prompts at 32 KiB.
  Queues, dialogs, dedupe and message retention are bounded. Slow subscribers
  disconnect/resnapshot instead of silently dropping deltas.

**Trust:** this is a privileged local coding agent, not a sandbox. Pi tools run
with your OS permissions and can edit outside cwd. Do not expose the listener
through a proxy/tunnel. Host/Origin/capability checks, strict CSP and escaped
Markdown protect browser boundaries; they do not make transcript secrets public-safe.
Provider credentials stay with Pi. The browser capability is readable by this origin's
JavaScript, so trusted application assets and the strict CSP remain important. It is
never put in query strings or logs. Loopback HTTP does not provide transport secrecy.
Raw HTML, executable/file links and remote Markdown images are disabled. No automatic
extension approvals or installations.

## Development and verification

```sh
bun run types:generate   # Rust-owned ts-rs declarations
bun run types:check      # non-writing drift check
bun run typecheck
bun run test            # Rust all-targets + Vitest
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
bun run build
```

`bun run dev` serves frontend development assets only; production integration uses
`bun run build` plus the Rust server. Tool shebangs may invoke installed Node;
neither Node nor Bun serves the production application. ts-rs emits a benign
warning about `deny_unknown_fields`: Rust still enforces it; TS declarations are
not runtime validation.

- `apps/server/`: transport, runtime, history, metadata, security and generated types.
- `apps/web/`: Solid UI, runtime-validated wire messages, Markdown and tests.
- `fixtures/`, `scripts/`: shared fixtures and **opt-in** disposable native probes.
- [Phase 1 evidence](docs/phase-1-evidence.md), [plan](docs/phase-1-plan.md).
- [Phase 2 plan](docs/phase-2-plan.md), [verification](docs/phase-2-evidence.md).
- [Dependency security](docs/dependency-security.md): patched Vite/Vitest,
  narrow approved release-age exceptions and audit limitations.

Native tests are not CI-default. `cargo test --locked --test session_lifecycle
native_readiness_and_shutdown -- --ignored` launches isolated Pi without inference.
`cargo test --locked --test session_manager_native -- --ignored` checks two native
children, independent stop/reopen and cleanup without inference. After building the
server, `bun scripts/multiple-session-smoke.mjs --run --server /absolute/pi-web`
checks real HTTP/WebSocket routing with deterministic mock children.
The `scripts/m0-*.py --run` probes document additional prerequisites; provider
variants consume the configured Codex subscription and must remain intentional.
No commits or deployment are performed by the build/test commands.
