import { afterEach, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { createPhonePush } from "../src/phone-push";

function browser(permission: NotificationPermission = "default") {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const notification = { permission, requestPermission: vi.fn(async () => "granted") };
  const subscription = { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/wp/token", keys: { auth: "auth", p256dh: "key" } }), unsubscribe: vi.fn(async () => true) };
  const registration = { pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => subscription) } };
  const worker = { register: vi.fn(async () => registration), ready: Promise.resolve(registration), getRegistration: vi.fn(async () => ({ pushManager: { getSubscription: async () => subscription } })) };
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ publicKey: "B" + "A".repeat(86) }) }));
  vi.stubGlobal("Notification", notification); vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("navigator", { serviceWorker: worker }); vi.stubGlobal("isSecureContext", true); vi.stubGlobal("fetch", fetch);
  return { storage, notification, subscription, worker, fetch };
}
afterEach(() => { flush(); vi.unstubAllGlobals(); });

it("does not register, subscribe, request permission or fetch on construction", () => {
  const mock = browser(); createPhonePush(() => "proof");
  expect(mock.worker.register).not.toHaveBeenCalled(); expect(mock.fetch).not.toHaveBeenCalled();
  expect(mock.notification.requestPermission).not.toHaveBeenCalled();
});
it("requires consent and current proof, persists separate device management, and revokes only it", async () => {
  const mock = browser(); const push = createPhonePush(() => "proof");
  await push.enable(); expect(push.enabled()).toBe(true);
  expect(mock.worker.register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
  const saved = JSON.parse(mock.storage.get("pi-web.phone-push.v1")!);
  expect(saved.secret).toMatch(/^[a-f0-9]{64}$/); expect(mock.storage.has("pi-web.notifications.v1")).toBe(false);
  await push.test(); await push.disable(); expect(push.enabled()).toBe(false);
  const calls = mock.fetch.mock.calls as unknown as [string, RequestInit][];
  expect(calls.map(([, init]) => JSON.parse(String(init.body)).operation)).toEqual(["setup", "subscribe", "test", "remove"]);
  expect(JSON.parse(String(calls[3][1].body)).secret).toBe(saved.secret);
  expect(calls[1][1].headers).toEqual({ "content-type": "application/json", "x-pi-capability": "proof" });
  expect(mock.subscription.unsubscribe).toHaveBeenCalledOnce();
});
it("rejects denied, unsupported, missing-login and storage failure paths before registration", async () => {
  const mock = browser("denied"); await createPhonePush(() => "proof").enable();
  expect(mock.worker.register).not.toHaveBeenCalled(); expect(mock.fetch).not.toHaveBeenCalled();
  mock.notification.permission = "granted";
  await createPhonePush(() => null).enable(); expect(mock.fetch).not.toHaveBeenCalled();
  vi.stubGlobal("isSecureContext", false); await createPhonePush(() => "proof").enable();
  vi.stubGlobal("isSecureContext", true); vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("storage blocked"); } });
  await createPhonePush(() => "proof").enable(); expect(mock.worker.register).not.toHaveBeenCalled();
});
it("retains device secret after ambiguous subscribe failure so opt-out can retry safely", async () => {
  const mock = browser("granted");
  mock.fetch.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ publicKey: "B" + "A".repeat(86) }) }));
  mock.fetch.mockImplementationOnce(async () => { throw new Error("network failed"); });
  const push = createPhonePush(() => "proof"); await push.enable();
  expect(push.enabled()).toBe(false); expect(push.message()).toContain("network failed");
  await push.disable(); expect(mock.subscription.unsubscribe).toHaveBeenCalledOnce();
});

it("rejects invalid setup and worker registration failures without enabling", async () => {
  const mock = browser("granted");
  mock.fetch.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ publicKey: "invalid" }) }));
  const push = createPhonePush(() => "proof"); await push.enable();
  expect(push.message()).toContain("Invalid"); expect(mock.worker.register).not.toHaveBeenCalled();
  mock.worker.register.mockRejectedValueOnce(new Error("worker rejected")); await push.enable();
  expect(push.enabled()).toBe(false); expect(push.message()).toContain("worker rejected");
});
