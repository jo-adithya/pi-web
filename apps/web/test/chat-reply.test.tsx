import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { MessageList } from "../src/Conversation";
import { SessionView } from "../src/SessionView";
import { createSessionModel } from "../src/session-model";
import { initialState } from "../src/client-state";
import type { BrowserMessage } from "../src/generated/protocol";

beforeEach(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [{ left: 40, right: 240, top: 120, bottom: 140, width: 200, height: 20 }] });
});
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); Reflect.deleteProperty(Range.prototype, "getClientRects"); vi.restoreAllMocks(); });
function transcript() {
  const state = initialState(); state.order = ["answer", "question"];
  state.messages.answer = { id: "answer", role: "assistant", blocks: [{ kind: "text", text: "Keep the public interface stable." }], complete: true, error: null, truncated: false };
  state.messages.question = { id: "question", role: "user", blocks: [{ kind: "text", text: "What about the tests?" }], complete: true, error: null, truncated: false };
  return state;
}
function selectText(element: Element) {
  const range = document.createRange(); range.selectNodeContents(element);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  fireEvent(document, new Event("selectionchange")); flush();
}
it("offers Reply on selected message text and passes only the selection with its author", () => {
  const reply = vi.fn();
  const view = render(() => <MessageList state={transcript()} onReply={reply} />); flush();
  expect(view.queryByRole("button", { name: "Reply to selection" })).toBeNull();
  selectText(view.getByText("Keep the public interface stable."));
  fireEvent.click(view.getByRole("button", { name: "Reply to selection" })); flush();
  expect(reply).toHaveBeenCalledExactlyOnceWith({ author: "Pi", text: "Keep the public interface stable." });
  expect(view.queryByRole("button", { name: "Reply to selection" })).toBeNull();
});

it("supports partial user selections and ignores cross-message or non-message selections", () => {
  const reply = vi.fn();
  const view = render(() => <><MessageList state={transcript()} onReply={reply} /><p>Outside transcript</p></>); flush();
  const question = view.getByText("What about the tests?");
  const selection = window.getSelection()!;
  const range = document.createRange(); range.setStart(question.firstChild!, 5); range.setEnd(question.firstChild!, 10);
  selection.addRange(range); fireEvent(document, new Event("selectionchange")); flush();
  fireEvent.click(view.getByRole("button", { name: "Reply to selection" })); flush();
  expect(reply).toHaveBeenCalledExactlyOnceWith({ author: "You", text: "about" });
  range.setStart(view.getByText("Keep the public interface stable.").firstChild!, 0); range.setEnd(question.firstChild!, 10);
  selection.removeAllRanges(); selection.addRange(range); fireEvent(document, new Event("selectionchange")); flush();
  expect(view.queryByRole("button", { name: "Reply to selection" })).toBeNull();
  selectText(view.getByText("Outside transcript"));
  expect(view.queryByRole("button", { name: "Reply to selection" })).toBeNull();
  selectText(view.getByRole("heading", { name: "Pi" }));
  expect(view.queryByRole("button", { name: "Reply to selection" })).toBeNull();
});

it("accepts paragraph selection ending just before the next message's heading", () => {
  const reply = vi.fn();
  const view = render(() => <MessageList state={transcript()} onReply={reply} />); flush();
  const range = document.createRange();
  range.setStart(view.getByText("Keep the public interface stable.").firstChild!, 0);
  range.setEnd(view.getByRole("heading", { name: "You" }), 0);
  window.getSelection()!.addRange(range); fireEvent(document, new Event("selectionchange")); flush();
  fireEvent.click(view.getByRole("button", { name: "Reply to selection" }));
  expect(reply).toHaveBeenCalledExactlyOnceWith({ author: "Pi", text: "Keep the public interface stable." });
});

it("quotes across code copy controls without including their labels", () => {
  const reply = vi.fn();
  const state = transcript();
  state.messages.answer.blocks = [{ kind: "text", text: "Before\n\n```sh\nprintf x\n```\n\nAfter" }];
  const view = render(() => <MessageList state={state} onReply={reply} />); flush();
  selectText(view.container.querySelector(".message-text")!);
  fireEvent.click(view.getByRole("button", { name: "Reply to selection" })); flush();
  const quote = reply.mock.calls[0][0];
  expect(quote.author).toBe("Pi");
  expect(quote.text).toContain("printf x\n");
  expect(quote.text).toContain("Before");
  expect(quote.text).toContain("After");
  expect(quote.text).not.toContain("Copy");
});

