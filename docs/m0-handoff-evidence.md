# M0 history adoption and continuation experiment

This is feasibility evidence for the history design, not a production runtime or
proof of browser reconnect behavior. The application reducer and WebSocket
integration must still enforce and test the adoption rules.

## Native experiment

```sh
cargo build --locked -p pi-web --release --example history_probe
# Use target_directory from cargo metadata, not an assumed repository-local target/.
python3 scripts/m0-handoff-smoke.py --run --probe <target_directory>/release/examples/history_probe
# Separately opt into one configured Codex prompt:
python3 scripts/m0-handoff-smoke.py --run --provider --probe <target_directory>/release/examples/history_probe
```

Pi-Bolt 1.4.0 (Pi-Bolt 1.0.7), configured user extensions, MCP disabled, `read`
tool allowlist; macOS arm64. No global settings or credentials are changed.
The fixture is a temporary 33,655,472-byte v3 file: 600 active tiny messages and
an abandoned sibling containing a 32 MiB payload. Pi remains the only writer
after launch; `fixtures/pi/history-writer.ts` uses Pi's `appendEntry` and
`sendMessage` APIs. The fixture extension is explicitly loaded only for this test.

Observed:

1. A startup hook appends a non-visible custom control. The bounded checkpoint
   names the updated leaf; projection still yields exactly active IDs 100–599
   with an older-history marker and excludes the abandoned sibling.
2. After that projection has finished **but before adoption**, a fixture command
   appends `LATE_VISIBLE` without inference. Pi emits `message_end`, changes the
   authoritative leaf, and changes file mutation metadata. These are concrete
   invalidation signals; the stale result must be discarded, not installed.
3. Reprojection between matching checkpoints/file stamps contains the late
   message exactly once. This is a controlled idle resnapshot, not an atomic
   file lock or a guarantee against all extension behavior.
4. One authorized `openai-codex/gpt-6-astra` prompt on this large session settles
   normally with `LARGE_HISTORY_CONTINUED`, no tool calls and no extension errors.
   The recent projection contains both that user request and assistant answer,
   the late message exactly once, and the older-history indicator. Exit is 0.

The provider run preceded adding the explicit startup-hook control to the test
fixture. The final startup-hook version was rerun without inference and passed;
no second provider call was needed to test that added fixture behavior. Every
run used the configured user extensions and disposed of its test session/process.

## Invalid/incomplete file coverage

The Rust experiment now has 27 tests. Added cases verify that a partial trailing
append returns an error rather than partial history, completing the append yields
the correct branch, a not-yet-persisted authoritative leaf fails instead of
selecting the tail, and a synthetic over-budget scan stops after exactly 128 MiB
with one 64 KiB scan buffer. These are preservation/invalid-input tests, not newly
fixed bugs. Existing malformed/migration/metadata/retention tests remain passing.

M2 must keep history errors separate from RPC readiness, preserve live state,
and visibly retry or report unavailable older history. It must track runtime
identity/epoch and presentation revision across asynchronous projection work;
head/file agreement alone must never overwrite newer live messages.

## Standard dialogs

```sh
python3 scripts/m0-dialog-smoke.py --run
```

A harmless fixture with the real user-extension profile passes accepted and
cancelled `select`, `confirm`, `input`, and multiline `editor` responses. A held
input request is explicitly cancelled by ID without closing stdin; its command
finishes and the child remains ready. No provider requests, agent starts or
extension errors; child exits 0. The existing native extension smoke was rerun
with the harness's default cancellation behavior and also passed.

This verifies the primitive needed for immediate cancellation on controller loss.
There is no browser socket yet: actual disconnect detection/cancellation remains
an M3 integration requirement, not a completed feature.

## Production-bundle browser fixture

The built Solid fixture was served with Vite preview on `127.0.0.1:5198`. In a
task-owned Chrome tab, click and keyboard Enter each changed `starting` to
`ready`; reload reset it to `starting`. No JavaScript exception was observed.
The only console error was a confirmed missing `/favicon.ico` (404). The tab and
test server were closed, and the port was confirmed closed. This complements the
previous development-server browser smoke; it is not a chat/performance test.
