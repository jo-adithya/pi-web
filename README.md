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

## Phone access with Tailscale Serve

Remote access is opt-in. The listener stays on `127.0.0.1`; `--remote-origin`
selects **one HTTPS browser origin instead of the local HTTP origin**. Both your
phone and desktop should use that HTTPS URL in this mode. No dependencies or
Tailscale settings are installed or changed by pi-web.

1. Install Tailscale on the computer and phone, sign into your private tailnet,
   and connect both devices. Restrict tailnet access to this computer's HTTPS port
   to your trusted devices/users. Enable MagicDNS and HTTPS certificates as directed
   by Tailscale. Certificate hostnames are published in certificate transparency logs.
2. On the computer, check `tailscale serve status` first to avoid replacing an
   existing service. In a separate terminal, start a private HTTPS proxy:
   ```sh
   tailscale serve --https=443 http://127.0.0.1:9876
   ```
   Keep it running. Follow Tailscale's enablement prompt if needed. Note the
   `https://YOUR-COMPUTER.YOUR-TAILNET.ts.net` address it prints.
   **Use Serve, never Funnel:** Funnel exposes the service to the public internet.
3. Build and launch pi-web using that exact hostname (lowercase, no trailing slash,
   path, query, fragment or explicit port; this mode uses HTTPS port 443):
   ```sh
   bun run build
   cargo run --locked -p pi-web -- --cwd /absolute/path/to/project \
     --remote-origin https://YOUR-COMPUTER.YOUR-TAILNET.ts.net
   ```
   Replace the uppercase placeholder with your actual lowercase Tailscale hostname.
4. Privately transfer the **complete URL printed by pi-web**, including `/#cap=…`,
   to your phone and open it in the browser. The capability is a password granting
   access to your coding agent: do not share it or paste it into logs or screenshots.
   A bare hostname is insufficient for a new tab. Restarting pi-web rotates the secret.

The proxy preserves Host and Origin; pi-web checks both against the configured
origin and still requires the capability for authentication and WebSockets.
Forwarded headers and Tailscale identity headers do not grant access. TLS ends at
Tailscale Serve; the backend connection remains local HTTP. The flag does not verify
that a proxy is private: **you must keep Serve tailnet-only and restrict access**.
Do not use a public proxy, port forwarding, or a shared/untrusted tailnet.

Keep the computer awake and both processes running. Desktop and phone can keep the
same conversation open: both receive live updates and either can send while idle.
Phones can suspend background tabs: reconnect to see updates; this is
not background push. If you see 403 responses, check the exact hostname and flag;
do not disable origin checks. To return to local-only use, stop the foreground
Serve process with Ctrl-C and restart pi-web without `--remote-origin`.

