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
   A bare hostname is insufficient for a new tab. The password survives server restarts.
It is stored in `auth/capability.json` under the workspace registry, in a private 0700
directory with a 0600 file. By default this is
`~/Library/Application Support/pi-web/workspaces/auth/capability.json`; with
`--state-dir PATH`, it is `PATH/workspaces/auth/capability.json`. All workspaces in
that registry share the password. Invalid or insecure stored credentials fail startup.
To rotate it, stop pi-web, delete only that file, and restart; then use the newly
printed URL to sign in again. Treat backups of this file as passwords too.

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

## Install as a web app

Pi Web includes a web app manifest and home-screen icons. On **Firefox for Android**,
open your private HTTPS Pi Web address and choose **Install** (or **Add to Home screen**,
depending on the browser version) from the browser menu. Launch the new icon for a
standalone window. Chrome/Edge also offer installation; iPhone/iPad users can use
Safari’s **Share → Add to Home Screen**. Installation UI and support vary by browser
and OS; desktop Firefox does not offer the same manifest-based PWA installation.

An installed window may not share the original tab’s login. Use **Terminal login link**
to paste the complete current `https://…/#cap=…` link printed by the server. Only links
for the current origin are accepted, and only the credential is posted to `/auth`.
The link is cleared from the input immediately; login remains session-storage-only,
not a saved device credential. Paste the login link when a new window requests
authentication or after deliberately rotating the server password. Ordinary server
restarts retain the password. Choose **Update login link** to sign in again without
losing your drafts.
The manifest and launch URL never contain the secret.

This is an **online-only app**: the computer, Pi Web server, and private network must
remain available. Installation adds no offline cache, background execution, or automatic
notification permission. The existing phone-push worker remains opt-in. HTTPS is required
on phones; localhost/loopback is allowed for desktop development. Rebuild the web assets
and restart the server after upgrading so both the manifest MIME type and CSP are served.

## Local changes review

Open **Changes** beside **Conversation** to review the selected conversation’s
workspace, even when its Pi runtime is stopped. The workspace must be the root of
a Git working tree (including a Git-colocated jj repository).

- **Unstaged** compares tracked files with the index. Untracked filenames are listed,
  but their contents are not read. **Staged** compares the index with HEAD.
- **Branch** lists up to 100 local and locally stored remote-tracking branches on
  demand; search to narrow the list and choose a base to compare immediately.
  **Compare** reruns the selected comparison. The comparison is merge-base → committed HEAD: changes since
  the branches diverged, not a tip-to-tip comparison. **Reload branches** only rereads
  local refs; remote-tracking refs may be stale. It excludes staged/unstaged edits.
  GitHub URLs, fetching, staging, committing, and publishing are not supported.
- **Commit** shows one local commit against its first parent, or an empty tree for
  a root commit. The picker loads up to 100 recent commits reachable from local
  HEAD on demand, including merged history; it does not stop at `main` or `master`.
  Search the loaded list by message or hash. **Reload commits** updates the list;
  searching and reloading keep the selected full commit ID pinned, even if HEAD moves. Staged/unstaged
  edits are excluded. Missing parent objects in shallow repositories produce an
  error rather than a misleading root diff. History is read-only and bounded to
  256 KiB per response with a ten-second request deadline.
- The review summary shows total lines changed (added + deleted) for the selected
  scope, independently of metadata pagination or patch-size limits. Binary and
  untracked files are counted separately as having no line counts. Totals use a
  bounded Git statistics read, not downloaded patches; if that read exceeds its
  output budget, totals are shown as unavailable. Refresh after edits; working-tree
  statistics and file lists are best-effort snapshots, not atomic captures.
- Filter files by path and read unified diffs with old/new line numbers and change
  counts. **Next unreviewed** moves through remaining files. **Reviewed** marks are
  local to this conversation and page. Refresh revalidates marks as each file loads;
  only identical content stays reviewed. Reloading clears them. The file list loads
  automatically in pages of up to 100 entries, supporting 1,000-file reviews (the
  browser admits at most 10,000 files). Changed listings invalidate continuation
  tokens: refresh rather than mixing pages from different listings. Patches load
  only when selected, with a 1 MiB per-conversation memory cache
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
  and the same highlighting limits. They do not change Reviewed marks or whole-file
  references sent to your draft. Expansion is on demand and checks the original file fingerprint;
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
- **Overview** and **Files** are two views inside Changes; Files remains the default.
  Overview reuses AI group titles/reasons as suggested purpose and behavior explanations,
  with exact file links and a suggested review order. **Review [purpose]** opens the
  first unreviewed file in that group, focuses the file picker on that group, and makes
  **Next unreviewed** follow the same file order within it. Use **Review group** to
  switch groups or **Show all files** to return to the complete list. Regrouping
  falls back to all files if the focused group's membership changes.
  Filename-based risk prompts and changed test files are navigation aids, not a security
  assessment or proof of coverage. Test execution results are not available here.
  Opening Overview never calls a model, changes the draft, or marks files reviewed.
