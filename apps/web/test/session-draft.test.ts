import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { createSessionModel } from "../src/session-model";
import { fileReviewCard } from "../src/review-cards";
import { initialState } from "../src/client-state";
import type { BrowserMessage } from "../src/generated/protocol";

const card = fileReviewCard({ path: "src/main.ts", previousPath: null, status: "modified", fingerprint: "one", patch: "@@ -1 +1 @@\n-oldSecret()\n+newSecret()\n" }, { scope: "unstaged" });
const modelFor = (id = "draft") => createSessionModel(id, vi.fn((_message: BrowserMessage) => true), () => true);
beforeEach(() => sessionStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("restores composer text, quote and captured feedback in the same tab without sending", () => {
  const first = modelFor();
  first.setDraft("Keep the API stable"); first.quoteReply({ author: "Pi", text: "Existing explanation" });
  first.addFeedback("Handle empty results", card); flush();
  first.dispose(); flush();
  const transport = vi.fn((_message: BrowserMessage) => true);
  const restored = createSessionModel("draft", transport, () => true);
  expect(restored.draft()).toBe("Keep the API stable");
  expect(restored.quote()).toEqual({ author: "Pi", text: "Existing explanation" });
  expect(restored.feedback()[0]).toMatchObject({ comment: "Handle empty results", card });
  expect(restored.pending()).toBe(false);
  expect(transport).not.toHaveBeenCalled();
  expect(modelFor("other").draft()).toBe("");
  expect(modelFor("other").feedback()).toEqual([]);
});

it("clears only acknowledged work from storage and warns about unacknowledged delivery after reload", () => {
  const sent: BrowserMessage[] = [];
  const model = createSessionModel("pending", message => { sent.push(message); return true; }, () => true);
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } } });
  model.setDraft("My request"); flush(); model.submit(); flush();
  expect(modelFor("pending").visibleNotice() ?? "").toContain("uncertain");
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "result", result: { requestId: sent[0].requestId, ok: true, code: "accepted", disposition: "started", recoveredDraft: null } } }); flush();
  expect(modelFor("pending").draft()).toBe("");
});

it("preserves captured references through editing and only removes acknowledged feedback", () => {
  const sent: BrowserMessage[] = [];
  const model = createSessionModel("feedback", message => { sent.push(message); return true; }, () => true);
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } } });
  model.setDraft("My composer"); model.addFeedback("Original comment", card); flush();
  const id = model.feedback()[0].id;
  expect(model.editFeedback(id, "Updated comment")).toBe(true); flush();
  expect(model.feedback()[0].card).toEqual(card);
  expect(model.editFeedback(id, "x".repeat(32768))).toBe(false);
  expect(model.submitFeedback()).toBe(true); flush();
  expect(model.editFeedback(id, "Too late")).toBe(false);
  model.addFeedback("A later note", card); flush();
  const restored = modelFor("feedback");
  expect(restored.feedback()).toHaveLength(2);
  expect(restored.visibleNotice()).toContain("uncertain");
  expect(sent[0].action).toMatchObject({ text: expect.stringContaining("Updated comment") });
  expect(JSON.stringify(sent[0].action)).not.toContain("oldSecret");
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "result", result: { requestId: sent[0].requestId, ok: true, code: "accepted", disposition: "started", recoveredDraft: null } } }); flush();
  expect(modelFor("feedback").feedback().map(note => note.comment)).toEqual(["A later note"]);
  expect(model.draft()).toBe("My composer");
});

it("discards saved work only on confirmed deletion", () => {
  const model = modelFor();
  model.setDraft("Keep me"); model.addFeedback("My note", card); flush();
  model.dispose(true); flush();
  expect(modelFor().draft()).toBe("");
  expect(modelFor().feedback()).toEqual([]);
});

it("keeps work usable and warns when tab storage is full", async () => {
  vi.stubGlobal("sessionStorage", { getItem: () => null, removeItem: () => {}, setItem: () => { throw new DOMException("Full", "QuotaExceededError"); } });
  const model = modelFor();
  model.setDraft("Keep this text"); model.addFeedback("Keep this note", card); flush();
  expect(model.draft()).toBe("Keep this text");
  expect(model.feedback()).toHaveLength(1);
  await vi.waitFor(() => { flush(); expect(model.visibleNotice() ?? "").toContain("only in memory"); });
});

it("rejects malformed and over-budget saved data without sending or rendering it", () => {
  sessionStorage.setItem("pi-web:prompt-draft:v1:bad", JSON.stringify({ text: { html: "<script>bad</script>" }, uncertain: false }));
  sessionStorage.setItem("pi-web:feedback-draft:v1:bad", JSON.stringify({ notes: [{ id: "one", comment: "Test", card: { ...card, files: [{ ...card.files[0], lines: [{ kind: "add", next: "unsafe", text: "+bad" }] }] } }], uncertain: false }));
  const bad = modelFor("bad");
  expect(bad.draft()).toBe(""); expect(bad.feedback()).toEqual([]);
  expect(bad.visibleNotice()).toContain("could not be restored");
  sessionStorage.setItem("pi-web:prompt-draft:v1:large", "x".repeat(512 * 1024 + 1));
  expect(modelFor("large").draft()).toBe("");
});

