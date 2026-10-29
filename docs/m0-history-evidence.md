# M0 history experiment — gate remains open

## Candidate and scope

`apps/server/examples/history_probe.rs` is a research executable, **not server
history support**. It opens a supplied local fixture read-only and requires an
authoritative current leaf ID. There is no browser path endpoint.

It scans LF-delimited ranges backwards in 64 KiB blocks, follows parent IDs,
streams metadata with a bounded JSON scanner, and decodes a full display record
only below 64 KiB. Captured metadata strings/keys are limited to 1024 decoded
UTF-8 bytes, with a 64-container nesting limit. Oversized inactive IDs and unknown
keys/payloads are validated and discarded; oversized selected metadata errors.
Larger display records become visible truncation placeholders.

Retention stops at 500 entries, 8 MiB of serialized entry data, or 16,384 JSON
values/object keys, whichever occurs first, with an older-history marker. A single
record above the node budget becomes a placeholder. The node budget bounds
allocation overhead separately from text size; it is not a byte-exact RSS limit.
Scanning stops with an explicit error at 128 MiB, not an unlimited-history guarantee.

The caller must keep the file stable. The CLI does not implement session-path
authorization, live-event handoff, file mutation recovery, old-format migration,
or a production empty-session interface.

## Reproduce

```sh
cargo test --locked --workspace --all-targets
cargo build --locked -p pi-web --example history_probe --release
python3 scripts/m0-history-smoke.py --run --probe /path/to/cargo-target/release/examples/history_probe
```

