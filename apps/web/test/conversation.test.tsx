import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@solidjs/testing-library";
import { createStore, flush } from "solid-js";
import { MessageList } from "../src/Conversation";
import { initialState } from "../src/client-state";

afterEach(cleanup);
it("reveals all assistant replies for this query in Original without mixing prompts, tools or thinking", async () => {
  const state = initialState(); state.order = ["previous", "query", "early", "tool", "final"];
  state.messages.previous = { id: "previous", role: "assistant", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: "Previous query answer" }], presentation: { state: "hidden" } };
  state.messages.query = { id: "query", role: "user", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: "The user prompt" }] };
  state.messages.early = { id: "early", role: "assistant", complete: true, truncated: false, error: null, blocks: [{ kind: "thinking", text: "PRIVATE_THINKING" }, { kind: "text", text: "Earlier finding: restart is required." }], presentation: { state: "hidden" } };
  state.messages.tool = { id: "tool", role: "custom", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: "Tool output" }] };
  state.messages.final = { id: "final", role: "assistant", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: "Final result: ready." }], presentation: { state: "ready", response: { summary: "Ready; restart first.", blocks: [] } } };
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.queryByText("Earlier finding: restart is required.")).toBeNull();
  expect(view.getAllByRole("region", { name: "Simple answer" })).toHaveLength(1);
  await fireEvent.click(view.getByRole("button", { name: "View original" })); flush();
  const original = within(view.getByRole("region", { name: "Original answer" }));
  expect(original.getByText("Earlier finding: restart is required.")).toBeTruthy();
  expect(original.getByText("Final result: ready.")).toBeTruthy();
  for (const text of ["Previous query answer", "The user prompt", "Tool output", "PRIVATE_THINKING"]) expect(original.queryByText(text)).toBeNull();
});
it("hides the original response and copy action while a simple response is being prepared", () => {
  const state = initialState(); state.order = ["reply"];
  state.messages.reply = Object.assign({ id: "reply", role: "assistant", complete: false, truncated: false, error: null,
    blocks: [{ kind: "text" as const, text: "RAW_RESPONSE_MUST_STAY_HIDDEN" }] }, { presentation: { state: "pending" as const } });
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.queryByText("RAW_RESPONSE_MUST_STAY_HIDDEN")).toBeNull();
  expect(view.queryByRole("button", { name: "Copy answer" })).toBeNull();
  expect(view.getByRole("status").textContent).toContain("Working");
  expect(view.queryByRole("button", { name: "View original" })).toBeNull();
});
it.each(["pending", "ready", "error"] as const)("renders original HTML previews directly despite an older %s presentation", phase => {
  const state = initialState(); state.order = ["preview"];
  const presentation = phase === "pending" ? { state: "pending" as const }
    : phase === "error" ? { state: "error" as const, message: "Old formatting failure", retryable: true }
    : { state: "ready" as const, response: { summary: "Rewritten summary must not replace HTML.", blocks: [] } };
  state.messages.preview = { id: "preview", role: "assistant", complete: true, truncated: false, error: null,
    blocks: [{ kind: "text", text: "Before the preview.\n\n```html preview\n<div>Keep this HTML unchanged.</div>\n```\n\nAfter the preview." }], presentation };
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.getByRole("region", { name: "HTML preview" })).toBeTruthy();
  expect(view.getByText("Before the preview.")).toBeTruthy();
  expect(view.getByText("After the preview.")).toBeTruthy();
  expect(view.queryByText("Rewritten summary must not replace HTML.")).toBeNull();
  expect(view.queryByText("Old formatting failure")).toBeNull();
  expect(view.queryByRole("button", { name: "View original" })).toBeNull();
  expect(view.queryByRole("button", { name: "Copy simple answer" })).toBeNull();
  const frame = view.getByTitle("HTML artifact preview");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toBe("/artifact-preview");
});