See [Tailscale Serve documentation](https://tailscale.com/kb/1242/tailscale-serve).
Actual phone connectivity requires a configured tailnet and is separate from the
application's automated proxy-boundary tests.

## Local changes review

Open **Changes** beside **Conversation** to review the selected conversation’s
workspace, even when its Pi runtime is stopped. The workspace must be the root of
a Git working tree (including a Git-colocated jj repository).

- **Unstaged** compares tracked files with the index. Untracked filenames are listed,
  but their contents are not read. **Staged** compares the index with HEAD.
- **Branch** accepts an existing local branch, tag, or full ref and compares its
  merge-base with committed HEAD. It excludes staged/unstaged edits. GitHub URLs,
  fetching, staging, committing, and publishing are not supported.
- **Commit** shows one local commit against its first parent, or an empty tree for
  a root commit. The picker loads up to 100 recent commits reachable from local
  HEAD on demand, including merged history. **Reload commits** updates the list;
  the selected full commit ID stays pinned, even if HEAD moves. Staged/unstaged
  edits are excluded. Missing parent objects in shallow repositories produce an
  error rather than a misleading root diff. History is read-only and bounded to
  256 KiB per response with a ten-second request deadline.
- Filter files by path and read unified diffs with old/new line numbers and change
  counts. **Next unreviewed** moves through remaining files. **Reviewed** marks are
  local to this conversation and page. Refresh revalidates marks as each file loads;
  only identical content stays reviewed. Reloading clears them. The file list loads
  first; patches load only when selected, with a 1 MiB per-conversation memory cache
  cleared by Refresh. Ask Pi, Reviewed, and Structural wait for that file’s patch. Long lines wrap in both text and structural diffs,
  keeping source whitespace and line numbers. Diffs scroll with the page; the files sidebar scrolls
  independently. Top controls scroll away; file headers stay sticky. On narrow
  screens, **Files** opens the scrollable file picker; choosing a file returns to its diff. File jumps respect reduced-motion settings.
  Large diffs use **Previous rows / Next rows** pages of at most 500 rows instead
  of mounting the entire file. Structural pages also bound segment rendering;
  lines with more than 256 syntax segments retain their text without emphasis.
- Syntax colors use Catppuccin Latte in light mode and Mocha in dark mode, shared
  with conversation code blocks. Diff addition/removal backgrounds stay unchanged.
- Small patches (up to 16 KiB and 400 lines) get syntax highlighting for JS/TS/JSX/TSX,
  Rust, Python, JSON, shell, CSS, HTML/XML/SVG, and YAML. Larger or unknown-language
  patches stay plain. Colors use each hunk’s available context, not the entire file.
- In **Text** mode, **Expand above / below** reveals up to 20 unchanged lines per
  click before, between, or after hunks. Expanded lines retain numbering, wrapping,
  and the same highlighting limits. They do not change Reviewed marks or the patch
  sent to your draft. Expansion is on demand and checks the original file fingerprint;
  if the file changed, refresh first. Refresh or selecting another file clears it.
  Verified expanded diffs are cached in server memory (up to 4 entries / 4 MiB).
  Every hit still checks fresh membership and the original/final file fingerprints;
  it skips the expanded Git diff, not the safety checks.
  Context requests have a five-second server deadline, a 1 MiB full-diff scan limit,
  and a 64 KiB response limit; the browser retains at most 256 KiB of extra context
  for the selected file. Unsupported or oversized files keep their original diff.
- **Structural** optionally compares syntax for the selected file using locally installed
  **Difftastic 0.72.0** (`difft` on the server’s PATH). Text is the default and remains
  visible during comparison or fallback. Changed syntax is emphasized; switch back to
  **Text** to inspect formatting and metadata too. This is syntax-aware matching, not
  a proof that behavior is equivalent. No installation or model call happens automatically.
  Only this Difftastic version is accepted because its JSON interface is unstable.
  Comparisons run one at a time, separately from text review, with a five-second process
  budget, a 128 KiB limit per input, and a 1 MiB output limit. This assumes responsive
  local storage: stalled filesystem calls and child cleanup can exceed the time budget.
  Up to 16 results / 4 MiB are cached in server memory after validating current
  content. Deterministic unsupported-language/parser fallbacks are cached too;
  timeouts and transient engine failures are not. Cache hits avoid comparison-input
  writes for staged/branch/commit review; unstaged review still captures and verifies new
  content before lookup. Refresh or changing the selected file cancels pending work. A changed source
  snapshot requires refreshing Changes. Added/deleted files, untracked files, symlinks,
  binary content, and unsupported languages stay in text mode with an explanation;
  missing or incompatible engines also fall back to text.
- **Group with AI** is optional; folder grouping remains the default. Clicking it
  sends the displayed file names and bounded diff snippets to the conversation’s
  current Pi provider/model. Provider charges may apply. It uses a separate,
  ephemeral session with tools, extensions and MCP disabled; it does not send a
  message in your conversation or change its draft. The conversation must be open
  and idle with an available model; extension-only or project-only model configurations
  may be unavailable in this isolated analysis session. It uses your global Pi provider
  credentials/settings, but explicitly overrides system-prompt additions. This is not
  an OS sandbox.
  At most 20 patches are fetched on demand, clipped to 8 KiB each / 48 KiB total;
  other files supply names only. Partial coverage is shown. Suggestions are not a
  verified assessment: unknown or duplicate paths reject the result, omitted files
  remain under **Ungrouped**, and errors leave folders available. Switch between
  **Folders** and **AI intent** without another model request. Refresh/scope changes
  discard suggestions; results stay in page memory only. The server admits one
  grouping job at a time with a 60-second analysis deadline plus supervised cleanup.
- **Ask Pi** appends the selected file’s patch and scope to your existing draft and
  returns to Conversation. It never sends automatically. Oversized context is
  rejected without changing the draft; reopen stopped conversations before sending.
- Snapshots are best-effort, not live or atomic: refresh after edits, and coordinate
  concurrent agents. Limits are 100 listed files, 64 KiB per selected patch, 1 MiB per JSON response,
  and a ten-second deadline per list or patch request. Omitted content is explicitly marked; binary diffs show
  Git’s summary rather than file contents. Git must be installed locally and
  support `--no-lazy-fetch`; older versions fail closed. Repositories with configured
  Git filters (including Git LFS) are rejected so review cannot execute filter helpers.

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
  dialogs cancel when the last connected client disconnects. Standard select/confirm/input/editor
  dialogs work; terminal-only custom extension UIs do not (`/lsp status` works,
  bare `/lsp` does not). Cancellation cannot undo completed edits.
- Conversations are grouped by workspace in the left sidebar (a menu drawer on
  smaller screens). Use the **+** beside Workspaces to add a trusted project folder
  on the server machine; folders are remembered across launches. Selecting a workspace
  restores its selected conversation without automatically launching a stopped runtime.
  Each workspace has a three-dot menu with **Delete workspace…**. After confirmation,
  deletion stops its runtimes and removes the workspace and its conversations from
  the sidebar. Project files and saved history are retained; page-local drafts are
  discarded. At least one workspace must remain, so add another before deleting
  your last workspace. Failed cleanup or saving leaves the workspace visible.
  **New conversation** creates in the currently selected workspace. The compact
  composer grows with your message. Type **@** to search the current workspace's
  files, then use arrow keys and **Tab**/**Enter** or tap a result to insert its
  relative path; **Escape** dismisses suggestions. Paths with spaces are quoted.
  The picker inserts references, not file contents. Search skips hidden files,
  symlinks and common dependency/build folders; limited results ask you to narrow
  the query. Choose **System**, **Light**, or **Dark** in the
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
- Up to eight authenticated tabs/devices can share a conversation. The backend accepts
  the first prompt while idle and rejects competing prompts as busy; rejected drafts
  stay on the sending device. Either device can stop a run, and the first valid
  dialog answer wins. Drafts and command results remain local to the sending tab.
  Disconnecting one device leaves the others connected. Each authenticated WebSocket
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
- The composer footer also shows **Codex subscription usage** (percent used per provider
  window) beside context and LSP status. It refreshes only when opening the selected
  conversation, returning the page to visible, or tapping the usage text—never on a
  polling timer. Reset timestamps are reported estimates, not proof that a limit reset.
  Same-conversation desktop/phone clients share one runtime-owned cache: overlapping
  requests coalesce, and successful readings suppress bursts for three seconds (including
  taps). Caches are **not shared across conversations/accounts**. Failed refreshes retain
  the last reading marked stale; model/epoch changes and account changes detected during
  refresh clear it. If authentication cannot establish account identity, old usage is cleared.
  Non-Codex, non-subscription OAuth, isolated runtimes, and missing/unverified adapters
  show unavailable. Credentials and account identifiers never reach the browser.
  `--quota-adapter PATH` selects the explicit local extension (default
  `apps/server/pi/codex-usage.ts`); its canonical registration is verified before invoking
  the hidden private command. This adapter targets installed **Pi-Bolt 1.4.0** and its
  **undocumented** `https://chatgpt.com/backend-api/wham/usage` endpoint, which can change.
  Custom destinations and redirects are rejected; Pi owns OAuth refresh. Responses are
  limited to 64 KiB and the adapter operation to ten seconds. The safe opt-in
  `python3 scripts/codex-usage-smoke.py --run` checks native registration/handled replies
  and unchanged history using an offline non-Codex model, without provider requests.
- The composer footer retains Pi's current context-window estimate beside quota and LSP status.
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
with your OS permissions and can edit outside cwd. Keep the default listener local,
or explicitly configure the private HTTPS setup above. Never expose it publicly.
Host/Origin/capability checks, strict CSP and escaped
Markdown protect browser boundaries; they do not make transcript secrets public-safe.
Provider credentials stay with Pi. The browser capability is readable by this origin's
JavaScript, so trusted application assets and the strict CSP remain important. It is
never put in query strings or logs. Loopback HTTP does not provide transport secrecy.
Raw HTML, executable/file links and remote Markdown images are disabled. No automatic
extension approvals or installations.

## Optional phone push

In Session options, choose **Enable phone push**, grant browser permission, then
**Test phone push**. Initial support is Brave/Chromium on Android over HTTPS.
This is separate from the existing desktop notification toggle; merely opening
Pi Web never registers a worker or subscribes. Phone push covers successful/error
main-run completions across **all folders and conversations managed by this server**,
not just the selected conversation; aborted runs are suppressed. Disable affects
only this browser device. Renew before the 30-day expiry by enabling again.

The Rust server sends encrypted Web Push through Google's FCM infrastructure;
it needs outbound HTTPS, and the phone needs browser-provider connectivity.
Tailscale is needed to open the private page, not to receive a push. Clicking opens
`/` or focuses an existing same-origin tab; a fresh tab may need the current login
link. Payloads contain only a generic completion message, never conversation text,
workspace names, paths, or login capabilities. The root worker has no offline cache.
Actual Brave locked-phone delivery has **not** been verified on a real device.

A stable VAPID key and up to 16 origin-bound subscriptions are stored privately
under the registry's `push/` directory (0700 directory, 0600 atomic records). Browser
management secrets use a separate localStorage key. Setup, renewal, removal and
testing require the current capability plus exact Host/Origin. Login capability
rotation/restarts **do not revoke subscriptions**. If browser storage is lost, or
to revoke every device, stop the server and run the same binary with the same
`--cwd`/`--state-dir` selection plus `--revoke-push`; it clears subscriptions and
exits without starting a listener. Re-enable devices explicitly afterward. An
already accepted provider notification can still arrive after revocation.

Delivery is best effort: a bounded 32-completion queue, 30-second queue age limit,
8-second delivery-batch deadline, 5-minute provider TTL, no retries; overloaded or
slow deliveries can be dropped. Management is prioritized between batches. Test
requests are limited to one per minute per server. HTTP bodies are limited to 4 KiB
and two seconds; errors/timeouts may require retrying device removal. HTTP 404/410
subscriptions are removed. Only stable `fcm.googleapis.com/fcm/send/` and `/wp/`
endpoints are accepted; staging, arbitrary URLs, redirects and proxy settings are
excluded. Encryption/signing uses `web-push`; HTTPS uses a timeout-bound `reqwest`
client with redirects disabled. Provider failures never fail a session.

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

For opt-in Tailscale hot reload, see [development setup](docs/development.md).

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

### Background agents and workflows

The compact disclosure above the composer shows background `Agent` and
`SubagentWorkflow` tasks observed by the current runtime, even after the main
response becomes idle. Agent tasks use the structured `status: background` tool
result and `subagents:record` terminal entries from **opensec-pi-subagents 0.20.0**.
Workflows use the structured launch task ID and the completion notification's
structured details; raw tool text and notification content are not displayed.
Workflow entries show their run ID, terminal status, and result preview. Names
arrive with completion notifications, which may be delayed until the current turn
ends. The runtime provides no live workflow phases or child-agent progress over
RPC. Workflow results are previews (up to 500 characters plus an ellipsis at the
producer), not full outputs.
“Queued / running” is deliberately combined: this contract provides no precise
queue position or progress. Expand a task for its escaped, bounded result (8 KiB)
and error (1 KiB); shortened results are marked. At most 32 tasks are retained,
with 64 pending invocations and 64 terminal records for launch/completion races.

Reconnect replays this runtime cache. Process loss marks active tasks unknown;
restart clears the cache. If the extension stops a queued task without emitting a
terminal record, the panel retains its last observed active status; it is not a live
scheduler query. History recovery, task controls, and cross-process recovery are
not supported. Workflow resumes appear as separate runs with new IDs.
Agent resume correlation uses ordered tool
starts and producer timestamps; equal-millisecond terminal records from separate
invocations are ambiguous and are conservatively ignored rather than completing
the newer invocation. Raw tool arguments, tool outputs, and custom notification
messages remain excluded from the transcript; only the dedicated bounded task
projection is exposed.
