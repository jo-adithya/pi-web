import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { createSessionModel } from "../src/session-model";
import { MessageList } from "../src/Conversation";
import { initialState, validHistoryResponse } from "../src/client-state";
import type { BrowserMessage, DisplayMessage, ServerBody } from "../src/generated/protocol";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const message = (id: string, role = "user"): DisplayMessage => ({ id, role, blocks: [{ kind: "text", text: `Payload ${id}` }], complete: true, truncated: false, error: null });
const status = { ...initialState().status, process: "ready" as const };
function setup() {
  const transport = vi.fn((_message: BrowserMessage) => true);
  const model = createSessionModel("paged", transport, () => true, undefined, () => "proof");
  const receive = (body: ServerBody, epoch = "e") => model.receive({ v: 1, sessionId: "paged", epoch, body });
  receive({ type: "hello", project: "Fixture", process: "ready" });
  receive({ type: "snapshot", throughSeq: 0, messages: [message("u40"), message("a40", "assistant")], status, dialogs: [], olderHistory: true });
  flush(); return { model, transport, receive };
}
const page = () => ({ type: "page", epoch: "e", cursor: "p1:1000:a20", latestCursor: "a40", olderCursor: "p1:400:a0", messages: [message("u20"), message("a20", "assistant")] });

it("replaces page payloads and discards live bodies while reading history, then resnapshots Latest", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _input?: RequestInit) => new Response(JSON.stringify(page()), { status: 200 })); vi.stubGlobal("fetch", fetcher);
  const { model, transport, receive } = setup();
  await model.navigateHistory("older"); flush();
  expect(model.state.order).toEqual(["u20", "a20"]);
  expect(model.state.messages.a40).toBeUndefined();
  expect(JSON.stringify(model.historyPage())).not.toContain("Payload");
  const input = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
  expect(input).toEqual({ type: "page", cursor: null, start: "u40" });
  receive({ type: "event", seq: 1, patches: [{ kind: "message", message: message("new-live") }], status, dialogs: [], olderHistory: true });
  receive({ type: "snapshot", throughSeq: 2, messages: [message("latest")], status, dialogs: [], olderHistory: true }); flush();
  expect(model.state.order).toEqual(["u20", "a20"]);
  expect(model.state.messages["new-live"]).toBeUndefined();
  expect(model.newReplies()).toBe(true);
  await model.navigateHistory("newer"); flush();
  expect(model.state.order).toEqual([]);
  expect(model.historyPage()).toBeUndefined();
  expect(transport.mock.calls.at(-1)![0].action).toEqual({ type: "attach" });
  receive({ type: "snapshot", throughSeq: 2, messages: [message("latest")], status, dialogs: [], olderHistory: false }); flush();
  expect(model.state.order).toEqual(["latest"]);
  expect(transport.mock.calls.some(([frame]) => frame.action.type === "prompt")).toBe(false);
  model.dispose();
});

it("keeps the current page when returning to Latest cannot be delivered", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(page()), { status: 200 })));
  const { model, transport } = setup();
  await model.navigateHistory("older"); flush();
  transport.mockImplementation(() => false);
  model.latestHistory(); flush();
  expect(model.state.order).toEqual(["u20", "a20"]);
  expect(model.historyPage()).toBeDefined();
  expect(model.notice()).toContain("Reconnect");
  model.dispose();
});

it("keeps the current page on read failure and rejects a stale epoch response", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...page(), epoch: "stale" }), { status: 200 })));
  const { model } = setup();
  await model.navigateHistory("older"); flush();
  expect(model.state.order).toEqual(["u40", "a40"]);
  expect(model.historyPage()).toBeUndefined();
  expect(model.notice()).toContain("History changed");
  model.dispose();
});

it("cancels a page read and ignores its late response after a runtime change", async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn((_url: RequestInfo | URL, _input?: RequestInit) => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal("fetch", fetcher);
  const { model, receive } = setup();
  const navigation = model.navigateHistory("older"); flush();
  receive({ type: "hello", project: "Changed runtime", process: "ready" }, "next"); flush();
  resolve(new Response(JSON.stringify(page()), { status: 200 }));
  await navigation; flush();
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(model.state.order).toEqual([]);
  expect(model.historyPage()).toBeUndefined();
  expect(model.historyBusy()).toBe(false);
  model.dispose();
});

it("validates history messages before installation", () => {
  expect(validHistoryResponse(page())).toBe(true);
  const invalid = page(); invalid.messages[0].blocks[0].text = "x".repeat(70_000);
  expect(validHistoryResponse(invalid)).toBe(false);
  expect(validHistoryResponse({ type: "original", epoch: "e", text: "x".repeat(256 * 1024) })).toBe(true);
  expect(validHistoryResponse({ type: "original", epoch: "e", text: 123 })).toBe(false);
});

it("fetches Original only when opened and releases it when closed", async () => {
  const state = initialState(); state.order = ["answer"];
  state.messages.answer = { ...message("answer", "assistant"), blocks: [], sourceKey: "a".repeat(64), presentation: { state: "ready", response: { summary: "Short saved result.", blocks: [] } } };
  let signal: AbortSignal | undefined;
  const load = vi.fn(async (_key: string, next: AbortSignal) => { signal = next; return "Full original reply from disk."; });
  const view = render(() => <MessageList state={state} loadOriginal={load} />); flush();
  expect(load).not.toHaveBeenCalled();
  await fireEvent.click(view.getByRole("button", { name: "View original" }));
  await vi.waitFor(() => expect(view.getByText("Full original reply from disk.")).toBeTruthy());
  expect(load).toHaveBeenCalledTimes(1);
  await fireEvent.click(view.getByRole("button", { name: "Back to simple" })); flush();
  expect(signal?.aborted).toBe(true);
  expect(view.queryByText("Full original reply from disk.")).toBeNull();
  await fireEvent.click(view.getByRole("button", { name: "View original" }));
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  view.unmount(); expect(signal?.aborted).toBe(true);
});
