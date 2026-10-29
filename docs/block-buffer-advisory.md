# block-buffer advisory applicability

The Phase 1 lockfile audit queried all **78** registry crates through OSV. It
returned **one** match: `block-buffer 0.10.4`, advisory
[GHSA-qwgh-2vcv-g2f7](https://github.com/RustCrypto/utils/security/advisories/GHSA-qwgh-2vcv-g2f7).
Do not describe this audit as empty or suppress its result silently.

Dependency path: `axum 0.8.9` and `tungstenite 0.29.0` use `sha1 0.10.7`, which
uses `digest 0.10.7` → `block-buffer 0.10.4` for WebSocket handshakes. The OSV
range is broadly `>=0,<0.12.1`; upgrading the transitive crate directly across its
incompatible API versions is not a valid lockfile-only fix.

## Mechanism checked

The primary advisory describes input overwriting an **inline cursor** stored in
the buffer, followed by a caught compression/generator callback panic that prevents
cursor restoration. Subsequent buffer reuse can violate unsafe bounds invariants.

Installed `block-buffer-0.10.4/src/lib.rs:55-63` instead has separate fields:

```rust
buffer: Block<BlockSize>,
pos: u8,
```

`digest_blocks` copies input into `buffer`, not `pos`; the callback cannot overwrite
that separate field. `get_pos` checks `self.pos`. This version has no `ReadBuffer`
type (the advisory's second example). Source inspection therefore does not support
the reported inline-cursor mechanism applying to this old series.

An isolated temporary Cargo test, pinned exactly to `block-buffer=0.10.4`, ran
`cargo test --offline --quiet`. It reproduced the advisory's EagerBuffer input
and caught panic, asserted the position remains **2**, then reset/reused the buffer
successfully. One test passed, and the temporary workspace was removed. No project
manifest/lockfile or advisory database was changed.

This is a **version-specific applicability assessment**, not an upstream correction,
Miri run, proof of all memory safety, or malicious-source audit. The scanner's broad
range remains a recorded match. Reassess if the lockfile changes; do not blanket
allowlist other block-buffer versions or ignore a newly applicable mechanism.
