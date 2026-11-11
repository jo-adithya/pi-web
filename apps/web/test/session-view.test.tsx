import { afterEach, expect, it, vi } from "vitest";
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
afterEach(() => { cleanup(); vi.useRealTimers(); });

it.each([
  ["Explore this project", "Give me a tour of this project. Explain how it is organized, the main entry points, and where to start."],
  ["Plan a feature", "Help me plan a new feature. First, ask me what I want to build, then explore the relevant code before proposing a plan."],
  ["Find a bug", "Help me investigate a bug. Ask me about the expected behavior, what actually happens, and how to reproduce it."],
])("prepares %s in the composer without sending it", (label, prompt) => {
  const model = session();
  const view = render(() => <SessionView model={model} />); flush();
  fireEvent.click(view.getByRole("button", { name: new RegExp(label) })); flush();
  expect(model.draft()).toBe(prompt);
  expect(model.pending()).toBe(false);
  expect(document.activeElement).toBe(view.getByLabelText("Message Pi"));
});

it("keeps starter actions from replacing an existing draft", () => {
  const model = session();
  model.setDraft("My unfinished idea");
  const view = render(() => <SessionView model={model} />); flush();
  const starter = view.getByRole("button", { name: /Explore this project/ }) as HTMLButtonElement;
  expect(starter.disabled).toBe(true);
  fireEvent.click(starter); flush();
  expect(model.draft()).toBe("My unfinished idea");
});

it("opens local changes from the welcome screen without sending a prompt", () => {
  const model = session();
  const changes = vi.fn();
  const view = render(() => <SessionView model={model} changes={changes} />); flush();
  fireEvent.click(view.getByRole("button", { name: "Review local changes" })); flush();
  expect(changes).toHaveBeenCalledOnce();
  expect(model.draft()).toBe("");
  expect(model.pending()).toBe(false);
});

it("shows the original composer heading and preserves the editable draft", () => {
  const model = session();
  model.setDraft("My unfinished\nidea");
  const view = render(() => <SessionView model={model} />); flush();
  expect(view.getByText("Your next move")).toBeTruthy();
  const input = view.getByLabelText("Message Pi") as HTMLTextAreaElement;
  expect(input.value).toBe("My unfinished\nidea");
  fireEvent.input(input, { target: { value: "My revised\nidea" } }); flush();
  expect(model.draft()).toBe("My revised\nidea");
  expect(model.pending()).toBe(false);
});

it("omits recent-prompt controls while keeping conversation history visible", () => {
  const model = session();
  model.receive({ v: 1, sessionId, epoch, body: { type: "snapshot", throughSeq: 1, messages: [{ id: "previous", role: "user", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: "Previous question" }] }], dialogs: [], olderHistory: false, status: { ...model.state.status } } });
  const view = render(() => <SessionView model={model} />); flush();
  expect(view.queryByRole("button", { name: "Recent prompts" })).toBeNull();
  expect(view.getByText("Previous question")).toBeTruthy();
});

it("shows extension notices as transient toasts without hiding errors", () => {
  vi.useFakeTimers();
  const model = session(); flush();
  statusNotice(model, "Ponytail loaded: full");
  const view = render(() => <SessionView model={model} />); flush();
  const toast = view.getByRole("status").closest(".toast");
  expect(toast).not.toBeNull();
  expect(toast?.closest(".composer")).toBeNull();
  vi.advanceTimersByTime(5000); flush();
  expect(view.queryByText("Ponytail loaded: full")).toBeNull();
  expect(view.getByRole("alert").textContent).toBe("Keep this error");
  cleanup();
  const remounted = render(() => <SessionView model={model} />); flush();
  expect(remounted.queryByText("Ponytail loaded: full")).toBeNull();
  statusNotice(model, "Ponytail loaded: lite");
  expect(remounted.getByRole("status").textContent).toBe("Ponytail loaded: lite");
});

it("pauses toast dismissal for hover and focus and resets the timer for fresh notices", () => {
  vi.useFakeTimers();
  const model = session();
  const view = render(() => <SessionView model={model} />); flush();
  const toast = view.getByRole("status").closest(".toast")!;
  fireEvent.pointerEnter(toast);
  vi.advanceTimersByTime(6000); flush();
  expect(view.getByRole("status").textContent).toContain("MCP connected");
  fireEvent.focusIn(view.getByRole("button", { name: "Dismiss notice" }));
  fireEvent.pointerLeave(toast);
  vi.advanceTimersByTime(6000); flush();
  expect(view.getByRole("status")).toBeTruthy();
  fireEvent.focusOut(view.getByRole("button", { name: "Dismiss notice" }));
  vi.advanceTimersByTime(4000); flush();
  statusNotice(model, "Fresh notice");
  vi.advanceTimersByTime(1000); flush();
  expect(view.getByRole("status").textContent).toBe("Fresh notice");
  vi.advanceTimersByTime(4000); flush();
  expect(view.queryByRole("status")).toBeNull();
  statusNotice(model, "Unmounted notice");
  cleanup();
  vi.advanceTimersByTime(5000); flush();
  expect(model.visibleNotice()).toBe("Unmounted notice");
});

