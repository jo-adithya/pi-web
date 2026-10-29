/** Private, version-specific Pi-Bolt 1.4.0 subscription usage adapter. */
export const USAGE_PREFIX = "pi-web:codex-usage:v1:";
interface Model { provider: string; baseUrl: string }
/** Runtime-owned authentication refresh stays behind this structural Pi API. */
export interface UsageContext {
  mode: string;
  model?: Model;
  modelRegistry: {
    isUsingOAuth(model: Model): boolean;
    getProvider(provider: string): { auth: { oauth?: { isSubscription?: boolean } } } | undefined;
    getApiKeyAndHeaders(model: Model): Promise<{ ok: true; apiKey?: string; headers: Record<string, string>; baseUrl?: string } | { ok: false; error: unknown }>;
  };
  ui: { notify(message: string, type: "info"): void };
}
export interface UsageHost {
  registerCommand(name: string, command: { description: string; handler(args: string, context: UsageContext): Promise<void> }): void;
}
const BASE = "https://chatgpt.com/backend-api";
const MAX_BODY = 64 * 1024;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;

/** Projects only present, valid rate-limit windows; missing limits are never zero usage. */
function windows(body: unknown, observedAt: number) {
  if (!record(body) || !record(body.rate_limit)) throw new Error("unavailable");
  const result = [];
  for (const identity of ["primary", "secondary"] as const) {
    const window = body.rate_limit[`${identity}_window`];
    if (window == null) continue;
    if (!record(window) || !finite(window.used_percent, 100) ||
        !finite(window.limit_window_seconds, 366 * 86400) || window.limit_window_seconds === 0 ||
        !Number.isInteger(window.limit_window_seconds) || !finite(window.reset_after_seconds, 366 * 86400)) throw new Error("unavailable");
    result.push({ identity, durationSeconds: window.limit_window_seconds, usedPercent: window.used_percent,
      resetsAt: observedAt + Math.ceil(window.reset_after_seconds) });
  }
  if (!result.length) throw new Error("unavailable");
  return result;
}

/** Reads at most 64 KiB, with the caller's abort signal covering headers and body. */
async function readBody(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) throw new Error("unavailable");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Registers a private RPC command using Pi-owned OAuth refresh. The undocumented
 * /wham/usage endpoint and auth port match installed Pi-Bolt 1.4.0's usage extension.
 * Credentials go only to the fixed official base, without redirects or extra headers.
 * Account comparison is internal; only a clear-cache signal crosses the RPC boundary.
 */
export default function registerUsage(pi: UsageHost): void {
  let previousAccount: string | undefined;
  pi.registerCommand("pi-web-codex-usage", {
    description: "Read bounded Codex subscription usage for Pi Web",
    handler: async (requestId, context) => {
      if (context.mode !== "rpc") throw new Error("pi-web-codex-usage requires RPC mode");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) return;
      const notify = (reply: RecordValue) => context.ui.notify(USAGE_PREFIX + JSON.stringify({ requestId, ...reply }), "info");
      let clear = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const model = context.model;
        if (!model || model.provider !== "openai-codex" || !context.modelRegistry.isUsingOAuth(model) ||
            context.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription !== true) {
          previousAccount = undefined;
          notify({ status: "unavailable", clear: true }); return;
        }
        const controller = new AbortController();
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("unavailable")); }, 10_000);
        });
        const auth = await Promise.race([context.modelRegistry.getApiKeyAndHeaders(model), deadline]);
        if (!auth.ok || !auth.apiKey || auth.apiKey.length > 32768) throw new Error("unavailable");
        const claims: unknown = JSON.parse(Buffer.from(auth.apiKey.split(".")[1] ?? "", "base64url").toString("utf8"));
        const payload = record(claims) ? claims["https://api.openai.com/auth"] : undefined;
        const account = record(payload) ? payload.chatgpt_account_id : undefined;
        if (typeof account !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(account)) throw new Error("unavailable");
        clear = previousAccount !== account;
        previousAccount = account;
        // Clear before I/O so a changed account cannot leave another account's stale value.
        notify({ status: "checking", clear });
        if ((auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "") !== BASE ||
            model.baseUrl.replace(/\/+$/, "") !== BASE) throw new Error("unavailable");
        const response = await Promise.race([fetch(`${BASE}/wham/usage`, { redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${auth.apiKey}`, "chatgpt-account-id": account } }), deadline]);
        const body = await Promise.race([readBody(response), deadline]);
        const observedAt = Math.floor(Date.now() / 1000);
        notify({ status: "ok", clear, observedAt, windows: windows(body, observedAt) });
      } catch {
        if (clear) previousAccount = undefined;
        notify({ status: "unavailable", clear });
      } finally { if (timer !== undefined) clearTimeout(timer); }
    },
  });
}
