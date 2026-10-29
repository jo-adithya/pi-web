import type { ServerOptions } from "vite";

/**
 * Builds loopback Vite settings for the exact HTTPS origin used by the Rust backend.
 * Tailscale Serve terminates HTTPS and forwards to port 5173. Authentication routes
 * retain Host, Origin and WebSocket subprotocols so Rust still checks every proof.
 * Throws for missing/noncanonical origins or invalid backend ports; no credentials
 * or public tunnel configuration belong in these environment variables.
 */
export function developmentServer(env: Record<string, string | undefined>): ServerOptions {
  const origin = env.PI_WEB_DEV_ORIGIN;
  let url: URL;
  try { url = new URL(origin ?? ""); }
  catch { throw new Error("Set PI_WEB_DEV_ORIGIN to the exact HTTPS --remote-origin used by pi-web."); }
  if (url.protocol !== "https:" || url.origin !== origin || url.port || url.username || url.password) {
    throw new Error("PI_WEB_DEV_ORIGIN must be a canonical HTTPS origin without a port, path or trailing slash.");
  }
  const port = env.PI_WEB_BACKEND_PORT ?? "9876";
  if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("PI_WEB_BACKEND_PORT must be an integer from 1 to 65535.");
  }
  const target = `http://127.0.0.1:${Number(port)}`;
  return {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    allowedHosts: [url.hostname],
    cors: false,
    origin,
    headers: { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" },
    hmr: { protocol: "wss", host: url.hostname, clientPort: 443, path: "/__pi_web_hmr" },
    proxy: {
      "^/(?:auth|push|sw\\.js)(?:\\?|$)": { target, changeOrigin: false },
      "^/images/": { target, changeOrigin: false },
      "^/ws(?:\\?|$)": { target, changeOrigin: false, ws: true },
    },
  };
}
