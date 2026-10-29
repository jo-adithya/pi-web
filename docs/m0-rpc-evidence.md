# M0 real-Pi RPC evidence

## Scope

User-authorized subscription smoke, using the configured
`openai-codex/gpt-6-astra` model at `high` thinking. No API key was supplied or
printed. This is a real provider test, not a mock. Two runs each submitted
three prompts (one deliberately aborted); subscription quota was consumed.
No billing amount is inferred from Pi's model pricing metadata.

- Binary: installed `pi-bolt` 1.4.0 / Pi-Bolt 1.0.7, macOS arm64.
- Temporary cwd, one harmless `fixture.txt`, and an explicit temporary session
  file; removed on completion.
- Global extension discovery enabled. Project context, skills, prompt templates,
  startup network operations and MCP connections disabled for isolation.
- Model tool allowlist: `read` only. This is an allowlist, not OS confinement.
- No settings or credentials were deliberately changed. Extensions execute with
  the user's privileges and may maintain their own caches.

## Reproduce (explicit opt-in)

```sh
python3 scripts/m0-rpc-smoke.py --run
```

Without `--run`, the script exits before launching Pi. It uses the configured
model and rejects a non-Codex provider before submitting prompts. It loads the
installed global extensions, cancels any blocking standard dialog rather than
approving it, and limits this probe to three prompt submissions.

The harness uses LF-only byte framing, a 4 MiB record buffer, a 16 MiB total
stdout budget, a 10,000-record cap, and a 64 KiB stderr tail. These are probe
limits, not the planned production transport implementation. Raw stderr and
message content are not printed. Errors and command names may still contain
extension-supplied text; inspect output before sharing it.

## Observed result

`python3 scripts/m0-rpc-smoke.py --run` passed:

| Check | Observation |
|---|---|
| Correlated readiness | 0.732 seconds; expected provider/model selected |
| Prompt acceptance | `success: true`, `disposition: started` |
| Tool round trip | One successful `read`; fixture marker appeared in final answer |
| Streaming/finalization | 26 `message_update` records; assistant stops `toolUse`, then `stop` |
| Completion | `agent_end`, then `agent_settled` with `aborted: false`; 9.337 seconds |
| Active cancellation | Waited for a text delta, confirmed `isStreaming: true`, queued a follow-up, cleared it, then sent `abort` |
| Abort confirmation | Successful abort response plus `agent_settled.aborted: true`; approximately 2 ms after sending abort |
| Queue state | Returned queued text; afterward `pendingMessageCount: 0`, `isStreaming: false` |
| Recovery | Next prompt returned the expected marker and settled normally |
| Persistence/resume | Closed first process; reopened the exact session path; same session ID and recovery answer present; 9 messages |
| Cleanup | Both child exits were 0; stdin EOF used, process-group cleanup attempted; temporary directory removed |
| Total | 15.210 seconds including restart |

The initial exploratory run independently passed prompt/tool/abort/recovery in
8.129 seconds but did not test restart. These single-machine timings are not
performance guarantees. The `read` tool emitted no partial-result update;
streaming tool preview semantics were **not** verified by this test.

## Extension profile observations

The following commands were discoverable: `streaming`, `fast`, `notify`,
`cc-safety-net`, `lsp`, `acp`, `acp-cache`, `acp-rule`, `acp-fleet`, `websearch`,
`curator`, `google-account`, `search`, `agents`, `todos`, `fff-mode`,
`fff-health`, `fff-rescan`, `llama`, and `usage`.

No `extension_error` event was seen in these flows. A startup warning reports
that `pi-lsp-adapter` declares `@earendil-works/pi-tui` and `typebox` as dependencies
rather than host-provided `peerDependencies: "*"`, risking duplicate runtime
modules. This warning is not evidence of a failed read or provider request;
the installed package was not modified.

Discovery does not establish that each command/tool works through RPC. MCP was
not connected and no standard dialog was requested by the tested read flow.

### Separate no-model extension probe

```sh
python3 scripts/m0-extension-smoke.py --run \
  --demo /path/to/pi-bolt/examples/extensions/rpc-demo.ts
```

The installed demo extension is added only for this disposable child, alongside
the global profile. Its source was inspected before loading it. The test passed
with the actual binary in approximately 1.1 seconds, with no `agent_start`
event, no provider request, no `extension_error`, and exit code 0:

- `/lsp status`, `/fast status`, and `/notify status` returned `handled` and
  emitted `notify` requests.
- `/rpc-input` and `/rpc-editor` emitted `input` and `editor` requests; the
  harness replied `cancelled: true` and received their cancellation notices.
- `new_session` emitted `confirm`; cancellation returned `cancelled: true` and
  a `Clear cancelled` notice, without replacing the session.
- Bare `/lsp` returned `handled` but emitted **no UI**. `get_commands.sourceInfo`
  confirmed the user-installed `pi-lsp-adapter/src/index.ts`. Its
  `src/commands/registerCommands.ts:61–88` selects `ctx.ui.custom()` whenever
  `ctx.hasUI` is true; RPC has UI but intentionally does not implement custom
  terminal panels. This independently located source issue was then reproduced
  by the parent-run binary probe. Use `/lsp status`; the global package was not
  changed. A full LSP terminal panel is already outside Phase 1's scope.

The installed demo only exercises `select` through a dangerous bash-command
hook; that path was deliberately not invoked. Selection, submitting dialog
values, browser disconnect cancellation, and other extension tools/commands
remain unverified. The SDK package inspected by the scout is 0.84.4, not assumed
identical to the native binary; binary observations above are the stronger
compatibility evidence.

## Remaining M0 gates

- Complete the required extension profile and standard-dialog checks: notification
  controls and input/editor/confirm cancellation passed in the separate probe;
  selection, accepted values, and browser disconnect handling remain unverified.
- Prove bounded large-history active-branch projection, oversized-record handling,
  migration timing, history-to-live handoff, and added memory measurements.
- Playwriter now connects: the development fixture rendered `starting`, changed
  to `ready` on click, reset on reload, and changed to `ready` on Enter activation.
  No JavaScript exceptions were observed; the missing favicon returned 404.
  The task-owned tab and dev server were closed. Actual chat/extension-dialog
  browser flows remain unimplemented and unverified.

Tiny fixture `get_messages` on restart is deliberate test-only inspection; it
is **not** a production history-loading strategy. No broad Phase 1 readiness,
browser disconnect cancellation, slow-client behavior, or detached-descendant
cleanup guarantee follows from this smoke. M1–M5 remain unimplemented.

Contracts consulted: installed `docs/rpc.md`, `docs/rpc-commands.md`,
`docs/json.md`, `docs/rpc-extension-ui.md`, and `docs/message-types.md` under the
Pi-Bolt installation. Observations above are from the actual installed binary,
not merely those documents.
