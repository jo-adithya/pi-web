import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
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
  fireEvent.click(view.getByRole("button", { name: /Refresh Codex usage/ })); expect(sent).toHaveLength(3);
  expect(view.container.textContent).toContain("5h 72% used · week 84% used");
  update({ ...usage, stale: true, unavailable: true }); expect(view.container.textContent).toContain("stale");
  expect(view.getByRole("button").title).toContain("Only a fresh reading confirms a reset");
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
  fireEvent.click(view.getByRole("button", { name: /Refresh Codex usage/ }));
  expect(sent).toHaveLength(2);
});
test("accessible usage name includes both window percentages", () => {
  const { model, update } = setup(); update(usage);
  const view = render(() => <CodexUsageFooter model={model} />); flush();
  expect(view.getByRole("button", { name: /5h 72% used · week 84% used/ })).toBeTruthy();
});
test("non-Codex and disconnected views hide prior quota and cannot request", () => {
  const { model, sent, update } = setup(); update(usage);
  model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "settings", settings: initialState().settings } });
  const view = render(() => <CodexUsageFooter model={model} />); flush();
  expect(sent).toHaveLength(0); expect(view.container.textContent).toBe("Codex unavailable");
  expect(view.getByRole("button").hasAttribute("disabled")).toBe(true);
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