- **Explain this group** explicitly requests one isolated AI explanation using the AI review
  model selected in Settings. Observations, inferred intent, and possible risks link to
  validated, supplied diff rows; these links establish evidence membership, not correctness.
  No test execution or coverage analysis is added. Explanations include up to eight eligible
  files, each limited to 6 KiB / 120 complete diff rows, and disclose omitted context.
  The configured per-run request-data limit also caps each explanation; each click is a
  separate run, not part of a shared spending allowance. Up to four exact evidence/model-keyed
  results are cached in memory. Refresh hides old explanations; reopening unchanged evidence
  can reuse the cache. Citation navigation rejects changed fingerprints rather than jumping
  to unrelated code. Captures remain best-effort, not atomic.
- **Needs review only** filters out verified, unchanged review marks. Marking a file Reviewed
  keeps a bounded in-memory baseline (up to 64 patches / 1 MiB). Later edits lose the mark
  and show new or modified rows, with replaced or removed baseline rows available separately.
  Matching leading and trailing rows are excluded; the middle is conservatively highlighted,
  not a semantic diff. Missing or evicted baselines are disclosed. Scope changes reset marks;
  reload discards them. After refresh, unloaded files remain pending until their patch
  fingerprint is checked—even if the whole-snapshot identity repeats, because metadata
  and patch captures are not atomic.
- Selected diff lines offer **Explain this**, **What could break?**, **Check edge cases**,
  and **Compare with existing code**. Each action opens a focused question dialog with a local code preview.
  Nothing is sent until you explicitly choose **Send to Pi**.
- **Ask Pi** remains available on individual files and selected lines; the top-level
  Ask dropdown is removed. It sends the user’s request and file/line references
  without adding review-only or read-only instructions.
  It never auto-attaches review skills; an explicitly chosen focused question still
  asks that question. Pending chat quotes and existing leading slash commands stay
  intact. Pi can make changes when requested, subject to its normal permissions.
  Quotes, context and commands count toward the 32 KiB message limit.
- **Group with AI** is optional; folder grouping remains the default. Clicking it
  sends the displayed file names and bounded diff snippets to the conversation’s
  current Pi provider/model by default. Open **Settings → AI review** from the
  Settings button at the bottom of the sidebar to choose a separate grouping model and run limits without
  changing chat. AI review preferences are shared across this server’s workspaces,
  conversations, and devices, and saved in the private registry’s `grouping-settings.json`.
  Updates apply immediately to connected clients and new runs without a restart;
  active runs keep their starting settings. Concurrent edits use last-write-wins.
  **Settings → Appearance** saves your color scheme in this browser. Provider charges may apply. It uses a separate,
  ephemeral session with tools, extensions and MCP disabled; it does not send a
  message in your conversation or change its draft. The conversation must be open
  and idle with an available model; extension-only or project-only model configurations
  may be unavailable in this isolated analysis session. It uses your global Pi provider
  credentials/settings, but explicitly overrides system-prompt additions. This is not
  an OS sandbox.
  Grouping starts from a whole-change manifest, using already-cached diff summaries
  where available. Uncached patches load only when the model requests an excerpt;
  their line counts are unknown until captured. Each inference admits up to 1,000
  manifest entries and 192 KiB of JSON, with at most 2 KiB of overview per entry /
  24 KiB total. Larger manifests are partitioned by size, then their compact group
  summaries are reconciled globally so related changes can span partitions. Summary
  reconciliation is lossy: it merges earlier groups rather than rereading every file.
  Each inference unit allows up to eight requested diff excerpts (four per round,
  8 KiB / 120 lines each), using at most three model calls. Larger changes can require
  additional summarization and reconciliation calls, increasing runtime and provider
  charges. A whole run defaults to **6 calls and 512 KiB of serialized request data**,
  counting repeated context. Settings permit up to 100 calls / 16 MiB explicitly.
  These are work limits, not a dollar cap: output tokens, provider/system prompts and
  pricing differ. Reconciliation also stops after five levels. Reaching any limit
  leaves folders available; only a complete final grouping is published.
  Model prompts use short file IDs to avoid repeating long paths in responses.
  Usage shows calls/request bytes and reported input/output/cache tokens and cost;
  missing provider usage or prices are shown as unavailable, not free.
  Requests contain at most 48 KiB of diff text; earlier excerpts are resent in later
  rounds. There is no shell or repository browsing, and content omitted by review
  limits remains unavailable. Working-tree captures are best-effort, not atomic.
  The grouping status summarizes the evidence used. Metadata-only grouping does not
  mean the model read those files. Suggestions
  are not a verified assessment and never mark files reviewed: unknown or duplicate
  paths reject the result, omitted files remain under **Ungrouped**, and errors leave
  folders available. Switch between **Folders** and **By purpose** without another
  model request. Per-group counts and **Next unreviewed** follow the chosen grouping.
  Completed suggestions are reused for the same content, scope, model and grouping
  policy. The bounded tab-local session cache keeps up to four results / 256 KiB,
  containing group text and paths, never patches or credentials. A bounded SHA-256
  content identity includes tracked binary changes; when an identity cannot be
  computed, reuse is disabled. Identity is rechecked before and after AI runs;
  mutable working-tree capture remains best-effort, not atomic.
  Refresh keeps exact matches; changed content keeps clearly stale groups for
  navigation and puts new files under Ungrouped. **Update groups with AI** is manual;
  edits never trigger paid requests. **Regenerate (ignore saved result)** forces
  fresh analysis. Filename-only reuse is deliberately avoided.
  Lockfiles, minified assets, source maps and dist/build/coverage files keep their
  names in the manifest but omit contents by default. **Include generated / lockfile
  contents** opts back in. Frequently edited source files are not automatically
  suppressed: frequency alone does not make a change unimportant.
  The server admits one inference at a time with a 60-second deadline plus supervised
  cleanup; the browser limits each inference unit, including its requested captures, to 90 seconds. Cancel
  stops further captures and inference calls; failed/cancelled runs leave folders available.