Use Cargo's actual `target_directory` from `cargo metadata --no-deps
--format-version 1`; this machine uses a shared target directory outside the
repository. The Python harness requires macOS `/usr/bin/time -l` for peak RSS.

The harness creates only temporary synthetic sessions, loads the real Pi-Bolt
binary with only the project-local head adapter and MCP disabled, sends no provider requests, and cleans up
the children/files. A successful harness exit means the measurements and stated
fixture assertions ran; its `m0_gate_status` explicitly remains **incomplete**.

## Functional evidence

The first ancestry test initially failed with `left: [] / right: ["a", "b"]`
against the new unimplemented projection, then passed after implementation.
Twenty-four example tests now cover:

- Active ancestry rather than physical tail; abandoned siblings omitted.
- Original historical text retained across context-edit records.
- Compaction/branch summary markers and hidden custom messages.
- Oversized records represented by placeholders without losing ancestry.
- 500-entry and 8 MiB serialized-byte retention limits.
- Malformed JSON, missing ancestors, cycles and unmigrated v2 headers.
- Unicode, escaped newlines, CRLF and a final record without LF.
- Omission of assistant provider fields, signatures and image bodies.
- Metadata/key limits, arbitrary field ordering, escaped names, split UTF-8 reads,
  JSON number grammar, duplicate fields, invalid/truncated tokens, depth and I/O errors.
- Dense decoded-object retention, per-record complexity placeholders, and stopping
  file reads immediately when selected ancestry reaches its root.

The worker observed RED for an oversized initial leaf before the scanner change.
The parent observed RED for dense decoded-object retention before adding the node
budget (`assertion failed: result.entries.len() < entries.len()`). A further RED
exposed an unnecessary read of older history after selected ancestry was complete;
the loop now checks the wanted ancestor before scanning another record. All pass now.
A separate read-only reviewer found no substantive scanner issues. That review
covered the 21-test scanner version, **not** the subsequent retention and ancestry-stop
changes, which were self-reviewed and mechanically verified by the parent.

These are targeted fixture tests, not proof of every Pi session schema. The
root `bun run test` now uses Cargo's `--all-targets` so example tests are included.

## Real-binary and memory measurements

Measured after building the optimized Rust example; compiler and Pi memory are
**not included** in projection peak RSS. Figures are single local runs, not
performance guarantees.

| Case | File bytes | Projection peak RSS | Projection wall time | Retained entries |
|---|---:|---:|---:|---:|
| 512 KiB message payload | 3,075,743 | 7,061,504 bytes | 0.237 s | 500 |
| 32 MiB message payload | 36,105,887 | 6,782,976 bytes | 0.361 s | 500 |
| 32 MiB metadata ID on abandoned entry | 36,110,159 | 6,782,976 bytes | 0.362 s | 500 |
| 2,000 tiny text blocks per message | 32,388,773 | 4,784,128 bytes | 0.011 s | 1 |

The first three cases retained exactly active IDs 100–599, excluded the abandoned
entry, and showed the older-history marker. The dense-block case retained only
the newest entry (ID 599) because of the node budget, also with the older-history
marker. This tradeoff is explicit: complex previews can shorten the recent window
well below 500 entries. The two payload cases yielded the same 2,085,020-byte
projection and one truncation placeholder. Payload growth did
not cause corresponding projection-memory growth; small negative RSS differences
are measurement noise, not a claimed optimization.

Before the scanner fix, the metadata case peaked at **85,590,016 bytes**
(78,233,600 bytes above that run's baseline). After the scanner fix, it peaked at
6,782,976 bytes. Pi itself loads this synthetic file and reports 600 active messages;
it is not simply a malformed-JSON test. Normal Pi-generated IDs are much smaller.

A second experiment found that an 8,381,424-byte serialized projection of dense
text blocks occupied **243,646,464 bytes** RSS as retained `serde_json::Value`s.
The added node budget reduced that case to 4,784,128 bytes RSS and a 54,108-byte
projection. The stable-file experiments now support bounded token and retention
storage; they do not establish a production snapshot or concurrent handoff contract.

Each native child exited 0. The projection's before/after streaming file hashes
matched. No model request or `agent_start` occurred.

## Startup identity finding

The initial assumption that readiness leaves the fixture tail unchanged failed:
Pi appended a `thinking_level_change` with a new ID and the old tail as parent.
Consequently the original fixture leaf is not a reliable post-readiness leaf.

An earlier probe used `get_entries { since: knownTail }` and observed a tiny
control delta, then an empty 37-byte cursor response. That API is not bounded
under concurrent writes and has now been removed from the large-history harness.

The approved [head adapter](m0-head-evidence.md) supplies the authoritative leaf
without traversing entries. Both checkpoints agree, file identity/size/timestamps
remain unchanged, and no aggregate transcript query occurs in the current four
cases. Head data is 199–201 JSON bytes. This establishes only **controlled idle**
projection consistency, not concurrent history/live adoption.

### Migration and empty-session lifecycle

`python3 scripts/m0-history-lifecycle.py --run` now verifies the actual binary
on four tiny, disposable fixtures, with extensions disabled and no inference:

| Input | Observed after correlated readiness |
|---|---|
| v1 user/assistant history | Rewritten by Pi to v3; stable tree IDs/parents present; original text preserved |
| v2 with legacy `hookMessage` | Rewritten to v3; legacy role renamed `custom`; current leaf persisted |
| Existing v3 file containing only a user message | Startup thinking-level entry persisted; disk and memory both contain two entries |
| New, never-persisted session | No file yet; model/thinking controls exist in memory; leaf is not on disk |

All four children exited 0. Aggregate `get_entries` is used only on these tiny
fixed fixtures, not as the proposed production history API.

**Correction:** the earlier note inferred that an existing all-user file might
not persist startup controls from the stale-leaf observation. This lifecycle
probe refutes that inference for the installed binary. It is a new/unpersisted
session, not every no-assistant session, that lacks an on-disk leaf. The loaded
SDK's `_persist` implementation corroborates the distinction via its `flushed`
flag; the native observation is the authoritative evidence here.

## Consequences for the implementation plan

Subsequent [handoff/continuation evidence](m0-handoff-evidence.md) completes M0
feasibility on the recorded profile. Preserve these obligations during M2 integration:

1. Token allocation and decoded-object retention now have explicit limits, tested
   in Rust and measured against large real-Pi-loadable fixtures. Keep those limits
   and truncation behavior when selecting the production representation.
2. Bounded authoritative-leaf discovery is now verified through the approved
   read-only adapter. Establish concurrent history/live adoption separately;
   matching checkpoints are not a write lock. `get_entries since` remains
   unsuitable as a bounded paging API.
3. Migration and initial empty-session behavior are verified on tiny real-Pi
   fixtures. Additional tests now cover partial writes, an explicit startup hook
   and scan-budget exhaustion. History-only failures must remain separate from
   process readiness; enforce this in the production runtime.
4. Playwriter verifies both development and production fixtures with click,
   reload and Enter activation in Chrome. The actual history/chat UI and its
   browser performance remain unimplemented and unverified.

The explicitly approved project-local adapter is implemented and tested; it
requires explicit `--extension` loading. `get_state` still lacks `leafId`, and
`get_entries since` is not a bounded substitute. The reader remains experimental.

No new dependency, global configuration or transcript rewrite by the projection
or adapter was made. The only writes to synthetic
session files after creation were Pi's own startup persistence.