it("shows context usage beside LSP status, updates it, and clears unavailable or stale usage", () => {
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
  expect(footnote.textContent).not.toContain("Saved by Pi");
  expect(footnote.textContent).not.toContain("Closing this tab");
  expect(footnote.textContent).toContain("LSP —");
  expect(footnote.textContent).toContain("Context 12.5%");
  update(0, 100000);
  expect(footnote.textContent).toContain("Context 0%");
  update(null, 100000);
  expect(footnote.textContent).toContain("Context —");
  update(50000, 100000);
  model.receive({ v: 1, sessionId, epoch: "new-epoch", body: { type: "hello", project: "fixture", process: "ready" } }); flush();
  expect(footnote.textContent).toContain("Context —");
});

it("shows live LSP status and hides stale status while disconnected or stopped", () => {
  const model = session();
  const view = render(() => <SessionView model={model} />); flush();
  const update = (lspStatus: string | null) => {
    model.receive({ v: 1, sessionId, epoch, body: { type: "event", seq: model.state.seq + 1, patches: [], dialogs: [], olderHistory: false,
      status: { ...model.state.status, lspStatus } } }); flush();
  };
  const footnote = view.container.querySelector(".composer-footnote")!;
  update("LSP 1/2");
  expect(footnote.textContent).toContain("LSP 1/2");
  update("LSP 2/2");
  expect(footnote.textContent).toContain("LSP 2/2");
  update(null);
  expect(footnote.textContent).toContain("LSP —");
  update("LSP 2/2");
  model.disconnected(); flush();
  expect(footnote.textContent).not.toContain("LSP 2/2");
  model.stopped(); flush();
  expect(footnote.textContent).toContain("LSP —");
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

it.each(["submitting", "running", "retrying", "compacting", "reconciling", "awaiting_input", "cancelling"] as const)("replaces Send with Stop during %s and restores Send afterwards", phase => {
  const model = session();
  const view = render(() => <SessionView model={model} />); flush();
  expect(view.getByRole("button", { name: "Send" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  activity(model, phase);
  const stop = view.getByRole("button", { name: "Stop" }) as HTMLButtonElement;
  expect(view.queryByRole("button", { name: "Send" })).toBeNull();
  expect(stop.type).toBe("button");
  expect(stop.disabled).toBe(phase === "cancelling");
  activity(model, "idle");
  expect(view.getByRole("button", { name: "Send" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  activity(model, "failed");
  expect(view.getByRole("button", { name: "Send" })).toBeTruthy();
});

it.each([
  ["thinking", "Thinking…"], ["writing", "Writing…"], ["reading", "Reading files…"],
  ["editing", "Editing files…"], ["searching", "Searching…"], ["executing", "Running a command…"],
  ["researching", "Researching…"], ["checking", "Checking code…"], ["delegating", "Delegating work…"], ["tools", "Running tools…"],
] as const)("shows short %s progress without changing the draft or cancellation controls", (workPhase, label) => {
  const model = session(); model.setDraft("Keep my draft");
  const view = render(() => <SessionView model={model} />); flush();
  model.receive({ v: 1, sessionId, epoch, body: { type: "event", seq: model.state.seq + 1, patches: [], dialogs: [], olderHistory: false,
    status: { ...model.state.status, activity: "running", notice: null, ...{ workPhase } } } }); flush();
  expect(view.getByRole("status", { name: "Agent activity" }).textContent).toBe(label);
  expect(model.draft()).toBe("Keep my draft");
  expect(view.getByRole("button", { name: "Steer Pi" })).toBeTruthy();
  activity(model, "cancelling");
  expect(view.getByRole("status", { name: "Agent activity" }).textContent).toBe("Stopping…");
  activity(model, "idle");
  expect(view.queryByRole("status", { name: "Agent activity" })).toBeNull();
});

it("hides stale work labels until a reconnect snapshot confirms the current phase", () => {
  const model = session();
  const view = render(() => <SessionView model={model} />); flush();
  model.receive({ v: 1, sessionId, epoch, body: { type: "event", seq: model.state.seq + 1, patches: [], dialogs: [], olderHistory: false,
    status: { ...model.state.status, activity: "running", notice: null, workPhase: "reading" } } }); flush();
  expect(view.getByRole("status", { name: "Agent activity" }).textContent).toBe("Reading files…");
  model.receive({ v: 1, sessionId, epoch, body: { type: "hello", project: "fixture", process: "ready" } }); flush();
  expect(view.queryByRole("status", { name: "Agent activity" })).toBeNull();
  model.receive({ v: 1, sessionId, epoch, body: { type: "snapshot", throughSeq: model.state.seq + 1, messages: [], dialogs: [], olderHistory: false,
    status: { ...model.state.status, activity: "running", workPhase: "executing" } } }); flush();
  expect(view.getByRole("status", { name: "Agent activity" }).textContent).toBe("Running a command…");
});

it("shows formatting as a distinct phase until the answer is ready", () => {
  const model = session();
  const view = render(() => <SessionView model={model} />); flush();
  model.receive({ v: 1, sessionId, epoch, body: { type: "event", seq: model.state.seq + 1, patches: [{ kind: "message", message: {
    id: "formatting", role: "assistant", complete: true, truncated: false, error: null, blocks: [], presentation: { state: "pending" },
  } }], dialogs: [], olderHistory: false, status: { ...model.state.status, activity: "idle", notice: null } } }); flush();
  expect(view.getByRole("status", { name: "Agent activity" }).textContent).toBe("Preparing your answer…");
  model.receive({ v: 1, sessionId, epoch, body: { type: "event", seq: model.state.seq + 1, patches: [{ kind: "message", message: {
    id: "formatting", role: "assistant", complete: true, truncated: false, error: null, blocks: [], presentation: { state: "ready", response: { summary: "Done.", blocks: [] } },
  } }], dialogs: [], olderHistory: false, status: { ...model.state.status } } }); flush();
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

it("dismisses warnings and errors independently without changing server status", () => {
  const model = session(); flush();
  model.receive({ v: 1, sessionId, epoch, body: { type: "event", seq: 1, patches: [], dialogs: [], olderHistory: false,
    status: { ...model.state.status, historyWarning: "History incomplete" } } });
  const view = render(() => <SessionView model={model} />); flush();
  fireEvent.click(view.getAllByRole("button", { name: "Dismiss warning" })[0]); flush();
  expect(view.queryByText("History incomplete")).toBeNull();
  expect(view.getByRole("alert").textContent).toBe("Keep this error");
  fireEvent.click(view.getByRole("button", { name: "Dismiss warning" })); flush();
  expect(view.queryByRole("alert")).toBeNull();
  expect(model.state.status.error).toBe("Keep this error");
  statusNotice(model, "Another notice");
  expect(view.queryByRole("alert")).toBeNull();
  model.receive({ v: 1, sessionId, epoch, body: { type: "event", seq: model.state.seq + 1, patches: [], dialogs: [], olderHistory: false,
    status: { ...model.state.status, error: null } } }); flush();
  model.receive({ v: 1, sessionId, epoch, body: { type: "event", seq: model.state.seq + 1, patches: [], dialogs: [], olderHistory: false,
    status: { ...model.state.status, error: "Keep this error" } } }); flush();
  expect(view.getByRole("alert").textContent).toBe("Keep this error");
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
  const transcript = document.documentElement;
  Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 2000 });
  fireEvent.click(view.getByRole("button", { name: "Jump to latest" })); flush();
  expect(transcript.scrollTop).toBe(2000);
  expect(model.stick()).toBe(true);
  expect(view.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  Reflect.deleteProperty(transcript, "scrollHeight");
  transcript.scrollTop = 0;
});

it("keeps background agents visible after main activity settles", () => {
  const model = session();
  const view = render(() => <SessionView model={model} />); flush();
  activity(model, "running");
  model.receive({ v: 1, sessionId, epoch, body: { type: "background_tasks", tasks: [
    { id: "agent", kind: "agent", name: "Scout", description: "Inspect", status: "active", result: null, error: null, truncated: false },
  ] } }); flush();
  const working = view.getByRole("status", { name: "Agent activity" });
  const tasks = view.getByRole("button", { name: "Agents" });
  expect(working.parentElement?.classList.contains("composer-activity")).toBe(true);
  expect(tasks.closest(".composer-activity")).toBe(working.parentElement);
  expect(tasks.compareDocumentPosition(working) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  activity(model, "idle");
  expect(view.queryByRole("status", { name: "Agent activity" })).toBeNull();
  const background = view.getByRole("button", { name: "Agents" });
  expect(background.title).toContain("1 queued / running");
  expect(background.getAttribute("aria-expanded")).toBe("false");
});
