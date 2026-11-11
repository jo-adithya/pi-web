import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { AskSelectionDialog } from "../src/components/AskSelectionDialog";
import { createSessionModel } from "../src/session-model";
import { initialState } from "../src/client-state";
import type { BrowserMessage } from "../src/generated/protocol";

function setup() {
  const transport = vi.fn((_message: BrowserMessage) => true);
  const model = createSessionModel("session", transport, () => true);
  model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } } });
  model.setDraft("My unsent work"); model.quoteReply({ author: "You", text: "A separate quote" }); flush();
  const close = vi.fn(), conversation = vi.fn();
  render(() => <AskSelectionDialog model={model} close={close} conversation={conversation} selection={{
    file: { path: "src/example.ts", status: "modified", patch: "unselected code", fingerprint: "snapshot", previousPath: null },
    target: { scope: "branch", base: "main" }, lines: [{ kind: "add", next: 12, text: "+selected code" }],
  }} />); flush();
  return { model, transport, close, conversation };
}
afterEach(cleanup);

it("renders the existing diff UI with original line coordinates for a selection", () => {
  setup();
  const diff = screen.getByRole("region", { name: "Diff for src/example.ts" });
  expect(diff.querySelector(".chat-review-line.add code")?.textContent).toBe("+selected code");
  expect(diff.querySelector('[title="New line"]')?.textContent).toBe("12");
  expect(diff.querySelector('[title="Old line"]')?.textContent).toBe("");
  expect(diff.textContent).not.toContain("unselected code");
});

it("explains collecting versus sending and shows the collected note count", () => {
  const { model, transport } = setup();
  const collect = screen.getByRole("button", { name: "Add feedback" });
  const send = screen.getByRole("button", { name: "Send to Pi" });
  expect(document.getElementById(collect.getAttribute("aria-describedby")!)?.textContent).toBe("Send together from Changes.");
  expect(document.getElementById(send.getAttribute("aria-describedby")!)?.textContent).toBe("Send this note now.");
  expect(screen.getByText("Your chat draft stays separate.")).toBeTruthy();
  expect((collect as HTMLButtonElement).disabled).toBe(true);
  fireEvent.input(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Keep the public API stable" } }); flush();
  fireEvent.click(collect); flush();
  expect(transport).not.toHaveBeenCalled();
  expect(model.feedback()).toHaveLength(1);
  expect(screen.getByText("1 note collected")).toBeTruthy();
});

it("puts changed code first and folds Git metadata behind an explicit control", () => {
  const model = createSessionModel("compact-preview", vi.fn(() => true), () => false);
  render(() => <AskSelectionDialog model={model} close={() => {}} conversation={() => {}} selection={{
    file: { path: "src/main.ts", previousPath: null, status: "modified", fingerprint: "one", patch: "diff --git a/src/main.ts b/src/main.ts\nindex abc..def 100644\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -8 +9 @@\n-old\n+new\n" },
    target: { scope: "unstaged" },
  }} />); flush();
  const preview = screen.getByLabelText("File changes");
  expect(preview.textContent).toContain("-old"); expect(preview.textContent).toContain("+new");
  expect(preview.textContent).not.toContain("index abc");
  const diff = screen.getByRole("region", { name: "Diff for src/main.ts" });
  expect(diff.querySelector('.remove [title="Old line"]')?.textContent).toBe("8");
  expect(diff.querySelector('.add [title="New line"]')?.textContent).toBe("9");
  fireEvent.click(screen.getByRole("button", { name: "Show Git metadata" })); flush();
  expect(preview.textContent).toContain("index abc");
  fireEvent.click(screen.getByRole("button", { name: "Hide Git metadata" })); flush();
  expect(preview.textContent).not.toContain("index abc");
});

it("requires an explicit question and send, includes only captured context and keeps the composer", () => {
  const { model, transport, close, conversation } = setup();
  const send = screen.getByRole("button", { name: "Send to Pi" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Explain change" })); flush();
  expect((screen.getByRole("textbox", { name: "Your question" }) as HTMLTextAreaElement).value).toContain("Explain this");
  expect(transport).not.toHaveBeenCalled();
  fireEvent.input(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Why is this needed?" } }); flush();
  fireEvent.click(send); flush();
  expect(transport).toHaveBeenCalledOnce();
  const action = transport.mock.calls[0][0].action;
  expect(action.type).toBe("prompt");
  if (action.type !== "prompt") throw new Error("Expected prompt");
  expect(action.text).toContain("Why is this needed?");
  expect(action.text).toContain('merge-base with "main"');
  expect(action.text).toContain("New lines: 12");
  expect(action.text).not.toContain("selected code");
  expect(action.text.startsWith("Why is this needed?\n\n")).toBe(true);
  expect(action.text).not.toMatch(/Review only|Do not edit files|read-only tools|Question:/);
  expect(action.text).not.toContain("unselected code");
  expect(action.text).not.toContain("My unsent work");
  expect(action.text).not.toContain("A separate quote");
  expect(model.draft()).toBe("My unsent work");
  expect(close).toHaveBeenCalledOnce(); expect(conversation).toHaveBeenCalledOnce();
});

it("collects feedback without sending and submits the notes as one request", () => {
  const { model, transport, close } = setup();
  fireEvent.input(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Keep this public API" } }); flush();
  fireEvent.click(screen.getByRole("button", { name: "Add feedback" })); flush();
  expect(transport).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  expect(model.feedback()).toHaveLength(1);
  fireEvent.input(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Also handle an empty result" } }); flush();
  fireEvent.click(screen.getByRole("button", { name: "Add feedback" })); flush();
  expect(model.submitFeedback()).toBe(true);
  expect(transport).toHaveBeenCalledOnce();
  const message = transport.mock.calls[0][0];
  expect(message.action).toMatchObject({ type: "prompt", text: expect.stringContaining("Keep this public API") });
  if (message.action.type !== "prompt") throw new Error("Expected prompt");
  expect(message.action.text).toContain("Also handle an empty result");
  expect(message.action.text).not.toContain("selected code");
  expect(model.feedback()).toHaveLength(2);
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "result", result: { requestId: message.requestId, ok: true, code: "accepted", disposition: "started", recoveredDraft: null } } }); flush();
  expect(model.feedback()).toHaveLength(0);
  expect(model.draft()).toBe("My unsent work");
});

it("keeps rejected feedback for retry and can send the batch as steering", () => {
  const { model, transport } = setup();
  fireEvent.input(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Preserve the API" } }); flush();
  fireEvent.click(screen.getByRole("button", { name: "Add feedback" })); flush();
  expect(model.submitFeedback()).toBe(true);
  const first = transport.mock.calls[0][0];
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "result", result: { requestId: first.requestId, ok: false, code: "busy", disposition: null, recoveredDraft: null } } }); flush();
  expect(model.feedback()).toHaveLength(1); expect(model.draft()).toBe("My unsent work");
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "event", seq: 1, patches: [], dialogs: [], olderHistory: false, status: { ...model.state.status, activity: "running" } } }); flush();
  expect(model.submitFeedback()).toBe(true);
  expect(transport.mock.calls[1][0].action.type).toBe("steer");
  model.disconnected(); flush();
  expect(model.feedback()).toHaveLength(1); expect(model.draft()).toBe("My unsent work");
});

