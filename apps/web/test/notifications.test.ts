import { afterEach, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { createCompletionNotifications } from "../src/notifications";

function browser(permission: NotificationPermission = "default") {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const shown: { title: string; options: NotificationOptions; onclick?: () => void; close: () => void }[] = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => FakeNotification.permission = "granted" as const);
    onclick?: () => void;
    close = vi.fn();
    constructor(public title: string, public options: NotificationOptions) { shown.push(this); }
  }
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("isSecureContext", true);
  return { shown, FakeNotification };
}
afterEach(() => { flush(); vi.unstubAllGlobals(); });

it("requests permission only on opt-in and never exposes transcript contents", async () => {
  const { shown, FakeNotification } = browser();
  const select = vi.fn(); const notifications = createCompletionNotifications(select);
  notifications.completed("one", "success");
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled(); expect(shown).toHaveLength(0);
  await notifications.toggle();
  expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  notifications.completed("one", "success");
  expect(shown).toHaveLength(1);
  expect(shown[0].title).toBe("Pi finished");
  expect(shown[0].options.body).toBe("Your agent has finished its task.");
  notifications.dispose(); expect(shown[0].close).toHaveBeenCalled();
});

it("respects opt-out, denied permission, cancellation and unsupported browsers", async () => {
  const { shown, FakeNotification } = browser("granted");
  const notifications = createCompletionNotifications(() => {});
  await notifications.toggle();
  notifications.completed("one", "aborted"); expect(shown).toHaveLength(0);
  notifications.completed("one", "error"); expect(shown[0].title).toBe("Pi needs attention");
  await notifications.toggle(); notifications.completed("one", "success"); expect(shown).toHaveLength(1);
  FakeNotification.permission = "denied";
  await notifications.toggle(); expect(notifications.enabled()).toBe(false);
  vi.stubGlobal("Notification", undefined);
  const unsupported = createCompletionNotifications(() => {});
  expect(unsupported.supported).toBe(false);
  await unsupported.toggle(); unsupported.completed("one", "success");
});

it("closes only the removed conversation's notification", async () => {
  const { shown } = browser("granted");
  const notifications = createCompletionNotifications(() => {}); await notifications.toggle();
  notifications.completed("one", "success"); notifications.completed("two", "success");
  notifications.forget("one");
  expect(shown[0].close).toHaveBeenCalledOnce(); expect(shown[1].close).not.toHaveBeenCalled();
  notifications.dispose(); expect(shown[0].close).toHaveBeenCalledOnce(); expect(shown[1].close).toHaveBeenCalledOnce();
});

it("handles browser delivery failures without disrupting the conversation", async () => {
  browser("granted");
  const notifications = createCompletionNotifications(() => {}); await notifications.toggle();
  const Throws = Object.assign(function () { throw new TypeError("unsupported constructor"); }, { permission: "granted" });
  vi.stubGlobal("Notification", Throws);
  expect(() => notifications.completed("one", "success")).not.toThrow();
  flush();
  expect(notifications.enabled()).toBe(false);
  expect(notifications.message()).toContain("could not");
});