- **Ask Pi** appends the selected file’s path, changed-line ranges and scope to your existing draft and
  returns to Conversation. It never sends automatically. Oversized context is
  rejected without changing the draft; reopen stopped conversations before sending.
  In Text mode, drag across line numbers to select a range, or select a line then
  Shift-click another. **Choose end line** lets touch and keyboard users choose
  the end of a range. A floating **Ask Pi** action appears beside the range endpoint
  when selection finishes; × or Escape dismisses it without clearing the range.
  It and **Ask Pi about selection** open a focused question dialog with a preview
  of those source rows and their old/new line numbers. Write a question or choose
  a suggestion, then explicitly **Send to Pi** to open the answer in Conversation.
  Only the question, filename, old/new line references and comparison metadata are sent; existing chat drafts, quotes,
  and attachments stay untouched. Failed or uncertain delivery preserves the
  question in the draft for manual recovery. Selection clears when the file, scope,
  snapshot, expanded context or diff mode changes; code text remains selectable for copying.
  Review questions render in chat with expandable, syntax-highlighted diff cards.
  Captured code is browser-only and is never added to the generated prompt; Pi reads
  the files or scoped diffs itself. References can become stale after edits.
  All-changes cards list the files; uncaptured files offer **Load current diff**,
  explicitly labeled as current rather than the original snapshot. Preview reads
  do not send messages to Pi. Up to 16 cards / 1 MiB per conversation survive reload
  in this tab’s session storage. Other tabs, expired previews and edited references
  fall back to the plain references; no code snapshots are stored in Pi’s history.
- Snapshots are best-effort, not live or atomic: refresh after edits, and coordinate
  concurrent agents. Limits are 100 listed files per page, 64 KiB per selected patch, 1 MiB per JSON response,
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
  composer grows with your message. Select text within a chat message and choose
  **Reply** to attach it as a compact quote above your draft. Long previews are
  truncated to two lines; sending includes the full selection without an author heading.
  **Remove quote** keeps your typed message. Nothing sends until you choose **Send**.
  Quotes stay with their conversation's draft and count toward its message-size limit.
  Type **@** to search the current workspace's
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
Raw HTML in ordinary Markdown, executable/file links and remote Markdown images are disabled.
No automatic extension approvals or installations.

### HTML visual previews

Ask Pi for a visual diagram or styled comparison. Pi Web explicitly supplies the
bundled [`pi-web-visuals` skill](apps/server/pi/skills/pi-web-visuals/SKILL.md) to each
newly launched main Pi process, independently of the conversation's project folder.
Only a short routing hint is appended to the system prompt; Pi advertises the skill's
name, description, and path, and the agent reads its full guidance when creating a
visual. Skill selection is model-driven rather than a guaranteed application hook.
No global skill installation is needed. The explicit bundled skill also remains
available in `--isolated` mode, which disables discovery of other skills.

The skill documents an explicit, top-level `html preview` fence:

````markdown
```html preview
<style>.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
.card { background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }</style>
<div class="cards"><section class="card"><h2>Before</h2><p>Repeated work</p></section>
<section class="card"><h2>After</h2><p>One clear step</p></section></div>
```
````

