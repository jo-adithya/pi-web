import { expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { createSessionModel } from "../src/session-model";
import { initialState } from "../src/client-state";
import type { BrowserMessage, ServerBody } from "../src/generated/protocol";

function setup() {
  const transport = vi.fn((_message: BrowserMessage) => true);
  const model = createSessionModel("session", transport, () => true);
  const receive = (body: ServerBody) => { model.receive({ v: 1, sessionId: "session", epoch: "epoch", body }); flush(); };
  receive({ type: "hello", project: "fixture", process: "ready" });
  receive({ type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } });
  const ack = (ok: boolean, recoveredDraft: string | null = null) => receive({ type: "result", result: {
    requestId: transport.mock.calls.at(-1)![0].requestId, ok, code: ok ? "accepted" : "busy", disposition: null, recoveredDraft,
  } });
  return { model, transport, receive, ack };
}

it("sends only the explicit question and preserves an identical composer draft and quote on acknowledgement", () => {
  const { model, transport, ack } = setup();
  model.setDraft("Review question"); model.quoteReply({ author: "Pi", text: "Unrelated quote" }); flush();
  expect(model.submitReview("Review question")).toBe(true);
  expect(transport.mock.calls[0][0].action).toEqual({ type: "prompt", text: "Review question", images: [] });
  expect(model.submitReview("Duplicate")).toBe(false);
  model.submit();
  expect(transport).toHaveBeenCalledOnce();
  ack(true);
  expect(model.draft()).toBe("Review question");
  expect(model.quote()?.text).toBe("Unrelated quote");
  expect(model.pending()).toBe(false);
});

it.each([null, "Review question"])("preserves a rejected review question exactly once with recoveredDraft=%s", recovered => {
  const { model, ack } = setup();
  model.setDraft("Keep my draft"); flush();
  model.submitReview("Review question"); flush();
  ack(false, recovered);
  expect(model.draft()).toBe("Keep my draft\n\nReview question");
  expect(model.notice()).toContain("not completed");
});

it("preserves uncertain delivery once without replaying or losing the original draft", () => {
  const { model, transport } = setup();
  model.setDraft("Keep my draft"); flush();
  model.submitReview("Review question"); flush();
  model.disconnected(); flush(); model.disconnected(); flush();
  expect(model.draft()).toBe("Keep my draft\n\nReview question");
  expect(model.notice()).toContain("uncertain");
  expect(model.submitReview("Review question")).toBe(false);
  expect(transport).toHaveBeenCalledOnce();
});

it("rejects empty, oversized, busy and unavailable sends without changing the composer", () => {
  const { model, transport, receive } = setup();
  model.setDraft("Keep my draft"); flush();
  expect(model.submitReview(" ")).toBe(false);
  expect(model.submitReview("界".repeat(11000))).toBe(false);
  expect(transport).not.toHaveBeenCalled();
  transport.mockReturnValue(false);
  expect(model.submitReview("Review question")).toBe(false);
  expect(model.pending()).toBe(false);
  receive({ type: "event", seq: 1, patches: [], dialogs: [], olderHistory: false, status: { ...model.state.status, activity: "running" } });
  expect(model.submitReview("Review question")).toBe(false);
  expect(transport).toHaveBeenCalledOnce();
  expect(model.draft()).toBe("Keep my draft");
});
