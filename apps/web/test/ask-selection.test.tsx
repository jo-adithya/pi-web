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
