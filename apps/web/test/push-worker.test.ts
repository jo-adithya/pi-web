import source from "../public/sw.js?raw";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

type WorkerEvent = { waitUntil: (work: Promise<unknown>) => void; notification: { close: () => void }; data?: object };
function worker(windows: { url: string; focus: () => Promise<void> }[] = []) {
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const showNotification = vi.fn(async () => {}); const openWindow = vi.fn(async () => {});
  runInNewContext(source, { URL, self: {
    location: { origin: "https://pi.example" },
    registration: { showNotification },
    clients: { matchAll: async () => windows, openWindow },
    addEventListener: (name: string, handler: (event: WorkerEvent) => void) => handlers.set(name, handler),
  } });
  async function dispatch(name: string) {
    let work: Promise<unknown> | undefined;
    const close = vi.fn();
    handlers.get(name)!({ waitUntil: promise => { work = promise; }, notification: { close }, data: { url: "https://evil.example/#cap=secret", body: "PRIVATE" } });
    await work; return close;
  }
  return { handlers, dispatch, showNotification, openWindow };
}
it("shows only a generic notification, ignoring payload URLs and text, without fetch/cache handlers", async () => {
  const mock = worker(); await mock.dispatch("push");
  expect([...mock.handlers.keys()]).toEqual(["push", "notificationclick"]);
  expect(mock.showNotification).toHaveBeenCalledWith("Pi Web", { body: "A workspace task finished. Open Pi Web to review.", tag: "pi-web-workspace-completion" });
});
it("focuses only a same-origin window; otherwise opens a capability-free root", async () => {
  const other = { url: "https://evil.example/", focus: vi.fn(async () => {}) };
  const own = { url: "https://pi.example/", focus: vi.fn(async () => {}) };
  const existing = worker([other, own]); const close = await existing.dispatch("notificationclick");
  expect(close).toHaveBeenCalledOnce(); expect(own.focus).toHaveBeenCalledOnce(); expect(other.focus).not.toHaveBeenCalled(); expect(existing.openWindow).not.toHaveBeenCalled();
  const fresh = worker([other]); await fresh.dispatch("notificationclick"); expect(fresh.openWindow).toHaveBeenCalledWith("/");
});
