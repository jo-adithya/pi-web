import { createSignal } from "solid-js";

const storageKey = "pi-web.phone-push.v1";
type Preference = { secret: string; enabled: boolean };

/** Explicit phone opt-in, independent of desktop notifications. Construction never contacts
 * the server or service worker. The device secret is retained even after an ambiguous failure.
 */
export function createPhonePush(capability: () => string | null) {
  const supported = globalThis.isSecureContext && typeof Notification !== "undefined" && "serviceWorker" in navigator && "PushManager" in globalThis;
  let preference: Preference | undefined;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (saved && typeof saved === "object" && "secret" in saved && typeof saved.secret === "string" && /^[a-f0-9]{64}$/.test(saved.secret) && "enabled" in saved && typeof saved.enabled === "boolean") preference = { secret: saved.secret, enabled: saved.enabled };
  } catch { /* An explicit enable action verifies writable storage before subscribing. */ }
  const [enabled, setEnabled] = createSignal(preference?.enabled ?? false);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  function remember(value: Preference) {
    localStorage.setItem(storageKey, JSON.stringify(value));
    preference = value; setEnabled(value.enabled);
  }
  async function request(body: object): Promise<unknown> {
    const proof = capability();
    if (!proof) throw new Error("Open the current server login link before managing phone push.");
    const response = await fetch("/push", { method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json", "x-pi-capability": proof }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(response.status === 401 ? "Open the current server login link before managing phone push." : response.status === 429 ? "Phone push is at its limit. Wait a minute before testing again." : "Phone push could not be updated. Retry; the previous subscription may still be active.");
    return response.json();
  }
  async function action(work: () => Promise<void>) {
    if (busy()) return;
    setBusy(true); setMessage("");
    try { await work(); } catch (error) { setMessage(error instanceof Error ? error.message : "Phone push is unavailable."); }
    finally { setBusy(false); }
  }
  /** Permission and registration occur only after this explicit user action. */
  function enable() { return action(async () => {
    if (!supported) throw new Error("Phone push needs a supported browser and HTTPS. Initially supported: Brave/Chromium on Android.");
    if (!capability()) throw new Error("Open the current server login link before enabling phone push.");
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") throw new Error("Allow notifications in browser site settings, then try again.");
    const secret = preference?.secret ?? Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
    remember({ secret, enabled: preference?.enabled ?? false });
    const setup = await request({ operation: "setup" });
    if (!setup || typeof setup !== "object" || !("publicKey" in setup) || typeof setup.publicKey !== "string" || !/^[\w-]{87}$/.test(setup.publicKey)) throw new Error("Invalid phone push configuration.");
    const key = Uint8Array.from(atob(setup.publicKey.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => {
        readyTimer = setTimeout(() => reject(new Error("The phone push worker did not become ready. Try again.")), 10000);
      })]);
    } finally { clearTimeout(readyTimer); }
    const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await request({ operation: "subscribe", secret, subscription: subscription.toJSON() });
    remember({ secret, enabled: true });
    setMessage("Phone push enabled for all folders and conversations on this server, for 30 days. Enable again to renew.");
  }); }
  /** Revokes this device on the server before removing the browser subscription. */
  function disable() { return action(async () => {
    if (!preference) return;
    await request({ operation: "remove", secret: preference.secret });
    remember({ secret: preference.secret, enabled: false });
    const registration = await navigator.serviceWorker.getRegistration("/");
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
    setMessage("Phone push disabled for this device.");
  }); }
  function test() { return action(async () => {
    if (!preference || !enabled()) return;
    await request({ operation: "test", secret: preference.secret });
    setMessage("Test requested. Delivery depends on your browser and phone settings.");
  }); }
  return { supported, enabled, busy, message, enable, disable, test };
}
