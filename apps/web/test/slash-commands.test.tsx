import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { SessionView } from "../src/SessionView";
import { createSessionModel } from "../src/session-model";
import { initialState } from "../src/client-state";
import type { ServerMessage, SlashCommand } from "../src/generated/protocol";

const commands: SlashCommand[] = [
  { name: "review", description: "Review changes", source: "prompt" },
  { name: "release", description: "Prepare a release", source: "extension" },
  { name: "skill:testing", description: null, source: "skill" },
];
afterEach(cleanup);
function setup() {
  const transport = vi.fn(() => true);
  const model = createSessionModel("app", transport, () => true);
  const receive = (body: ServerMessage["body"], epoch = "e1") => { model.receive({ v: 1, sessionId: "app", epoch, body }); flush(); };
  receive({ type: "hello", project: "fixture", process: "ready" });
  receive({ type: "snapshot", throughSeq: 0, status: { ...initialState().status, process: "ready" }, messages: [], dialogs: [], olderHistory: false });
  receive({ type: "commands", commands });
  const page = render(() => <SessionView model={model} />);
  const input = page.getByLabelText("Message Pi") as HTMLTextAreaElement;
  function type(value: string, caret = value.length) {
    input.focus(); fireEvent.input(input, { target: { value, selectionStart: caret, selectionEnd: caret } }); flush();
  }
  function key(key: string, options = {}) { fireEvent.keyDown(input, { key, ...options }); flush(); }
  return { page, input, type, key, transport, receive, model };
}

it("filters loaded commands, shows descriptions and inserts with keyboard without sending", () => {
  const { page, input, type, key, transport } = setup();
  type("/re");
  expect(within(page.getByRole("listbox")).getAllByRole("option")).toHaveLength(2);
  expect(page.getByText("Review changes")).toBeTruthy();
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toContain("/review");
  key("ArrowDown");
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toContain("/release");
  expect(within(page.getByRole("listbox")).getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
  key("Enter");
  expect(input.value).toBe("/release ");
  expect(transport).not.toHaveBeenCalled();
  expect(page.queryByRole("listbox")).toBeNull();
  key("Enter");
  expect(transport).toHaveBeenCalledWith(expect.objectContaining({ action: { type: "prompt", text: "/release ", images: [] } }));
});

it("sends with Enter but preserves Shift+Enter and IME input", () => {
  const { input, type, key, transport } = setup();
  type("Hello");
  expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
  expect(transport).not.toHaveBeenCalled();
  type("Hello\nworld");
  key("Enter");
  expect(transport).toHaveBeenCalledWith(expect.objectContaining({ action: { type: "prompt", text: "Hello\nworld", images: [] } }));
});

it.each([{ ctrlKey: true }, { metaKey: true }])("preserves the modified Enter send shortcut: %j", modifiers => {
  const { type, key, transport } = setup();
  type("/re"); key("Enter", modifiers);
  expect(transport).toHaveBeenCalledWith(expect.objectContaining({ action: { type: "prompt", text: "/re", images: [] } }));
});

it("does not send empty, busy or disconnected drafts on Enter", () => {
  const { type, key, transport, receive, model } = setup();
  key("Enter");
  type("Hello");
  receive({ type: "event", seq: 1, patches: [], status: { ...initialState().status, process: "ready", activity: "running" }, dialogs: [], olderHistory: false });
  key("Enter");
  model.disconnected(); flush(); key("Enter");
  expect(transport).not.toHaveBeenCalled();
});

it("supports Tab, wraparound navigation and pointer selection while preserving arguments", () => {
  const { page, input, type, key, transport } = setup();
  type("/re security", 3); key("ArrowUp"); key("Tab");
  expect(input.value).toBe("/release security");
  expect(input.selectionStart).toBe(9);
  type("/skill:");
  const option = within(page.getByRole("listbox")).getByRole("option");
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
  fireEvent.mouseDown(option);
  fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 });
  fireEvent.click(option); flush();
  expect(input.value).toBe("/skill:testing ");
  expect(input).toBe(document.activeElement);
  expect(transport).not.toHaveBeenCalled();
});

it("inserts a non-highlighted suggestion by pointer and keeps the argument caret", () => {
  const { page, input, type, transport } = setup();
  type("/re security", 3);
  const option = within(page.getByRole("listbox")).getAllByRole("option")[1];
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
  fireEvent.mouseDown(option);
  fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 });
  fireEvent.click(option); flush();
  expect(input.value).toBe("/release security");
  expect(input.selectionStart).toBe(9);
  expect(document.activeElement).toBe(input);
  expect(page.queryByRole("listbox")).toBeNull();
  expect(transport).not.toHaveBeenCalled();
});

it("dismisses on Escape or blur and leaves arguments, prose, modified keys and IME alone", () => {
  const { page, input, type, key, transport } = setup();
  type("/re"); key("Escape"); expect(page.queryByRole("listbox")).toBeNull();
  type("/rev"); expect(page.getByRole("listbox")).toBeTruthy();
  key("Enter", { isComposing: true }); expect(input.value).toBe("/rev");
  key("Enter", { shiftKey: true }); expect(input.value).toBe("/rev");
  key("Tab", { shiftKey: true }); expect(input.value).toBe("/rev");
  fireEvent.blur(input); flush(); expect(page.queryByRole("listbox")).toBeNull();
  for (const value of ["hello /re", "/review security", "/unknown", "text\n/re"]) {
    type(value); expect(page.queryByRole("listbox")).toBeNull();
  }
  expect(transport).not.toHaveBeenCalled();
});

it("hides completion when disconnected or busy and clears command data on a new epoch", () => {
  const { page, type, receive, model } = setup();
  type("/"); expect(within(page.getByRole("listbox")).getAllByRole("option")).toHaveLength(3);
  receive({ type: "event", seq: 1, patches: [], status: { ...initialState().status, process: "ready", activity: "running" }, dialogs: [], olderHistory: false });
  expect(page.queryByRole("listbox")).toBeNull();
  receive({ type: "hello", project: "fixture", process: "starting" }, "e2");
  expect(model.state.commands).toEqual([]);
  receive({ type: "commands", commands }, "e1"); expect(model.state.commands).toEqual([]);
  receive({ type: "snapshot", throughSeq: 0, status: { ...initialState().status, process: "ready" }, messages: [], dialogs: [], olderHistory: false }, "e2");
  receive({ type: "commands", commands: [commands[2]] }, "e2");
  expect(within(page.getByRole("listbox")).getAllByRole("option")).toHaveLength(1);
  model.disconnected(); flush(); expect(page.queryByRole("listbox")).toBeNull();
});
