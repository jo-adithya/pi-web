# Dependency security checkpoint

## Scope and method

Checked the nine exact frontend dependency pins in `apps/web/package.json`
against the OSV API, read all six returned advisory records, and inspected npm
registry metadata (publication date, repository, license, scripts and published
signature/provenance fields). Also checked the four subsequently blocked
transitive candidates listed below. No package code or exploit was executed.

After the expanded exception was approved, resolved `bun.lock` and ran
`bun audit --json` against the selected tree before executing frontend tools.
The audit found two additional advisories in `@vitest/mocker`; the remediation
and subsequently resolved compiler-installation gap are recorded below.

This is a bounded self-review, not an independent audit or a guarantee against
malicious packages, undisclosed vulnerabilities, or delayed advisory reporting.
Published signature/provenance metadata was observed, **not cryptographically
verified**. Rust dependencies and the Node/Bun runtimes were not audited here.

## Finding: original Vite pin affected by six advisories

`apps/web/package.json` originally pinned Vite 8.2.1. OSV reports these
GitHub-reviewed advisories as affecting that version; all list 8.2.4 as the fix
on the 8.2 release line:

| Advisory | Upstream severity | Exposure conditions |
|---|---|---|
| [GHSA-587h-7wmj-h5pm](https://github.com/vitejs/launch-editor/security/advisories/GHSA-587h-7wmj-h5pm) | High | Windows path-check bypass combined with editor command injection |
| [GHSA-698v-4r3x-3vcv](https://github.com/vitejs/launch-editor/security/advisories/GHSA-698v-4r3x-3vcv) | Moderate | Windows command expansion via crafted filename and environment/NTFS conditions |
| [GHSA-r825-w8mm-5pxw](https://github.com/vitejs/launch-editor/security/advisories/GHSA-r825-w8mm-5pxw) | Moderate | For Vite: WSL, affected editor and attacker-created flag-like file entry |
| [GHSA-9jrq-w75r-8gcw](https://github.com/vitejs/vite/security/advisories/GHSA-9jrq-w75r-8gcw) | Low | Custom middleware HTML transformation with attacker-controlled URL and inline module |
| [GHSA-rq7h-c2jc-7f22](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22) | Moderate | Non-Windows dev server, reachable request and imported root-relative path colliding with a host path |
| [GHSA-vfpm-58rq-9qcg](https://github.com/vitejs/vite/security/advisories/GHSA-vfpm-58rq-9qcg) | Moderate | Dev server on Node/Deno: crafted Wasm query reveals first four file bytes |

Version matching is confirmed; exploitability of this scaffold was not
demonstrated. It is macOS-first, binds Vite to loopback, uses the default SPA
mode and has no backend proxy. Windows/WSL conditions do not apply locally.
Loopback limits remote exposure but is not a reason to retain a vulnerable pin.
Running package scripts through Bun does not establish that Vite itself runs
under Bun rather than its Node shebang.

**Remediation performed:** pin Vite to 8.2.4, published 2026-10-06. An exact-version
OSV query returned no advisories for that release. No exploit was run.
The later resolved-tree audit returned no findings after the Vitest patch below.
After installing the authorized native binding, tests, the production build,
and a loopback development HTTP/JSX-transform smoke check passed.

## Other queried packages

OSV returned no matching advisories for:

- `solid-js@2.0.0-rc.19`
- `@solidjs/web@2.0.0-rc.19`
- `@solidjs/vite-plugin@3.0.0-next.52`
- `@solidjs/testing-library@1.0.0-rc.2`
- `typescript@5.9.3`
- `vitest@4.1.11`
- `jsdom@30.1.3`
- `@types/node@26.6.6`
- `@solidjs/compiler@2.0.0-rc.19`
- `@solidjs/babel-plugin@2.0.0-rc.19`
- `@solidjs/signals@2.0.0-rc.19`
- `seroval-plugins@1.7.0`

The Solid packages identify Solid's official GitHub repositories. The scoped
`@types/node` package identifies DefinitelyTyped; it is not the similarly named
unscoped `types-node` package. The four originally blocked pins have no
preinstall/install/postinstall hooks in registry metadata. Among the additional
four candidates, the Babel plugin declares `prepare: pnpm run build`; all
attempts retained `--ignore-scripts`.

These new Solid releases were published on 2026-10-27/28. Their short public
exposure time is a real residual supply-chain risk even without known advisories.

## Finding: Vitest transitive advisories

The initial resolved-tree `bun audit --json` exited 1 with two moderate
advisories affecting `@vitest/mocker@4.1.11`:

- [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8):
  code injection through unauthenticated manual mock registration. Requires a
  reachable development server using the public mocker/interceptor plugin API;
  the advisory states Node test runs do not register these handlers.
- [GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp):
  Windows backslash traversal through that public WebSocket registration API.

This fixture uses neither public plugin and runs on macOS. No exploit was run.
Nevertheless, `vitest` was patched to **4.1.12**, which pins the patched mocker
and related Vitest packages. Published 2026-10-15, it needs no release-age
exception. This also demonstrates why querying only the direct `vitest`
package earlier missed affected transitive code.

After re-resolution, `bun audit --json` exited 0 with `{}`. That covers the
resolved lockfile, not missing optional packages, unpublished vulnerabilities,
or malicious code. It is not proof that dependencies are safe.

## Installation history and resolution

The user authorized expanding the exception to eight names. Both lockfile
resolution and the frozen install succeeded, with scripts disabled:

```sh
bun install --lockfile-only --ignore-scripts \
  --minimum-release-age-excludes='solid-js,@solidjs/web,@solidjs/vite-plugin,@types/node,@solidjs/compiler,@solidjs/babel-plugin,@solidjs/signals,seroval-plugins'
bun audit --json
bun install --frozen-lockfile --ignore-scripts \
  --minimum-release-age-excludes='solid-js,@solidjs/web,@solidjs/vite-plugin,@types/node,@solidjs/compiler,@solidjs/babel-plugin,@solidjs/signals,seroval-plugins'
```

No global configuration changed. Bun reported a 180-package resolution;
`bun.lock` has 179 entries in its `packages` map, including the workspace link.
The local install reported 154 packages installed. However, the compiler's optional
platform packages are absent from the resolved entries. Both Vitest and Vite
fail with `Could not find an @solidjs/compiler binding for darwin-arm64`.
Selecting the Babel JSX transform would not avoid this compiler dependency.

A temporary, isolated manifest requiring
`@solidjs/compiler-darwin-arm64@2.0.0-rc.19` reproduced the cause: lockfile-only
installation, with no exception and scripts disabled, exited 1 with
`blocked by minimum-release-age: 604800 seconds`. The temporary fixture was
removed. The native package was published 2026-10-27, identifies Solid's
repository, declares no scripts or dependencies, and returned `{}` from an
exact-version OSV query. Its binary and provenance were not independently
verified.

The user subsequently authorized the ninth exception for that exact package
name. Re-running resolution against the existing lockfile did not add the
previously omitted optional dependency. Regenerating the lockfile from the
unchanged manifests added only `@solidjs/compiler-darwin-arm64@2.0.0-rc.19`,
with no changed or removed package entries (Bun reported 181 packages).

The successful resolution and install used:

```sh
bun install --lockfile-only --ignore-scripts \
  --minimum-release-age-excludes='solid-js,@solidjs/web,@solidjs/vite-plugin,@types/node,@solidjs/compiler,@solidjs/babel-plugin,@solidjs/signals,seroval-plugins,@solidjs/compiler-darwin-arm64'
bun audit --json
bun install --frozen-lockfile --ignore-scripts \
  --minimum-release-age-excludes='solid-js,@solidjs/web,@solidjs/vite-plugin,@types/node,@solidjs/compiler,@solidjs/babel-plugin,@solidjs/signals,seroval-plugins,@solidjs/compiler-darwin-arm64'
```

The audit exited 0 with `{}`, now including the native binding. The frozen
install added one package. Typecheck, all three Rust tests, all five frontend
tests, and the production build passed. Development HTTP serving and JSX
transformation also passed. Playwriter initially could not connect; after the
user enabled it, development and production browser fixtures passed. See
`m0-handoff-evidence.md` for the later checks.

No persistent policy changes were made. Other platforms' native bindings and
the WASM fallback remain unverified and have no authorized age exceptions.
These checks establish fixture compatibility, not a malicious-code audit of
the native compiler or full Phase 1 readiness.

## Subsequent clean-install and Rust checks

A temporary workspace containing only the frozen root/web manifests and lockfile
installed successfully with `bun install --frozen-lockfile --ignore-scripts`,
without any release-age override. The lockfile was byte-for-byte unchanged and
the temporary directory was removed. This validates reproducible installation on
the current macOS arm64 host, not other native platforms.

M1 adds exact `tokio=1.54.1` (only required process/I/O/runtime features) and stable
`libc=0.2.191`; the newer libc 1.0 alpha was deliberately not selected. Existing
`serde_json=1.0.154` moves from test-only to a normal dependency. Cargo resolves
nine additional lock entries. A direct OSV querybatch of all **29 registry
packages** in that lockfile returned no advisories. This is a known-advisory
check, not source, build-script, binary or provenance verification; it must be
repeated if the dependency graph changes. `cargo check --workspace` passed.

## Phase 1 HTTP integration audit

Axum `0.8.9`, `futures-util 0.3.34` and test-only `tower 0.5.3` bring the Cargo
lockfile to **78 registry packages**. The repeated OSV query returned one match:
`block-buffer 0.10.4`, GHSA-qwgh-2vcv-g2f7. Its reported inline-cursor mechanism
is not present in the installed old-series source; an isolated exact-version
panic regression passes. [Detailed applicability evidence](block-buffer-advisory.md)
records both the scanner match and the limits of that assessment. No forced
incompatible transitive update or silent advisory suppression was made.

The repeated `bun audit --json` exited 0 with `{}`. These are advisory checks,
not a guarantee against malicious dependencies or native compiler behavior.

Sources: [OSV API](https://google.github.io/osv.dev/api/),
[npm registry](https://registry.npmjs.org/), and the primary advisories above.
