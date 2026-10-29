import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { SessionView } from "../src/SessionView";
import { createSessionModel, type SessionModel } from "../src/session-model";
import { initialState } from "../src/client-state";
import type { Activity } from "../src/generated/protocol";

const sessionId = "10000000-0000-4000-8000-000000000001";
const epoch = "20000000-0000-4000-8000-000000000001";
function session() {
  const model = createSessionModel(sessionId, () => true, () => true);
  model.receive({ v: 1, sessionId, epoch, body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId, epoch, body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false,
    status: { ...initialState().status, process: "ready", notice: "MCP connected\nLSP ready", error: "Keep this error" } } });
  return model;
}
function statusNotice(model: SessionModel, notice: string | null) {
  model.receive({ v: 1, sessionId, epoch, body: { type: "event", seq: model.state.seq + 1, patches: [], dialogs: [], olderHistory: false,
    status: { ...model.state.status, notice } } });
  flush();
}
function activity(model: SessionModel, activity: Activity) {
  model.receive({ v: 1, sessionId, epoch, body: { type: "event", seq: model.state.seq + 1, patches: [], dialogs: [], olderHistory: false,
    status: { ...model.state.status, activity, notice: null, error: null } } });
  flush();
}
afterEach(cleanup);

it("shows context usage beside persistence, updates it, and clears unavailable or stale usage", () => {
  const model = session();
  const view = render(() => <SessionView model={model} />); flush();
  model.receive({ v: 1, sessionId, epoch, body: { type: "event", seq: 1, patches: [], dialogs: [], olderHistory: false,
    status: { ...model.state.status, persistence: true } } }); flush();
  const footnote = view.container.querySelector(".composer-footnote")!;
  expect(footnote.textContent).toContain("Context —");
  const update = (tokens: number | null, contextWindow: number) => {
    model.receive({ v: 1, sessionId, epoch, body: { type: "context_usage", usage: { tokens, contextWindow } } });
    flush();
  };
  update(12500, 100000);
  expect(footnote.textContent).toContain("Saved by Pi");
  expect(footnote.textContent).toContain("Context 12.5%");
  update(0, 100000);
  expect(footnote.textContent).toContain("Context 0%");
  update(null, 100000);
  expect(footnote.textContent).toContain("Context —");
  update(50000, 100000);
  model.receive({ v: 1, sessionId, epoch: "new-epoch", body: { type: "hello", project: "fixture", process: "ready" } }); flush();
  expect(footnote.textContent).toContain("Context —");
});

it.each([
  ["submitting", "Sending…"],
  ["running", "Working…"],
  ["retrying", "Retrying…"],
  ["compacting", "Compacting context…"],
  ["reconciling", "Syncing…"],
  ["awaiting_input", "Waiting for your input"],
  ["cancelling", "Stopping…"],
] as const)("shows %s activity and clears it when the run finishes", (phase, label) => {
  const model = session();
  const view = render(() => <SessionView model={model} />); flush();
  activity(model, phase);
  expect(view.getByRole("status", { name: "Agent activity" }).textContent).toBe(label);
  activity(model, "idle");
  expect(view.queryByRole("status", { name: "Agent activity" })).toBeNull();
});

it("shows prompt submission immediately and hides stale activity after disconnection", () => {
  const model = session();
  const view = render(() => <SessionView model={model} />); flush();
  model.setDraft("Hello"); flush(); model.submit(); flush();
  expect(view.getByRole("status", { name: "Agent activity" }).textContent).toBe("Sending…");
  activity(model, "running");
  expect(view.getByRole("status", { name: "Agent activity" }).textContent).toBe("Working…");
  model.disconnected(); flush();
  expect(view.queryByRole("status", { name: "Agent activity" })).toBeNull();
});

it("hides the working indicator on failure or process exit", () => {
  const model = session();
  const view = render(() => <SessionView model={model} />); flush();
  activity(model, "running");
  expect(view.getByRole("status", { name: "Agent activity" })).toBeTruthy();
  activity(model, "failed");
  expect(view.queryByRole("status", { name: "Agent activity" })).toBeNull();
  activity(model, "running");
  model.stopped(); flush();
  expect(view.queryByRole("status", { name: "Agent activity" })).toBeNull();
});

it("dismisses status notices per session without hiding errors or later notices", () => {
  const model = session();
  const view = render(() => <SessionView model={model} />); flush();
  expect(view.getByRole("status").textContent).toContain("MCP connected");
  fireEvent.click(view.getByRole("button", { name: "Dismiss notice" })); flush();
  expect(view.queryByRole("status")).toBeNull();
  expect(view.getByRole("alert").textContent).toBe("Keep this error");
  statusNotice(model, "MCP connected\nLSP ready");
  expect(view.queryByRole("status")).toBeNull();
  cleanup();
  const remounted = render(() => <SessionView model={model} />); flush();
  expect(remounted.queryByRole("status")).toBeNull();
  statusNotice(model, "LSP restarted");
  expect(remounted.getByRole("status").textContent).toContain("LSP restarted");
  fireEvent.click(remounted.getByRole("button", { name: "Dismiss notice" })); flush();
  statusNotice(model, null);
  statusNotice(model, "LSP restarted");
  expect(remounted.getByRole("status").textContent).toContain("LSP restarted");
  cleanup();
  const otherModel = session();
  const other = render(() => <SessionView model={otherModel} />); flush();
  expect(other.getByRole("status").textContent).toContain("MCP connected");
});

it("dismisses a local notice without losing the underlying extension status", () => {
  const model = session(); model.setNotice("Attachment ended");
  const view = render(() => <SessionView model={model} />); flush();
  expect(view.getByRole("status").textContent).toContain("Attachment ended");
  fireEvent.click(view.getByRole("button", { name: "Dismiss notice" })); flush();
  expect(view.getByRole("status").textContent).toContain("MCP connected");
});

it("jumps to the latest transcript content and hides the jump button", () => {
  const model = session(); model.setStick(false);
  const view = render(() => <SessionView model={model} />); flush();
  const transcript = view.container.querySelector<HTMLDivElement>(".transcript")!;
  Object.defineProperty(transcript, "scrollHeight", { value: 2000 });
  fireEvent.click(view.getByRole("button", { name: "Jump to latest" })); flush();
  expect(transcript.scrollTop).toBe(2000);
  expect(model.stick()).toBe(true);
  expect(view.queryByRole("button", { name: "Jump to latest" })).toBeNull();
});