it("preserves an earlier HTML preview when the combined run bypasses simplification", () => {
  const state = initialState(); state.order = ["early", "final"];
  state.messages.early = { id: "early", role: "assistant", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: "```html preview\n<div>Earlier preview</div>\n```" }], presentation: { state: "hidden" } };
  state.messages.final = { id: "final", role: "assistant", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: "Final explanation." }] };
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.getAllByRole("region", { name: "HTML preview" })).toHaveLength(1);
  expect(view.getByText("Final explanation.")).toBeTruthy();
  expect(view.queryByRole("button", { name: "View original" })).toBeNull();
});

it("keeps ordinary HTML code examples in the simple response flow", () => {
  const state = initialState(); state.order = ["reply"];
  state.messages.reply = { id: "reply", role: "assistant", complete: true, truncated: false, error: null,
    blocks: [{ kind: "text", text: "```html\n<div>Code example</div>\n```" }],
    presentation: { state: "ready", response: { summary: "An ordinary code example.", blocks: [] } } };
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.getByText("An ordinary code example.")).toBeTruthy();
  expect(view.getByRole("button", { name: "View original" })).toBeTruthy();
  expect(view.container.querySelector("iframe")).toBeNull();
});

it("keeps intermediate HTML previews hidden until Pi settles", () => {
  const state = initialState(); state.order = ["preview"];
  state.messages.preview = { id: "preview", role: "assistant", complete: true, truncated: false, error: null,
    blocks: [{ kind: "text", text: "```html preview\n<div>Intermediate</div>\n```" }], presentation: { state: "hidden" } };
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.container.textContent).toBe("");
  expect(view.container.querySelector("iframe")).toBeNull();
});

it("uses quiet original/back links instead of a repeated view switch", async () => {
  const state = initialState(); state.order = ["reply"];
  state.messages.reply = { id: "reply", role: "assistant", complete: true, truncated: false, error: null,
    blocks: [{ kind: "text", text: "Original technical answer" }], presentation: { state: "ready", response: {
      summary: "I fixed login.", blocks: [{ type: "checklist", title: "Changes", items: ["Updated sessions"] }, { type: "note", title: "Warning", text: "<script>doNotRun()</script>" }],
    } } };
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.getByText("I fixed login.")).toBeTruthy();
  expect(view.getByRole("heading", { name: "Changes" })).toBeTruthy();
  expect(view.getByText("Updated sessions")).toBeTruthy();
  expect(view.getByText("<script>doNotRun()</script>")).toBeTruthy();
  expect(view.container.querySelector("script")).toBeNull();
  expect(view.queryByText("Original technical answer")).toBeNull();
  expect(view.queryByRole("button", { name: "Copy answer" })).toBeNull();
  expect(view.getByRole("button", { name: "Copy simple answer" })).toBeTruthy();
  expect(view.queryByRole("group", { name: "Answer view" })).toBeNull();
  expect(view.queryByRole("button", { name: /^Simple$/ })).toBeNull();
  expect(view.queryByText("The short version, in plain words.")).toBeNull();
  await fireEvent.click(view.getByRole("button", { name: "View original" })); flush();
  expect(view.getByText("Original technical answer")).toBeTruthy();
  expect(view.queryByText("I fixed login.")).toBeNull();
  expect(view.queryByRole("heading", { name: "Changes" })).toBeNull();
  expect(view.getByRole("button", { name: "Back to simple" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Copy original answer" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Copy simple answer" })).toBeNull();
  await fireEvent.click(view.getByRole("button", { name: "Back to simple" })); flush();
  expect(view.queryByText("Original technical answer")).toBeNull();
  expect(view.getByText("I fixed login.")).toBeTruthy();
  expect(view.container.querySelectorAll("article.assistant")).toHaveLength(1);
});
it("supports safe Markdown in simple summaries, notes and list items without HTML previews", async () => {
  const openCode = vi.fn();
  const state = initialState(); state.order = ["reply"];
  state.messages.reply = { id: "reply", role: "assistant", complete: true, truncated: false, error: null, blocks: [], presentation: { state: "ready", response: {
    summary: "**Login works** with *less setup*.", blocks: [
      { type: "checklist", title: "Changes", items: ["Edit `src/auth.ts:4`"] },
      { type: "note", title: "Details", text: "Read the [guide](https://example.com).\n\n```html preview\n<script>unsafe()</script>\n```\n\n![tracker](https://example.com/tracker)\n\n[unsafe](javascript:alert(1))" },
    ],
  } } };
  const view = render(() => <MessageList state={state} openCode={openCode} />); flush();
  expect(view.container.querySelector(".simple-response-summary strong")?.textContent).toBe("Login works");
  expect(view.container.querySelector(".simple-response-summary em")?.textContent).toBe("less setup");
  expect(view.getByRole("link", { name: "guide" }).getAttribute("rel")).toBe("noopener noreferrer");
  expect(view.container.querySelector("script, iframe, img, a[href^='javascript:']")).toBeNull();
  const location = view.getByRole("link", { name: "src/auth.ts:4" });
  expect(location.querySelector("code")).not.toBeNull();
  await fireEvent.click(location);
  expect(openCode).toHaveBeenCalledWith({ path: "src/auth.ts", line: 4, endLine: 4 });
});

