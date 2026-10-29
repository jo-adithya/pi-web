import { afterEach, expect, test, vi } from "vitest";
import registerUsage, { USAGE_PREFIX, type UsageContext, type UsageHost } from "../../server/pi/codex-usage";

const token = (account = "private-account") => `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
const body = { rate_limit: { primary_window: { used_percent: 72, limit_window_seconds: 18000, reset_after_seconds: 3600 }, secondary_window: { used_percent: 84, limit_window_seconds: 604800, reset_after_seconds: 86400 } } };
function setup() {
  let handler!: Parameters<UsageHost["registerCommand"]>[1]["handler"];
  registerUsage({ registerCommand(name, command) { expect(name).toBe("pi-web-codex-usage"); handler = command.handler; } });
  const notify = vi.fn();
  const context: UsageContext = { mode: "rpc", model: { provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" }, modelRegistry: {
    isUsingOAuth: () => true, getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
    getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: token(), headers: { "secret-header": "do-not-forward" } })),
  }, ui: { notify } };
  const replies = () => notify.mock.calls.map(call => JSON.parse(call[0].slice(USAGE_PREFIX.length)));
  return { handler, context, notify, replies };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
test("fetches only official Codex usage and projects bounded windows without credentials", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", fetch); vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const { handler, context, replies, notify } = setup();
  await handler("request", context);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]).toEqual(["https://chatgpt.com/backend-api/wham/usage", expect.objectContaining({ redirect: "error", headers: { Authorization: `Bearer ${token()}`, "chatgpt-account-id": "private-account" } })]);
  expect(replies().at(-1)).toEqual({ requestId: "request", status: "ok", clear: true, observedAt: 1_800_000_000, windows: [
    { identity: "primary", durationSeconds: 18000, usedPercent: 72, resetsAt: 1_800_003_600 },
    { identity: "secondary", durationSeconds: 604800, usedPercent: 84, resetsAt: 1_800_086_400 },
  ] });
  expect(JSON.stringify(notify.mock.calls)).not.toMatch(/private-account|signature|do-not-forward/);
  vi.restoreAllMocks();
});

test.each(["https://evil.example/backend-api", "http://chatgpt.com/backend-api", "https://chatgpt.com.evil.example/backend-api", "https://chatgpt.com/backend-api?secret"])('rejects credential destination %s', async baseUrl => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const { handler, context, replies } = setup();
  context.model!.baseUrl = baseUrl;
  await handler("request", context);
  expect(fetch).not.toHaveBeenCalled(); expect(replies().at(-1).status).toBe("unavailable");
});
test.each(["provider", "oauth", "subscription", "invalid-token", "auth", "override"])("gates %s without authenticated fetch", async gate => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const { handler, context, replies } = setup();
  if (gate === "provider") context.model!.provider = "other";
  if (gate === "oauth") context.modelRegistry.isUsingOAuth = () => false;
  if (gate === "subscription") context.modelRegistry.getProvider = () => undefined;
  if (gate === "auth") context.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "PRIVATE error" });
  if (gate === "override") context.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: token(), headers: {}, baseUrl: "https://evil.example" });
  await handler(gate === "invalid-token" ? "bad token" : "request", context);
  expect(fetch).not.toHaveBeenCalled(); expect(JSON.stringify(replies())).not.toContain("PRIVATE");
});
test("retains account identity on fetch failure but clears on account or auth change", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(body))).mockRejectedValue(new Error("private-provider-error"));
  vi.stubGlobal("fetch", fetch);
  const { handler, context, replies } = setup();
  await handler("one", context); await handler("two", context);
  expect(replies().at(-1)).toEqual({ requestId: "two", status: "unavailable", clear: false });
  context.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: token("another-account"), headers: {} });
  await handler("three", context);
  expect(replies().at(-2)).toEqual({ requestId: "three", status: "checking", clear: true });
  context.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "private" });
  await handler("four", context); expect(replies().at(-1).clear).toBe(true);
  expect(JSON.stringify(replies())).not.toMatch(/another-account|private/);
});
test.each([{}, { rate_limit: {} }, { rate_limit: { primary_window: { used_percent: -1, limit_window_seconds: 18000, reset_after_seconds: 1 } } }, { rate_limit: { primary_window: { used_percent: 101, limit_window_seconds: 18000, reset_after_seconds: 1 } } }, { rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 0, reset_after_seconds: 1 } } }])("rejects absent or invalid limits %j", async body => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
  const { handler, context, replies } = setup(); await handler("one", context);
  expect(replies().at(-1).status).toBe("unavailable");
});
test("bounds response bytes and accepts a single zero-usage window", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response("x".repeat(65537))).mockResolvedValueOnce(new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 0 } } })));
  vi.stubGlobal("fetch", fetch); const { handler, context, replies } = setup();
  await handler("one", context); expect(replies().at(-1).status).toBe("unavailable");
  await handler("two", context); expect(replies().at(-1).windows).toHaveLength(1); expect(replies().at(-1).windows[0].usedPercent).toBe(0);
});
test("aborts a pending fetch at ten seconds and clears its timer", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))));
  const { handler, context, replies } = setup(); const pending = handler("one", context);
  await vi.advanceTimersByTimeAsync(10_000); await pending;
  expect(replies().at(-1).status).toBe("unavailable"); expect(vi.getTimerCount()).toBe(0);
});
test("non-RPC invocation cannot read authentication", async () => {
  const { handler, context } = setup(); context.mode = "tui";
  await expect(handler("one", context)).rejects.toThrow("requires RPC mode");
  expect(context.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
});
test("auth timeout never allows a late credential result to start a fetch", async () => {
  vi.useFakeTimers(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const { handler, context, replies } = setup();
  let resolve!: (value: Awaited<ReturnType<UsageContext["modelRegistry"]["getApiKeyAndHeaders"]>>) => void;
  context.modelRegistry.getApiKeyAndHeaders = () => new Promise(done => { resolve = done; });
  const task = handler("late", context);
  await vi.advanceTimersByTimeAsync(10_000); await task;
  resolve({ ok: true, apiKey: token(), headers: {} }); await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled();
  expect(replies().at(-1)).toEqual({ requestId: "late", status: "unavailable", clear: true });
});
test("body reads remain subject to the operation deadline", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start() {} }))));
  const { handler, context, replies } = setup();
  const task = handler("body", context); await vi.advanceTimersByTimeAsync(10_000); await task;
  expect(replies().at(-1)).toEqual({ requestId: "body", status: "unavailable", clear: true });
});