it("keeps collection available while Pi is busy or the connection is offline", () => {
  const { model, transport } = setup();
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "event", seq: 1, patches: [], dialogs: [], olderHistory: false, status: { ...model.state.status, activity: "running" } } }); flush();
  fireEvent.input(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Keep this API stable" } }); flush();
  expect((screen.getByRole("button", { name: "Send to Pi" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("You can still collect feedback");
  fireEvent.click(screen.getByRole("button", { name: "Add feedback" })); flush();
  model.disconnected(); flush();
  fireEvent.input(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Handle empty results" } }); flush();
  expect(screen.getByRole("status").textContent).toContain("Reconnect to send");
  expect((screen.getByRole("button", { name: "Add feedback" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Add feedback" })); flush();
  expect(model.feedback()).toHaveLength(2);
  expect(screen.getByText("2 notes collected")).toBeTruthy();
  expect(transport).not.toHaveBeenCalled();
});

it("keeps a question editable when sending fails and disables sending when disconnected", () => {
  const { model, transport, close, conversation } = setup();
  fireEvent.input(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Keep this question" } }); flush();
  transport.mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Send to Pi" })); flush();
  expect(screen.getByRole("alert").textContent).toContain("Could not send");
  expect((screen.getByRole("textbox", { name: "Your question" }) as HTMLTextAreaElement).value).toBe("Keep this question");
  expect(close).not.toHaveBeenCalled(); expect(conversation).not.toHaveBeenCalled();
  model.disconnected(); flush();
  expect((screen.getByRole("button", { name: "Send to Pi" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("Reconnect");
});
