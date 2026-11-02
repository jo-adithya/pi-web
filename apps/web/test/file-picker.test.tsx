import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { SessionView } from "../src/SessionView";
import { createSessionModel } from "../src/session-model";
import { initialState } from "../src/client-state";
import type { ServerMessage } from "../src/generated/protocol";

const session = "11111111-1111-4111-8111-111111111111";
function setup(paths = ["src/App.tsx", "src/api.ts"]) {
  const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ paths, truncated: false })));
  vi.stubGlobal("fetch", request);
  const transport = vi.fn(() => true);
  const model = createSessionModel(session, transport, () => true, undefined, () => "a".repeat(64));
  const receive = (body: ServerMessage["body"], epoch = "e1") => {
    model.receive({ v: 1, sessionId: session, epoch, body }); flush();
  };
  receive({ type: "hello", project: "fixture", process: "ready" });
  receive({ type: "snapshot", throughSeq: 0, status: { ...initialState().status, process: "ready" }, messages: [], dialogs: [], olderHistory: false });
  const page = render(() => <SessionView model={model} />);
  const input = page.getByLabelText("Message Pi") as HTMLTextAreaElement;
  function type(value: string, caret = value.length) {
    input.focus(); fireEvent.input(input, { target: { value, selectionStart: caret, selectionEnd: caret } }); flush();
  }
  function key(key: string, options = {}) { fireEvent.keyDown(input, { key, ...options }); flush(); }
  return { page, input, type, key, request, transport, model, receive };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("searches the conversation workspace and inserts a selected @ path without sending", async () => {
  const { page, input, type, key, request, transport } = setup();
  type("Please inspect @src/A before editing", 21);
  const list = await waitFor(() => { flush(); return page.getByRole("listbox", { name: "Workspace files" }); });
  expect(within(list).getAllByRole("option")).toHaveLength(2);
  expect(request).toHaveBeenCalledWith(`/files/${session}`, expect.objectContaining({
    method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
    headers: { "content-type": "application/json", "x-pi-capability": "a".repeat(64) },
    body: JSON.stringify({ query: "src/A" }),
  }));
  key("ArrowDown"); key("Tab");
  expect(input.value).toBe("Please inspect @src/api.ts before editing");
  expect(input.selectionStart).toBe(26);
  expect(document.activeElement).toBe(input);
  expect(page.queryByRole("listbox")).toBeNull();
  expect(transport).not.toHaveBeenCalled();
  key("Enter");
  expect(transport).toHaveBeenCalledWith(expect.objectContaining({ action: { type: "prompt", text: "Please inspect @src/api.ts before editing", images: [] } }));
});


it("quotes paths containing spaces and supports pointer insertion in the middle of a token", async () => {
  const { page, input, type, transport } = setup(["docs/design notes.md"]);
  type("Read @docs/old.md next", 11);
  const option = await waitFor(() => { flush(); return page.getByRole("option"); });
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
  fireEvent.mouseDown(option); fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 }); fireEvent.click(option); flush();
  expect(input.value).toBe('Read @"docs/design notes.md" next');
  expect(input.selectionStart).toBe(28);
  expect(document.activeElement).toBe(input);
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  { path: 'docs/a"b.md', beforeEscape: true, query: "docs/a" },
  { path: 'docs/a"b.md', beforeEscape: false, query: 'docs/a"' },
  { path: "docs/a\\b.md", beforeEscape: false, query: "docs/a\\" },
])("re-completes escaped filename $path without changing surrounding prose ($beforeEscape)", async ({ path, beforeEscape, query }) => {
  const { page, input, type, key, request } = setup([path]);
  type("Read @old after", "Read @old".length);
  await waitFor(() => { flush(); expect(page.getByRole("option")).toBeTruthy(); });
  key("Tab");
  const encoded = JSON.stringify(path);
  expect(input.value).toBe(`Read @${encoded} after`);
  request.mockImplementationOnce(async () => new Response(JSON.stringify({ paths: ["docs/replacement.md"], truncated: false })));
  const caret = "Read @".length + (beforeEscape ? encoded.indexOf("\\") : encoded.indexOf("b.md"));
  input.setSelectionRange(caret, caret); fireEvent.select(input); flush();
  await waitFor(() => { flush(); expect(page.getByRole("option", { name: "@docs/replacement.md" })).toBeTruthy(); });
  expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ query });
  key("Tab");
  expect(input.value).toBe("Read @docs/replacement.md after");
});

