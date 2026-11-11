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

it("copies only the selected version of a simple response", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
  const state = initialState(); state.order = ["answer"];
  state.messages.answer = { id: "answer", role: "assistant", complete: true, truncated: false, error: null,
    blocks: [{ kind: "thinking", text: "Private thought" }, { kind: "text", text: "**Original answer**" }],
    presentation: { state: "ready", response: { summary: "Fixed.", blocks: [{ type: "checklist", title: "Changes", items: ["Updated login"] }] } } };
  render(() => <MessageList state={state} />); flush();
  fireEvent.click(screen.getByRole("button", { name: "Copy simple answer" }));
  await vi.waitFor(() => { flush(); expect(screen.getByRole("button", { name: "Copy simple answer" }).textContent).toBe("Copied"); });
  expect(write).toHaveBeenLastCalledWith("Fixed.\n\nChanges\n• Updated login");
  fireEvent.click(screen.getByRole("button", { name: "View original" })); flush();
  expect(screen.getByRole("button", { name: "Copy original answer" }).textContent).toBe("Copy original answer");
  fireEvent.click(screen.getByRole("button", { name: "Copy original answer" }));
  await vi.waitFor(() => expect(write).toHaveBeenLastCalledWith("**Original answer**"));
});

it("copies all original replies in order without including earlier queries or thinking", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
  const state = initialState(); state.order = ["old", "user", "early", "answer"];
  state.messages.old = { id: "old", role: "assistant", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: "Old answer" }], presentation: { state: "hidden" } };
  state.messages.user = { id: "user", role: "user", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: "User query" }] };
  state.messages.early = { id: "early", role: "assistant", complete: true, truncated: false, error: null, blocks: [{ kind: "thinking", text: "Private thought" }, { kind: "text", text: "Earlier finding." }], presentation: { state: "hidden" } };
  state.messages.answer = { id: "answer", role: "assistant", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: "**Final result**" }], presentation: { state: "ready", response: { summary: "Ready.", blocks: [] } } };
  render(() => <MessageList state={state} />); flush();
  fireEvent.click(screen.getByRole("button", { name: "View original" })); flush();
  fireEvent.click(screen.getByRole("button", { name: "Copy original answer" }));
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith("Earlier finding.\n\n**Final result**"));
});

it("copies ordered steps, reported check statuses, warnings and collapsed details", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
  const state = initialState(); state.order = ["answer"];
  state.messages.answer = { id: "answer", role: "assistant", complete: true, truncated: false, error: null, blocks: [], presentation: { state: "ready", response: {
    summary: "Update ready.", blocks: [
      { type: "warning", title: "Before deployment", text: "Back up first." },
      { type: "steps", title: "Next steps", items: ["Save settings.", "Restart pi-web."] },
      { type: "checks", title: "Verification", items: [{ status: "passed", text: "Build completed." }, { status: "unverified", text: "Live model not checked." }] },
      { type: "details", title: "How it works", text: "Optional explanation." },
    ],
  } } };
  render(() => <MessageList state={state} />); flush();
  expect(document.querySelector("details")?.open).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Copy simple answer" }));
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith("Update ready.\n\nWarning: Before deployment\nBack up first.\n\nNext steps\n1. Save settings.\n2. Restart pi-web.\n\nVerification (reported by Pi)\nPassed: Build completed.\nUnverified: Live model not checked.\n\nHow it works\nOptional explanation."));
});

it("copies visual facts, tables, comparisons and flow relationships as readable text", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
  const state = initialState(); state.order = ["answer"];
  state.messages.answer = { id: "answer", role: "assistant", complete: true, truncated: false, error: null, blocks: [], presentation: { state: "ready", response: {
    summary: "Visual example.", blocks: [
      { type: "facts", title: "Key facts", items: [{ label: "Duration", value: "3.6 s" }] },
      { type: "table", title: "Comparison", columns: ["Option", "Time"], rows: [["A|B", "3.6 s"]] },
      { type: "comparison", title: "Change", before: "Text-heavy.", after: "Visual." },
      { type: "flow", title: "Answer path", items: ["Pi", "Formatter", "Answer"] },
    ],
  } } };
  render(() => <MessageList state={state} />); flush();
  fireEvent.click(screen.getByRole("button", { name: "Copy simple answer" }));
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith("Visual example.\n\nKey facts (reported by Pi)\nDuration: 3.6 s\n\nComparison\n| Option | Time |\n| --- | --- |\n| A\\|B | 3.6 s |\n\nChange\nBefore: Text-heavy.\nAfter: Visual.\n\nAnswer path\nPi → Formatter → Answer"));
});

it("keeps existing pipe escapes intact when copying inline Markdown table cells", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
  const state = initialState(); state.order = ["answer"];
  state.messages.answer = { id: "answer", role: "assistant", complete: true, truncated: false, error: null, blocks: [], presentation: { state: "ready", response: {
    summary: "Table.", blocks: [{ type: "table", title: "Cells", columns: ["Value"], rows: [[String.raw`A\|B`], [String.raw`C\\|D`]] }],
  } } };
  render(() => <MessageList state={state} />); flush();
  fireEvent.click(screen.getByRole("button", { name: "Copy simple answer" }));
  const expected = ["Table.", "", "Cells", "| Value |", "| --- |", String.raw`| A\|B |`, String.raw`| C\\\|D |`].join("\n");
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith(expected));
});

it("copies snippets exactly and contains embedded fences when copying the whole answer", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
  const code = '  const fence = "````";\r\n<script>literal()</script>\n';
  const state = initialState(); state.order = ["answer"];
  state.messages.answer = { id: "answer", role: "assistant", complete: true, truncated: false, error: null, blocks: [], presentation: { state: "ready", response: {
    summary: "Code example.", blocks: [{ type: "code", title: "Example", language: "typescript", code }],
  } } };
  render(() => <MessageList state={state} />); flush();
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  await vi.waitFor(() => expect(write).toHaveBeenLastCalledWith(code));
  fireEvent.click(screen.getByRole("button", { name: "Copy simple answer" }));
  await vi.waitFor(() => expect(write).toHaveBeenLastCalledWith("Code example.\n\nExample\n" + "`````typescript\n" + code + "`````"));
});

it("does not offer copying for streaming answers", () => {
  const state = initialState(); state.order = ["answer"];
  state.messages.answer = { id: "answer", role: "assistant", complete: false, truncated: false, error: null, blocks: [{ kind: "text", text: "Streaming…" }] };
  render(() => <MessageList state={state} />); flush();
  expect(screen.queryByRole("button", { name: "Copy answer" })).toBeNull();
});
