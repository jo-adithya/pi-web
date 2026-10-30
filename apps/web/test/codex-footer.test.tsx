import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { CodexUsageFooter } from "../src/components/CodexUsageFooter";
import { createSessionModel } from "../src/session-model";
import { initialState, decodeServer, applyServer } from "../src/client-state";
import type { BrowserMessage, CodexUsage } from "../src/generated/protocol";
const usage: CodexUsage = { windows: [{ identity: "primary", durationSeconds: 18000, usedPercent: 72, resetsAt: 1800003600 }, { identity: "secondary", durationSeconds: 604800, usedPercent: 84, resetsAt: 1800086400 }], observedAt: 1800000000, stale: false, loading: false, unavailable: false };
function setup() {
  const sent: BrowserMessage[] = [];
  const model = createSessionModel("session", message => { sent.push(message); return true; }, () => true);
  model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "hello", process: "ready", project: "test" } });
  model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready", activity: "running" } } });
  model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "settings", settings: { ...initialState().settings, model: { id: "codex", name: "Codex", provider: "openai-codex", images: true } } } });
  const update = (value: CodexUsage) => { model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "codex_usage", usage: value } }); flush(); };
  return { model, sent, update };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
test("opening, returning visible and tap refresh even while busy; timers and quota updates never poll", async () => {
  vi.useFakeTimers(); vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const { model, sent, update } = setup();
  const view = render(() => <CodexUsageFooter model={model} />); flush();
  expect(sent.map(m => m.action.type)).toEqual(["refresh_codex_usage"]);
  update(usage); update({ ...usage, loading: true }); update(usage);
  await vi.advanceTimersByTimeAsync(30 * 60_000); flush(); expect(sent).toHaveLength(1);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange")); expect(sent).toHaveLength(1);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange")); expect(sent).toHaveLength(2);
  fireEvent.click(view.getByRole("button", { name: /View Codex usage/ })); flush(); expect(sent).toHaveLength(3);
  expect(view.container.textContent).toContain("5h 72% used · week 84% used");
  update({ ...usage, stale: true, unavailable: true }); expect(view.container.textContent).toContain("stale");
  expect(screen.getByRole("dialog").textContent).toContain("showing the last successful reading");
  view.unmount(); document.dispatchEvent(new Event("visibilitychange")); expect(sent).toHaveLength(3);
  render(() => <CodexUsageFooter model={model} />); flush(); expect(sent).toHaveLength(4);
});
test("reconnecting does not automatically retry usage refresh; tapping refreshes", () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const { model, sent } = setup();
  const view = render(() => <CodexUsageFooter model={model} />); flush();
  expect(sent).toHaveLength(1);
  model.disconnected(); flush();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange"));
  expect(sent).toHaveLength(1);
  const resnapshot = () => {
    model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } } }); flush();
  };
  resnapshot(); expect(sent).toHaveLength(1);
  resnapshot(); expect(sent).toHaveLength(1);
  fireEvent.click(view.getByRole("button", { name: /View Codex usage/ }));
  expect(sent).toHaveLength(2);
});
test("accessible usage name includes both window percentages", () => {
  const { model, update } = setup(); update(usage);
  const view = render(() => <CodexUsageFooter model={model} />); flush();
  expect(view.getByRole("button", { name: /5h 72% used · week 84% used/ })).toBeTruthy();
});
test("refreshing keeps the footer summary stable and exposes a busy pulse indicator", () => {
  const { model, update } = setup(); update(usage);
  const view = render(() => <CodexUsageFooter model={model} />); flush();
  const trigger = view.getByRole("button", { name: /View Codex usage/ });
  const summary = trigger.textContent;
  update({ ...usage, loading: true });
  expect(trigger.textContent).toBe(summary);
  expect(trigger.getAttribute("aria-busy")).toBe("true");
  expect(within(trigger).getByTitle("Refreshing usage")).toBeTruthy();
  update(usage);
  expect(trigger.getAttribute("aria-busy")).toBe("false");
  expect(within(trigger).queryByTitle("Refreshing usage")).toBeNull();
});
test("non-Codex and disconnected views hide prior quota and cannot request", () => {
  const { model, sent, update } = setup(); update(usage);
  model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "settings", settings: initialState().settings } });
  const view = render(() => <CodexUsageFooter model={model} />); flush();
  expect(sent).toHaveLength(0); expect(view.container.textContent).toBe("Codex unavailable");
  expect(view.getByRole("button").hasAttribute("disabled")).toBe(true);
});
test("footer opens an accessible popover with usage bars, remaining quota and reset countdowns", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1800000000 * 1000);
  const { model, update, sent } = setup();
  update({ ...usage, windows: [usage.windows[0]!, { ...usage.windows[1]!, resetsAt: 1800183600 }] });
  const view = render(() => <><button>Outside</button><CodexUsageFooter model={model} /></>); flush();
  const trigger = view.getByRole("button", { name: /View Codex usage/ });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(trigger); flush();
  const dialog = screen.getByRole("dialog", { name: "Codex usage" });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(dialog.textContent).not.toContain("Your subscription usage limits.");
  const shortBar = within(dialog).getByRole("progressbar", { name: "5h usage" }) as HTMLProgressElement;
  const weekBar = within(dialog).getByRole("progressbar", { name: "Weekly usage" }) as HTMLProgressElement;
  expect(shortBar.value).toBe(72); expect(shortBar.max).toBe(100); expect(weekBar.value).toBe(84);
  expect(dialog.textContent).toContain("28% remaining"); expect(dialog.textContent).toContain("16% remaining");
  expect(dialog.textContent).toContain("Resets in 1 hour"); expect(dialog.textContent).toContain("Resets in 2 days, 3 hours");
  fireEvent.click(within(dialog).getByRole("button", { name: "Refresh usage" })); expect(sent).toHaveLength(3);
  fireEvent.keyDown(dialog, { key: "Escape" }); flush();
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger); flush();
  // The interaction primitive defers listener installation past the opening pointer event.
  await vi.advanceTimersByTimeAsync(0);
  fireEvent.pointerDown(view.getByRole("button", { name: "Outside" })); flush();
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
test.each([
  [1800000060, "Resets in 1 minute"],
  [1800000090, "Resets in 2 minutes"],
  [1800003600, "Resets in 1 hour"],
  [1800007260, "Resets in 2 hours, 1 minute"],
  [1800086400, "Resets in 1 day"],
  [1800000000, "Reset pending"],
  [1799999999, "Reset pending"],
])("reset timestamp %i has an honest countdown", (resetsAt, expected) => {
  vi.useFakeTimers(); vi.setSystemTime(1800000000 * 1000);
  const { model, update } = setup(); update({ ...usage, windows: [{ ...usage.windows[0]!, resetsAt }] });
  const view = render(() => <CodexUsageFooter model={model} />); flush();
  fireEvent.click(view.getByRole("button", { name: /View Codex usage/ })); flush();
  expect(screen.getByRole("dialog").textContent).toContain(expected);
  expect((screen.getByRole("progressbar") as HTMLProgressElement).value).toBe(72);
});
test("open countdown ticks without fetching, and a passed deadline never fabricates unused quota", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1800000000 * 1000);
  const { model, update, sent } = setup();
  update({ ...usage, windows: [{ ...usage.windows[0]!, resetsAt: 1800000060 }] });
  const view = render(() => <CodexUsageFooter model={model} />); flush();
  fireEvent.click(view.getByRole("button", { name: /View Codex usage/ })); flush();
  await vi.advanceTimersByTimeAsync(60_000); flush();
  expect(screen.getByRole("dialog").textContent).toContain("Reset pending");
  expect(screen.getByRole("dialog").textContent).toContain("Refresh to confirm");
  expect((screen.getByRole("progressbar") as HTMLProgressElement).value).toBe(72);
  expect(sent).toHaveLength(2);
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
test("loading, unavailable and stale readings remain understandable and refreshable", async () => {
  const { model, update, sent } = setup(); update({ ...usage, windows: [], loading: true, observedAt: null });
  const view = render(() => <CodexUsageFooter model={model} />); flush();
  fireEvent.click(view.getByRole("button", { name: /View Codex usage/ })); flush();
  expect(screen.getByRole("dialog").textContent).toContain("Loading usage");
  expect(screen.getByRole("button", { name: "Refreshing…" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("progressbar")).toBeNull();
  update({ ...usage, windows: [], unavailable: true, observedAt: null });
  expect(screen.getByRole("dialog").textContent).toContain("Usage unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Refresh usage" })); expect(sent).toHaveLength(3);
  update({ ...usage, stale: true, unavailable: true });
  expect(screen.getByRole("dialog").textContent).toContain("showing the last successful reading");
  expect(screen.getAllByRole("progressbar")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Close usage details" })); flush();
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
test("disconnecting closes the popover and hides cached usage", async () => {
  const { model, update } = setup(); update(usage);
  const view = render(() => <CodexUsageFooter model={model} />); flush();
  fireEvent.click(view.getByRole("button", { name: /View Codex usage/ })); flush();
  model.disconnected(); flush();
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(view.getByRole("button").hasAttribute("disabled")).toBe(true);
  expect(view.container.textContent).toBe("Codex unavailable");
});
test("quota decoder enforces limits and epoch reset drops the cached value", () => {
  const state = initialState(); state.sessionId = "session"; state.epoch = "epoch";
  const frame = (value: unknown) => JSON.stringify({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "codex_usage", usage: value } });
  applyServer(state, decodeServer(frame(usage))); expect(state.codexUsage).toEqual(usage);
  expect(() => decodeServer(frame({ ...usage, windows: [{ ...usage.windows[0], usedPercent: 101 }] }))).toThrow();
  expect(() => decodeServer(frame({ ...usage, windows: [usage.windows[0], usage.windows[0], usage.windows[0]] }))).toThrow();
  applyServer(state, { v: 1, sessionId: "session", epoch: "new", body: { type: "hello", project: "test", process: "ready" } });
  expect(state.codexUsage).toBeNull();
});