it("dismisses without clearing native selection and allows selecting the same text again", () => {
  const view = render(() => <MessageList state={transcript()} onReply={() => {}} />); flush();
  const text = view.getByText("Keep the public interface stable.");
  selectText(text); fireEvent.keyDown(document, { key: "Escape" }); flush();
  expect(view.queryByRole("button", { name: "Reply to selection" })).toBeNull();
  expect(window.getSelection()?.toString()).toBe(text.textContent);
  fireEvent(document, new Event("selectionchange")); flush();
  expect(view.queryByRole("button", { name: "Reply to selection" })).toBeNull();
  window.getSelection()?.removeAllRanges(); fireEvent(document, new Event("selectionchange")); flush();
  selectText(text);
  expect(view.getByRole("button", { name: "Reply to selection" })).toBeTruthy();
});

it("waits for mouse selection to finish and cleans up its document listeners", () => {
  const view = render(() => <MessageList state={transcript()} onReply={() => {}} />); flush();
  const text = view.getByText("Keep the public interface stable.");
  const down = new MouseEvent("pointerdown", { bubbles: true, button: 0 });
  Object.defineProperty(down, "pointerType", { value: "mouse" });
  fireEvent(text, down); selectText(text);
  expect(view.queryByRole("button", { name: "Reply to selection" })).toBeNull();
  fireEvent.pointerUp(document); flush();
  expect(view.getByRole("button", { name: "Reply to selection" })).toBeTruthy();
  const remove = vi.spyOn(document, "removeEventListener");
  view.unmount();
  expect(remove).toHaveBeenCalledWith("selectionchange", expect.any(Function));
  expect(remove).toHaveBeenCalledWith("pointerup", expect.any(Function));
  expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
});

it("shows a removable quote above the unchanged draft and sends only on submit", () => {
  const width = vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
  const transport = vi.fn((_message: BrowserMessage) => true);
  const model = createSessionModel("chat", transport, () => true);
  model.receive({ v: 1, sessionId: "chat", epoch: "one", body: { type: "hello", project: "fixture", process: "ready" } });
  const state = transcript();
  model.receive({ v: 1, sessionId: "chat", epoch: "one", body: { type: "snapshot", throughSeq: 0,
    messages: state.order.map(id => state.messages[id]), dialogs: [], olderHistory: false,
    status: { ...state.status, process: "ready" } } });
  model.setDraft("Explain this choice");
  const view = render(() => <SessionView model={model} />); flush();
  selectText(view.getByText("Keep the public interface stable."));
  expect(view.getByRole("button", { name: "Reply to selection" }).closest(".composer")).toBeTruthy();
  width.mockReturnValue(1024); fireEvent(window, new Event("resize")); flush();
  expect(view.getByRole("button", { name: "Reply to selection" }).closest(".composer")).toBeNull();
  width.mockReturnValue(390); fireEvent(window, new Event("resize")); flush();
  expect(view.queryByRole("button", { name: "Dismiss reply action" })).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" }); flush();
  expect(view.queryByRole("button", { name: "Reply to selection" })).toBeNull();
  expect(window.getSelection()?.toString()).toBe("Keep the public interface stable.");
  window.getSelection()?.removeAllRanges(); fireEvent(document, new Event("selectionchange")); flush();
  selectText(view.getByText("Keep the public interface stable."));
  const reply = view.getByRole("button", { name: "Reply to selection" });
  expect(reply.closest(".composer")).toBeTruthy();
  expect(reply.textContent).toBe("Reply");
  fireEvent.click(reply); flush();
  const quote = view.getByRole("region", { name: "Quoted message" });
  expect(quote.textContent).not.toContain("Replying to");
  expect(quote.querySelector("blockquote")?.textContent).toBe("Keep the public interface stable.");
  const editor = view.getByRole("combobox", { name: "Message Pi" }) as HTMLTextAreaElement;
  expect(editor.value).toBe("Explain this choice"); expect(document.activeElement).toBe(editor);
  expect(transport).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Remove quote" })); flush();
  expect(view.queryByRole("region", { name: "Quoted message" })).toBeNull();
  expect(editor.value).toBe("Explain this choice");
  selectText(view.getByText("What about the tests?"));
  fireEvent.click(view.getByRole("button", { name: "Reply to selection" })); flush();
  expect(view.getByRole("region", { name: "Quoted message" }).textContent).not.toContain("Replying to");
  fireEvent.click(view.getByRole("button", { name: "Send" })); flush();
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0]?.[0]).toMatchObject({ action: { type: "prompt", text: "> What about the tests?\n\nExplain this choice" } });
});
