import { createSignal } from "solid-js";

const preferenceKey = "pi-web.notifications.v1";

/** Page-owned, opt-in desktop notifications; messages never include conversation contents.
 * Requires an open, connected tab and browser permission. No background push service is used.
 */
export function createCompletionNotifications(select: (sessionId: string) => void) {
  const supported = typeof Notification !== "undefined" && globalThis.isSecureContext;
  let saved = false;
  try { saved = window.localStorage.getItem(preferenceKey) === "enabled"; } catch { /* Use a page-local preference when storage is unavailable. */ }
  const [enabled, setEnabled] = createSignal(Boolean(supported && saved && Notification.permission === "granted"));
  const [message, setMessage] = createSignal("");
  const active = new Map<string, Notification>();
  let disposed = false;
  function remember(value: boolean) {
    setEnabled(value);
    try { window.localStorage.setItem(preferenceKey, value ? "enabled" : "disabled"); } catch { /* The page-local preference remains usable. */ }
  }
  /** Permission prompts are issued only by this explicit user action. */
  async function toggle() {
    setMessage("");
    if (enabled()) { remember(false); for (const notification of active.values()) notification.close(); active.clear(); return; }
    if (!supported) { setMessage("Desktop notifications are unavailable in this browser. Use HTTPS or localhost."); return; }
    try {
      const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      if (disposed) return;
      remember(permission === "granted");
      if (permission !== "granted") setMessage("Notifications are not enabled. Allow them in your browser’s site settings, then try again.");
    } catch { setMessage("This browser could not enable desktop notifications."); }
  }
  function completed(sessionId: string, outcome: "success" | "error" | "aborted") {
    if (disposed || !enabled() || !supported || Notification.permission !== "granted" || outcome === "aborted") return;
    try {
      active.get(sessionId)?.close();
      const notification = new Notification(outcome === "success" ? "Pi finished" : "Pi needs attention", {
        body: outcome === "success" ? "Your agent has finished its task." : "Your agent finished with an error. Open Pi to review it.",
        tag: `pi-web-${sessionId}`,
      });
      active.set(sessionId, notification);
      notification.onclick = () => { if (!disposed) { window.focus(); select(sessionId); } notification.close(); };
      notification.onclose = () => { if (active.get(sessionId) === notification) active.delete(sessionId); };
    } catch {
      remember(false); setMessage("This browser could not display desktop notifications. Notifications have been turned off.");
    }
  }
  /** Closes the notification for a conversation removed from the catalog. */
  function forget(sessionId: string) { active.get(sessionId)?.close(); active.delete(sessionId); }
  function dispose() { disposed = true; for (const notification of active.values()) notification.close(); active.clear(); }
  return { enabled, message, supported, toggle, completed, forget, dispose };
}