it("shows formatting failures and source warnings without exposing the original", async () => {
  const retry = vi.fn();
  const state = initialState(); state.order = ["reply"];
  state.messages.reply = { id: "reply", role: "assistant", complete: true, truncated: false, error: "Agent warning",
    blocks: [{ kind: "text", text: "Original answer" }], presentation: { state: "error", message: "Could not simplify.", retryable: true } };
  const view = render(() => <MessageList state={state} retryResponse={retry} />); flush();
  expect(view.getByRole("alert").textContent).toContain("Could not simplify.");
  expect(view.getByText("Agent warning")).toBeTruthy();
  expect(view.queryByText("Original answer")).toBeNull();
  await fireEvent.click(view.getByRole("button", { name: "Retry simple response" }));
  expect(retry).toHaveBeenCalledWith("reply");
  await fireEvent.click(view.getByRole("button", { name: "View original" })); flush();
  expect(view.getByText("Original answer")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Retry simple response" })).toBeNull();
});
it("keeps the interrupted original accessible when no simple answer can be made", async () => {
  const state = initialState(); state.order = ["reply"];
  state.messages.reply = { id: "reply", role: "assistant", complete: false, truncated: false, error: null,
    blocks: [{ kind: "text", text: "Partial original" }], presentation: { state: "error", message: "This run was cancelled.", retryable: false } };
  const view = render(() => <MessageList state={state} retryResponse={vi.fn()} />); flush();
  expect((view.getByRole("button", { name: "View original" }) as HTMLButtonElement).disabled).toBe(false);
  await fireEvent.click(view.getByRole("button", { name: "View original" })); flush();
  expect(view.getByText("Partial original")).toBeTruthy();
  expect(view.getByText(/stopped before it finished/)).toBeTruthy();
  expect(view.queryByRole("button", { name: "Retry simple response" })).toBeNull();
});

it("waits through intermediate messages and shows one final answer per query", () => {
  const value = initialState(); value.order = ["query", "step", "final"];
  value.messages.query = { id: "query", role: "user", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: "Fix login" }] };
  for (const id of ["step", "final"]) value.messages[id] = { id, role: "assistant", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: "Technical progress" }], presentation: { state: "hidden" } };
  const [state, setState] = createStore(value);
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.container.querySelectorAll("article.assistant")).toHaveLength(0);
  expect(view.queryByText("Technical progress")).toBeNull();
  setState(draft => { draft.messages.final.presentation = { state: "pending" }; }); flush();
  expect(view.container.querySelectorAll("article.assistant")).toHaveLength(1);
  expect(view.getByText(/Preparing your answer/)).toBeTruthy();
  setState(draft => { draft.messages.final.presentation = { state: "ready", response: { summary: "Login is fixed.", blocks: [] } }; }); flush();
  expect(view.container.querySelectorAll("article.assistant")).toHaveLength(1);
  expect(view.getByText("Login is fixed.")).toBeTruthy();
  expect(view.queryByText("Technical progress")).toBeNull();
});

