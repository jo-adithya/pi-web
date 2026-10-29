# Frontend hot reload through Tailscale

Vite serves development sources and hot reload; Rust continues to own sessions and
validate every API/WebSocket capability, Host and Origin. Use this only on a trusted
private tailnet. A development server exposes source files and is not a production
server. Never use Tailscale Funnel or disable host/origin checks.

## Start development

Replace the example hostname below with the exact lowercase HTTPS origin already
used by pi-web. Do not include a trailing slash or a capability secret in the
`PI_WEB_DEV_ORIGIN` variable.

1. Keep the Rust backend on its usual port and origin:

   ```sh
   cargo run --locked -p pi-web -- \
     --remote-origin https://your-machine.your-tailnet.ts.net
   ```

   Keep any existing `--cwd`, `--state-dir` or other options you normally use.
   If this backend is already running with the right origin, keep it running;
   starting another process against the same state directory is unnecessary.

2. In another terminal, from the repository root:

   ```sh
   PI_WEB_DEV_ORIGIN=https://your-machine.your-tailnet.ts.net bun run dev
   ```

   Vite binds only `127.0.0.1:5173` and fails rather than silently choosing another
   port. If Rust uses a different `--port`, also set `PI_WEB_BACKEND_PORT` to that
   port. Otherwise it defaults to `9876`.

3. Inspect `tailscale serve status`. Replace only this application's existing
   Serve mapping so HTTPS points to Vite instead of directly to Rust:

   ```sh
   tailscale serve --https=443 http://127.0.0.1:5173
   ```

   If your old Serve command is running in a terminal, stop that proxy first.
   Do not overwrite another service's mapping. Changing the proxy briefly breaks
   browser connections, but does not stop the Rust server or its active tasks.
   Keep the new foreground Serve process running.

4. Open the same HTTPS URL. Existing tabs keep their tab-local authentication
   because the origin is unchanged. For a new tab, use the complete private
   capability URL printed by Rust. Refresh once to load the development frontend.

Frontend edits now update through Vite's HTTPS WebSocket connection. Some edits
cause a full page reload rather than preserving component state, so do not assume
unsent drafts survive every edit. Rust agent processes continue running during
frontend refreshes. Rust source changes still require a build and server restart;
wait for active work to finish first.

The API and session WebSocket routes are proxied without rewriting Host, Origin or
capability subprotocols. Vite's separate `/__pi_web_hmr` socket handles hot reload.
Do not open the localhost Vite address: the app is configured for the HTTPS origin.
Browser service-worker updates and locked-phone Web Push are separate from HMR;
service-worker edits may need a reload/update cycle.

## Return to the built frontend

Run `bun run build`, stop the development Serve process, then point Serve back to
Rust:

```sh
tailscale serve --https=443 http://127.0.0.1:9876
```

Use your custom Rust port instead if applicable. Stop Vite and refresh the browser.
No Rust restart is needed for frontend-only changes. Production builds do not need
`PI_WEB_DEV_ORIGIN` and retain their existing behavior.

Automated tests exercise the real Vite HTTP/WebSocket proxy and configuration.
Actual Tailscale routing and phone hot reload require a manual check on your devices.

### Image references and resource limits

PNG and JPEG attachments can be selected, pasted or dropped into the composer.
A model must advertise `input: ["image", ...]`; text-only models cannot accept
attachments. Image-only prompts are supported. The browser decodes files before
upload, preserves small suitable inputs, and resizes larger inputs once to a
1600px longest edge (JPEG quality 0.8, white transparency background). Sources
are capped at 8 MiB, 8192px per edge and 32 million pixels. Preparation failures
require an explicit smaller file; there is no repeated compression or resend.
Up to four prepared images may total 512 KiB. This leaves base64 RPC encoding
plus 32 KiB text below the existing 1 MiB write limit. WebSockets carry refs only.

`POST /images/{session}` uploads bounded bytes; `POST /images/{session}/{ref}`
loads them on demand. Both require exact Host/Origin and `x-pi-capability`; reads
intentionally use POST because ordinary GET fetches may omit Origin. Retrieval
never interprets a path supplied by the browser. Browser images use local blob
URLs (CSP permits `blob:` only for images), released on hide/unmount/removal.
The server checks PNG/JPEG signatures and declared dimensions (4096px per edge,
16 million pixels), not full decoder validity; SVG/WebP/remote URLs are unsupported.

Each active session owns a FIFO cache capped at 32 MiB/128 images, with at most
4 MiB per displayed image. Upload refs expire for sending after 30 minutes;
rejection/disconnection preserves draft refs and previews without automatic replay.
Expired/evicted refs fail explicitly and require reattaching the source. Two HTTP
image operations are admitted concurrently. Loading images is opt-in, with a Hide
control to release browser memory.

Pi JSONL remains authoritative and is never rewritten to strip model context.
History reconstructs the same cache from visible persisted image blocks, including
tool results (tool text/metadata stays hidden). Image-aware history permits an
8 MiB record only under the existing streaming metadata/depth validation and a
16,384-node budget enforced during JSON construction, before allocation of an
unbounded value tree. Base64 is replaced before retention. The 128 MiB scan,
64 KiB projected record, 8 MiB/500-entry view and existing RPC read limits remain.
Older/oversized/unsupported/evicted images show an unavailable notice instead of
expanding budgets; reload normally reconstructs retained persisted images. This
bounded cache deliberately avoids a new persistent image store or per-thumbnail
filesystem scans. Image display never resends images to the model.
