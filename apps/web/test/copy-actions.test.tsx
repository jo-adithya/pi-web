import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { Markdown } from "../src/components/Markdown";
import { MessageList } from "../src/Conversation";
import { initialState } from "../src/client-state";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

it("copies each code block exactly, including nested blocks, without copying controls", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
  render(() => <Markdown text={'```ts\nconst x = "<&>";\n```\n\n> ```sh\n> echo nested\n> ```'} complete />);
  flush();
  const buttons = screen.getAllByRole("button", { name: "Copy code" });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[0]);
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith('const x = "<&>";\n'));
  fireEvent.click(buttons[1]);
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith("echo nested\n"));
  await vi.waitFor(() => { flush(); expect(screen.getAllByRole("status").some(status => status.textContent === "Copied")).toBe(true); });
});

it("copies only completed answer text, excluding hidden thinking and images", async () => {
  const write = vi.fn().mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
  const state = initialState(); state.order = ["answer"];
  state.messages.answer = { id: "answer", role: "assistant", complete: true, truncated: false, error: null, blocks: [{ kind: "thinking", text: "private thought" }, { kind: "text", text: "**Answer**\n\nDone." }] };
  render(() => <MessageList state={state} />); flush();
  fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith("**Answer**\n\nDone."));
  await vi.waitFor(() => { flush(); expect(screen.getByRole("status").textContent).toContain("select the text"); });
});

it("does not offer copying for streaming answers", () => {
  const state = initialState(); state.order = ["answer"];
  state.messages.answer = { id: "answer", role: "assistant", complete: false, truncated: false, error: null, blocks: [{ kind: "text", text: "Streaming…" }] };
  render(() => <MessageList state={state} />); flush();
  expect(screen.queryByRole("button", { name: "Copy answer" })).toBeNull();
});