it("keeps intermediate assistant messages hidden", () => {
  const state = initialState(); state.order = ["intermediate"];
  state.messages.intermediate = { id: "intermediate", role: "assistant", complete: true, truncated: false, error: null,
    blocks: [{ kind: "text", text: "Tool-turn commentary" }], presentation: { state: "hidden" } };
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.container.textContent).toBe("");
});
it.each(["custom", "branchSummary", "bashExecution"])("keeps %s messages distinct from the user in the thread", role => {
  const state = initialState(); state.order = ["retained"];
  state.messages.retained = { id: "retained", role, complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: "Retained history" }] };
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.getByRole("heading", { name: role })).toBeTruthy();
  expect(view.queryByRole("heading", { name: "You" })).toBeNull();
});

it("keeps compaction summaries collapsed, readable on demand, and separate from replies", async () => {
  const state = initialState(); state.order = ["summary"];
  state.messages.summary = { id: "summary", role: "compactionSummary", complete: true, truncated: true, error: null,
    blocks: [{ kind: "text", text: "## Decisions\nKeep the existing API." }] };
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.getByText("Context compacted")).toBeTruthy();
  expect(view.queryByText("compactionSummary")).toBeNull();
  expect(view.queryByText("Keep the existing API.")).toBeNull();
  expect(view.container.querySelector("[data-reply-author]")).toBeNull();
  const details = view.container.querySelector("details")!;
  expect(details).not.toBeNull();
  expect(details.open).toBe(false);
  details.open = true;
  await fireEvent(details, new Event("toggle")); flush();
  expect(view.getByRole("heading", { name: "Decisions" })).toBeTruthy();
  expect(view.getByText("Keep the existing API.")).toBeTruthy();
  expect(view.getByText(/Preview truncated/)).toBeTruthy();
  expect(view.container.querySelector("iframe")).toBeNull();
  details.open = false;
  await fireEvent(details, new Event("toggle")); flush();
  expect(view.queryByText("Keep the existing API.")).toBeNull();
});
it("previews only completed, untruncated assistant artifacts", () => {
  const text = "```html preview\n<div>Visual</div>\n```";
  const value = initialState(); value.order = ["artifact"];
  value.messages.artifact = { id: "artifact", role: "user", blocks: [{ kind: "text", text }], complete: true, error: null, truncated: false };
  const [state, setState] = createStore(value);
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.container.querySelector("iframe")).toBeNull();
  setState(draft => { draft.messages.artifact.role = "assistant"; draft.messages.artifact.complete = false; }); flush();
  expect(view.container.querySelector("iframe")).toBeNull();
  setState(draft => { draft.messages.artifact.complete = true; draft.messages.artifact.truncated = true; }); flush();
  expect(view.container.querySelector("iframe")).toBeNull();
  setState(draft => { draft.messages.artifact.truncated = false; }); flush();
  expect(view.container.querySelector("iframe")).not.toBeNull();
});
it("renders a replacement page without retaining the previous page, while preserving streaming rows", () => {
  const value = initialState();
  for (let i = 0; i < 20; i++) { const id = String(i); value.order.push(id); value.messages[id] = { id, role: "user", blocks: [], complete: true, error: null, truncated: false }; }
  const [state, setState] = createStore(value);
  const view = render(() => <MessageList state={state} />); flush();
  expect(view.container.querySelectorAll("article")).toHaveLength(20);
  expect(view.queryByRole("button", { name: "Show earlier retained messages" })).toBeNull();
  const oldArticle = view.container.querySelector("article");
  setState(draft => {
    draft.order = []; draft.messages = {};
    for (let i = 20; i < 40; i++) { const id = String(i); draft.order.push(id); draft.messages[id] = { id, role: "user", blocks: [], complete: true, error: null, truncated: false }; }
  }); flush();
  expect(view.container.querySelectorAll("article")).toHaveLength(20);
  expect(view.container.contains(oldArticle)).toBe(false);
  expect(state.messages["0"]).toBeUndefined();
  const retainedArticle = view.container.querySelector("article");
  setState(draft => { draft.seq++; draft.messages["39"].blocks = [{ kind: "text", text: "Streaming update" }]; }); flush();
  expect(view.container.querySelectorAll("article")).toHaveLength(20);
  expect(view.container.querySelector("article")).toBe(retainedArticle);
  expect(view.getByText("Streaming update")).toBeTruthy();
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