it("searches quoted references and inserts multiple files while preserving prose", async () => {
  const { page, input, type, key, request } = setup(["docs/design notes.md"]);
  type('Compare @src/App.tsx with @"design n');
  await waitFor(() => { flush(); expect(page.getByRole("option")).toBeTruthy(); });
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ query: "design n" });
  key("Enter");
  expect(input.value).toBe('Compare @src/App.tsx with @"docs/design notes.md" ');
});

it("debounces typing and leaves email addresses, selections and IME text alone", async () => {
  vi.useFakeTimers();
  const { input, type, key, request } = setup();
  type("Email person@example.com");
  await vi.advanceTimersByTimeAsync(200); flush();
  expect(request).not.toHaveBeenCalled();
  type("@s"); type("@sr"); type("@src");
  await vi.advanceTimersByTimeAsync(119); flush();
  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); flush();
  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ query: "src" });
  fireEvent.compositionStart(input); flush(); key("Enter", { isComposing: true });
  expect(input.value).toBe("@src");
  type("@other");
  await vi.advanceTimersByTimeAsync(200); flush();
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.compositionEnd(input); flush();
  input.setSelectionRange(0, 6); fireEvent.select(input); flush();
  await vi.advanceTimersByTimeAsync(200); flush();
  expect(request).toHaveBeenCalledTimes(1);
});

it("cancels old searches and ignores out-of-order results", async () => {
  const { page, type, request } = setup();
  let oldReply!: (response: Response) => void;
  request.mockImplementationOnce(() => new Promise<Response>(resolve => { oldReply = resolve; }));
  type("@old");
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  const oldSignal = request.mock.calls[0][1].signal as AbortSignal;
  type("@src");
  await waitFor(() => { flush(); expect(page.getAllByRole("option")).toHaveLength(2); });
  expect(oldSignal.aborted).toBe(true);
  oldReply(new Response(JSON.stringify({ paths: ["old-secret.ts"], truncated: false })));
  await Promise.resolve(); flush();
  expect(page.queryByText("@old-secret.ts")).toBeNull();
  expect(page.getByText("@src/App.tsx")).toBeTruthy();
});

it.each(["Escape", "blur", "disconnect", "busy", "epoch", "unmount"])("cancels a pending lookup on %s", async reason => {
  const { page, input, type, key, request, transport, receive, model } = setup();
  let reply!: (response: Response) => void;
  request.mockImplementationOnce(() => new Promise<Response>(resolve => { reply = resolve; }));
  type("@");
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  key("Enter");
  expect(transport).not.toHaveBeenCalled();
  const signal = request.mock.calls[0][1].signal as AbortSignal;
  if (reason === "Escape") key("Escape");
  if (reason === "blur") { fireEvent.blur(input); flush(); }
  if (reason === "disconnect") { model.disconnected(); flush(); }
  if (reason === "busy") receive({ type: "event", seq: 1, patches: [], status: { ...initialState().status, process: "ready", activity: "running" }, dialogs: [], olderHistory: false });
  if (reason === "epoch") receive({ type: "hello", project: "fixture", process: "starting" }, "e2");
  if (reason === "unmount") page.unmount();
  expect(signal.aborted).toBe(true);
  reply(new Response(JSON.stringify({ paths: ["late.ts"], truncated: false })));
  await Promise.resolve(); flush();
  expect(page.queryByRole("listbox")).toBeNull();
  expect(model.draft()).toBe("@");
});

it("reports no matches, truncated results and request failures without changing the draft", async () => {
  const { page, type, request, model } = setup([]);
  type("@missing");
  await waitFor(() => { flush(); expect(page.getByText("No matching workspace files.")).toBeTruthy(); });
  request.mockImplementationOnce(async () => new Response(JSON.stringify({ paths: ["src/App.tsx"], truncated: true })));
  type("@src");
  await waitFor(() => { flush(); expect(page.getByText("Results limited. Type more to narrow your search.")).toBeTruthy(); });
  request.mockRejectedValueOnce(new Error("network down"));
  type("@failed");
  await waitFor(() => { flush(); expect(page.getByText("File search unavailable. Your draft was kept.")).toBeTruthy(); });
  expect(page.queryByRole("listbox")).toBeNull();
  expect(model.draft()).toBe("@failed");
});

it.each(["../outside", "/etc/passwd", "src/./a", "bad\\u0000name"])("rejects malformed search paths: %s", async path => {
  const { page, type, model } = setup([path === "bad\\u0000name" ? "bad\u0000name" : path]);
  type("@src");
  await waitFor(() => { flush(); expect(page.getByText("File search unavailable. Your draft was kept.")).toBeTruthy(); });
  expect(page.queryByRole("option")).toBeNull();
  expect(model.draft()).toBe("@src");
});
