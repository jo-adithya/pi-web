import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createStore, flush } from "solid-js";
import { MessageList } from "../src/Conversation";
import { initialState } from "../src/client-state";

afterEach(cleanup);
it("mounts only 100 messages and preserves revealed history across streaming and epoch changes", async () => {
  const value = initialState(); value.epoch = "first";
  for (let i = 0; i < 500; i++) { const id = String(i); value.order.push(id); value.messages[id] = { id, role: "user", blocks: [], complete: true, error: null, truncated: false }; }
  const [state, setState] = createStore(value);
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.container.querySelectorAll("article")).toHaveLength(100);
  await fireEvent.click(view.getByRole("button", { name: "Show earlier retained messages" })); flush();
  expect(view.container.querySelectorAll("article")).toHaveLength(200);
  const retainedArticle = view.container.querySelector("article");
  setState(draft => {
    draft.seq++;
    draft.messages["499"].blocks = [{ kind: "text", text: "Streaming update" }];
  }); flush();
  expect(view.container.querySelectorAll("article")).toHaveLength(200);
  expect(view.container.querySelector("article")).toBe(retainedArticle);
  expect(view.getByText("Streaming update")).toBeTruthy();
  setState(draft => { draft.epoch = "second"; }); flush();
  expect(view.container.querySelectorAll("article")).toHaveLength(200);
  await fireEvent.click(view.getByRole("button", { name: "Show earlier retained messages" })); flush();
  expect(view.container.querySelectorAll("article")).toHaveLength(300);
  setState(draft => { draft.epoch = "first"; }); flush();
  expect(view.container.querySelectorAll("article")).toHaveLength(300);
});
it("renders retained messages even before an epoch is assigned", () => {
  const state = initialState(); state.order = ["initial"];
  state.messages.initial = { id: "initial", role: "user", blocks: [], complete: true, error: null, truncated: false };
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.container.querySelectorAll("article")).toHaveLength(1);
});
it("hides thinking while rendering assistant text, notices and errors", () => {
  const state = initialState(); state.order = ["reply"];
  state.messages.reply = { id: "reply", role: "assistant", complete: true, truncated: false, error: "Interrupted", blocks: [
    { kind: "text", text: "Visible reply" }, { kind: "thinking", text: "Reasoning" }, { kind: "notice", text: "Image omitted" },
  ] };
  const view = render(() => <MessageList state={state} />); flush();
  for (const text of ["Pi", "Visible reply", "Image omitted", "Interrupted"]) expect(view.getByText(text)).toBeTruthy();
  expect(view.queryByText("Thinking")).toBeNull();
  expect(view.queryByText("Reasoning")).toBeNull();
});
it("keeps thinking-only messages hidden as they stream and reveals responses or errors", () => {
  const value = initialState(); value.order = ["reply"];
  value.messages.reply = { id: "reply", role: "assistant", complete: false, truncated: false, error: null,
    blocks: [{ kind: "thinking", text: "Private reasoning" }] };
  const [state, setState] = createStore(value);
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.container.querySelector("article")).toBeNull();
  setState(draft => { draft.messages.reply.blocks[0].text += " continued"; }); flush();
  expect(view.container.textContent).toBe("");
  setState(draft => { draft.messages.reply.error = "Interrupted"; }); flush();
  expect(view.getByText("Interrupted")).toBeTruthy();
  expect(view.queryByText(/Private reasoning/)).toBeNull();
  setState(draft => { draft.messages.reply.blocks.push({ kind: "text", text: "Visible response" }); draft.messages.reply.complete = true; }); flush();
  expect(view.getByText("Visible response")).toBeTruthy();
  expect(view.queryByText(/Private reasoning/)).toBeNull();
});