Completed, untruncated assistant replies render these blocks as interactive HTML/CSS/inline
SVG previews inline in the message (including bounded embedded PNG/JPEG images), with **Preview**,
**Source**, **Collapse**/**Show**, and **Expand** controls in a compact overlay (shown on
hover or keyboard focus, always available on touch). Inline previews fit their content
between 80 and 20000 CSS pixels; taller visuals scroll inside the viewer. Full-screen
previews fill the dialog. Off-screen placeholders retain the last measured height. Collapse releases the viewer;
Preview or Source reopens the inline content. Full-screen access preserves the inline collapsed state. Streaming, user
messages, unclosed/nested fences and ordinary `html` fences remain escaped text/code.
The existing 64 KiB message limit applies; large visuals should be simplified.
Keep markup compact, reuse CSS classes, and prefer HTML/SVG over base64 images.
Detailed composition, palette and image guidance is optional and loaded only when needed.
Viewers run near the viewport or in full-screen, with one shared theme observer.
Off-screen viewers are released and reconstructed on return, resetting their internal
scroll position, control values, script state and open `<details>` state; Source/Preview selection is preserved.

Previews follow Pi Web's resolved light/dark theme, including live changes and
full-screen views. Use inherited CSS variables (`--background`, `--foreground`,
`--card`, `--card-foreground`, `--muted`, `--muted-foreground`, `--border`,
`--primary`, `--primary-foreground`, `--accent`, `--accent-foreground`,
`--secondary`, `--secondary-foreground`) instead of fixed surface/text colors.
The root `.dark` class and `color-scheme` are synchronized too. Explicit colors in
older artifacts are preserved rather than automatically inverted.

Each preview uses an opaque-origin sandbox (never `allow-same-origin`) and a
separate CSP. Classic inline scripts run after the initial theme is applied; use
`addEventListener`, since `on*` attributes are removed. Canvas, buttons, inputs,
select/option, labels, textareas and outputs are supported with safe attributes
and `data-*`. Scripts run once per viewer document, not on theme changes. Listen
for `window`'s `pi-web-theme-change` event to redraw canvas using computed tokens.

Built-in outline icons need no imports: `<span data-icon="check"> Verified</span>`.
Use purposeful icons paired with labels rather than clutter. Supported names are
`arrow-right`, `arrow-left`, `check`, `x`, `info`, `warning`, `code`, `search`,
`settings`, `file`, `folder`, `clock`, `plus`, and `minus`. Only span markers expand,
on initial render before artifact scripts run (no mutation observer); unknown
names leave content unchanged. The original 24×24 SVGs inherit text color and
font size (`currentColor`, `1em`) and are decorative (`aria-hidden="true"`).
Wrapper text, classes, styles and `aria-label` are preserved; use visible labels
or `role="img"` with an `aria-label` on an icon-only wrapper.

For bundled Chart.js 4.6.1, request its explicit marker; the library is loaded
lazily as text and executes only inside the frame, before artifact scripts:

````markdown
```html preview
<script data-library="chart.js"></script>
<canvas id="chart"></canvas>
<script>
const chart = new Chart(document.querySelector('#chart'), {
  type: 'bar', data: { labels: ['Before', 'After'], datasets: [{ label: 'Steps', data: [8, 3] }] }
});
window.addEventListener('pi-web-theme-change', () => chart.update());
</script>
```
````

Remote scripts, modules, eval, connections, nested frames, form submission,
popups and top navigation are blocked. Supplied markup retains static sanitation
and bounded embedded-image protections; inline handlers and URL attributes are
removed. External fonts/styles/images are unsupported. This is not an absolute
no-network guarantee: scripts can navigate their own frame. There is no CPU quota;
untrusted scripts can stall the browser. The parent accepts no artifact commands
and sends content only once to the initial viewer document. No capability is sent
to the frame. The main application's CSP stays restrictive. The data-free
`/artifact-preview` document stores no artifacts; visuals are reconstructed from
retained message text.

For a small embedded image, use `<img src="data:image/png;base64,..."
alt="Description">` (or `image/jpeg`) inside the HTML preview. Model-generated bytes
receive the same checks as any other source; this does not generate images,
automatically import attachments, or resolve file paths/URLs. The sanitizer checks
canonical base64, PNG/JPEG container headers and dimensions before the browser's
final raster decoding. It excludes SVG data images, other formats, animated PNG,
remote URLs and `srcset`. Ordinary Markdown images remain disabled.

Per preview, the image budget is eight images, 32 KiB of decoded image bytes and
2,097,152 pixels total. Each image is limited to 32 KiB, 2048 pixels per edge and
1,048,576 pixels. Invalid or over-budget images are omitted. Base64 overhead counts
toward the existing 64 KiB message limit, so full-size generated artwork usually
will not fit. The fixed receiver converts accepted bytes into local blob URLs
inside the sandbox; its image CSP permits only blobs, not network or CSS data
images. Object URLs live for that viewer document and are released when it unloads.
Image colors are preserved; the theme does not automatically recolor raster content.

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
