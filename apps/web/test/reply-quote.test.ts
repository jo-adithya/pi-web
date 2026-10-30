import { expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { createSessionModel } from "../src/session-model";
import { initialState } from "../src/client-state";
import { formatReply } from "../src/reply-quote";
import type { BrowserMessage, ServerBody, ServerMessage } from "../src/generated/protocol";

it("formats every quoted line without an author heading or changing the draft", () => {
  expect(formatReply("  draft\n", undefined)).toBe("  draft\n");
  expect(formatReply("answer", { author: "You", text: "first\n\nlast\n" })).toBe("> first\n> \n> last\n> \n\nanswer");
  expect(formatReply("", { author: "Pi", text: "text" })).toBe("> text\n\n");
});

const frame = (body: ServerBody): ServerMessage => ({ v: 1, sessionId: "session", epoch: "epoch", body });
function setup() {
  const transport = vi.fn((_message: BrowserMessage) => true);
  const model = createSessionModel("session", transport, () => true);
  const connect = () => {
    model.receive(frame({ type: "hello", project: "fixture", process: "ready" }));
    model.receive(frame({ type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } }));
    flush();
  };
  connect();
  const ack = (ok = true, code = "accepted") => {
    model.receive(frame({ type: "result", result: { requestId: transport.mock.calls.at(-1)![0].requestId, ok, code, disposition: null, recoveredDraft: null } }));
    flush();
  };
  return { model, transport, connect, ack };
}

it("snapshots a trimmed multiline quote, sends formatted text and clears it on acknowledgement", () => {
  const { model, transport, ack } = setup();
  model.setDraft("  explain\nplease  ");
  const selected = { author: "Pi" as const, text: "  first\n\nlast  " };
  expect(model.quoteReply(selected)).toBe(true);
  selected.text = "mutated";
  flush();
  expect(model.quote()).toEqual({ author: "Pi", text: "first\n\nlast" });
  expect(transport).not.toHaveBeenCalled();
  model.submit();
  expect(transport.mock.calls[0][0].action).toEqual({ type: "prompt", text: "> first\n> \n> last\n\n  explain\nplease  ", images: [] });
  expect(model.draft()).toBe("  explain\nplease  ");
  expect(model.quote()).toBeDefined();
  ack();
  expect(model.draft()).toBe("");
  expect(model.quote()).toBeUndefined();
});

it("rejects empty and oversized selections without replacing the draft or previous quote", () => {
  const { model, transport } = setup();
  model.setDraft("é".repeat(16_381)); flush();
  // 32,762 draft bytes + 6 quote bytes = exactly 32,768.
  expect(model.quoteReply({ author: "Pi", text: "é" })).toBe(true); flush();
  expect(model.canSend()).toBe(true);
  const previous = model.quote();
  expect(model.quoteReply({ author: "Pi", text: " \n " })).toBe(false);
  expect(model.quoteReply({ author: "Pi", text: "éa" })).toBe(false); flush();
  expect(model.quote()).toBe(previous);
  expect(model.draft()).toBe("é".repeat(16_381));
  expect(model.notice()).toMatch(/shorter|shorten|remove/i);
  expect(transport).not.toHaveBeenCalled();
  model.setDraft(model.draft() + "a"); flush();
  expect(model.canSend()).toBe(false);
  model.submit(); expect(transport).not.toHaveBeenCalled();
});

it.each(["draft", "replacement", "clear"])("preserves in-flight %s changes independently on successful acknowledgement", change => {
  const { model, ack } = setup();
  model.setDraft("original");
  model.quoteReply({ author: "Pi", text: "same text" }); flush();
  const original = model.quote();
  model.submit(); flush();
  if (change === "draft") model.setDraft("edited");
  if (change === "replacement") model.quoteReply({ author: "Pi", text: "same text" });
  if (change === "clear") model.clearQuote();
  flush();
  const current = model.quote();
  if (change === "replacement") expect(current).not.toBe(original);
  ack();
  expect(model.draft()).toBe(change === "draft" ? "edited" : "");
  expect(model.quote()).toBe(change === "replacement" ? current : undefined);
});

it.each(["rejected", "pending", "disconnect", "transport"])("keeps both draft and quote after %s delivery", outcome => {
  const { model, transport, connect, ack } = setup();
  model.setDraft("preserve"); model.quoteReply({ author: "You", text: "context" }); flush();
  const quote = model.quote();
  if (outcome === "transport") transport.mockReturnValue(false);
  model.submit(); flush();
  if (outcome === "rejected") ack(false, "rejected");
  if (outcome === "pending") ack(true, "pending");
  if (outcome === "disconnect") {
    model.disconnected(); flush();
    expect(model.notice()).toContain("uncertain");
    connect(); ack(); // A late result cannot clear the preserved draft.
  }
  expect(model.draft()).toBe("preserve");
  expect(model.quote()).toBe(quote);
  expect(transport).toHaveBeenCalledTimes(1);
});

it("requires an actual draft, preserves unquoted text and isolates session-local quotes", () => {
  const { model, transport, ack } = setup();
  const other = setup().model;
  model.quoteReply({ author: "You", text: "context" }); flush();
  expect(model.canSend()).toBe(false);
  model.setDraft(" \n "); flush();
  model.submit(); expect(transport).not.toHaveBeenCalled();
  expect(other.quote()).toBeUndefined();
  model.clearQuote(); model.setDraft("  normal\nmessage  "); flush();
  model.submit();
  expect(transport.mock.calls[0][0].action).toEqual({ type: "prompt", text: "  normal\nmessage  ", images: [] });
  ack(); expect(model.draft()).toBe("");
  model.quoteReply({ author: "Pi", text: "discard" }); flush();
  model.dispose(); flush(); expect(model.quote()).toBeUndefined();
});
