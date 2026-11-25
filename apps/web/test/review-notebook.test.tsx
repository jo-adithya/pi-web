import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { LocalReview } from "../src/LocalReview";
import { annotationSlots } from "../src/ReviewNotebook";
import { parseAuthorNotes } from "../src/author-notes";
import { createSessionModel } from "../src/session-model";
import { initialState } from "../src/client-state";
import { createLocalReview, type ReviewFile } from "../src/local-review";
import { authorThreads, changedHunks, createReviewNotebook, emptyNotebook, locateThread, reviewHunks, threadAnalysis, type ReviewNotebook, type ReviewRound, type ReviewThread } from "../src/review-notebook";

const file: ReviewFile = { checkoutKey: "a".repeat(64), path: "a.ts", previousPath: null, status: "modified", fingerprint: "one", patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n unchanged\n-old\n+new\n" };
const round = (): ReviewRound => ({ id: "round-1", label: "Round 1", source: "unstaged", files: [{ ...file, reviewed: false }] });
const thread = (): ReviewThread => ({ id: "thread-1", anchor: { round: "round-1", path: "a.ts", start: 5, end: 7 }, chapter: "Behavior", kind: "discussion", status: "open", messages: [{ role: "human", text: "Does this preserve the API?", model: null, usage: null }] });
const document = (): ReviewNotebook => ({ ...emptyNotebook(), rounds: [round()], threads: [thread()] });
const snapshot = () => ({ files: [file], truncated: false, note: null, snapshotKey: "a".repeat(64), checkoutKey: file.checkoutKey });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("uses raw patch coordinates and only relocates a unique unchanged quote", () => {
  expect(reviewHunks(file.patch)[0]).toMatchObject({ start: 4, end: 7 });
  const note = thread();
  expect(locateThread(document(), note, file)).toEqual({ start: 5, end: 7 });
  const shifted = { ...file, fingerprint: "two", patch: file.patch.replace("@@ -1,2 +1,2 @@", "@@ -11,2 +21,2 @@") };
  expect(locateThread(document(), note, shifted)).toEqual({ start: 5, end: 7 });
  expect(locateThread(document(), note, { ...file, patch: file.patch.replace("+new", "+different") })).toBeUndefined();
  expect(locateThread(document(), note, { ...file, patch: `${shifted.patch}@@ -30,2 +40,2 @@\n unchanged\n-old\n+new\n` })).toBeUndefined();
});

it("compares hunk content without flagging coordinate shifts and keeps removed hunks", () => {
  expect(changedHunks(file.patch, file.patch.replace("@@ -1,2 +1,2 @@", "@@ -20,2 +21,2 @@"))).toEqual({ changed: [], removed: [] });
  const change = changedHunks(file.patch, file.patch.replace("+new", "+fixed"));
  expect(change.changed[0].rows.at(-1)?.text).toBe("+fixed");
  expect(change.removed[0].rows.at(-1)?.text).toBe("+new");
  expect(changedHunks(file.patch, "").removed).toHaveLength(1);
});

it("imports author rationale only against exact selected source and never marks it verified", () => {
  const value = { notes: [{ path: "a.ts", side: "new", line: 2, quote: "new", text: "Preserve retries.", chapter: "Recovery" }] };
  const notes = authorThreads(value, round());
  expect(notes[0]).toMatchObject({ kind: "author", status: "open", chapter: "Recovery", anchor: { start: 7, end: 7 } });
  expect(notes[0].messages[0].role).toBe("author");
  expect(() => authorThreads({ notes: [{ ...value.notes[0], quote: "different" }] }, round())).toThrow("stale");
  expect(() => authorThreads({ notes: [{ ...value.notes[0], path: "missing" }] }, round())).toThrow();
});

it("routes jobs explicitly, excludes author assertions, and rejects oversized evidence", () => {
  const doc = document();
  doc.routes.explain = { provider: "fast", id: "explain" };
  doc.routes.review = { provider: "strong", id: "review" };
  doc.threads[0].messages.push({ role: "author", text: "TRUST ME EVERYTHING PASSES", model: null, usage: null });
  expect(threadAnalysis(doc, doc.threads[0], "explain").model).toEqual(doc.routes.explain);
  const request = threadAnalysis(doc, doc.threads[0], "review");
  expect(request.model).toEqual(doc.routes.review);
  expect(request.explain?.task).toBe("review");
  expect(JSON.stringify(request)).not.toContain("TRUST ME");
  expect(request.details).toEqual([{ path: "a.ts", startLine: 5, patch: " unchanged\n-old\n+new" }]);
  doc.routes.budget = 4096;
  doc.threads[0].messages.push({ role: "human", text: "a".repeat(4000), model: null, usage: null });
  expect(() => threadAnalysis(doc, doc.threads[0], "review")).toThrow("budget");
});

it("supplies the linked chapter hunk rather than an unrelated file prefix", () => {
  const doc = document();
  const patch = "@@ -1,200 +1,200 @@\n" + Array.from({ length: 200 }, (_, index) => ` line ${index + 1}`).join("\n");
  doc.rounds[0].files.push({ ...file, path: "caller.ts", patch, reviewed: false });
  doc.threads.push({ ...thread(), id: "thread-2", anchor: { round: "round-1", path: "caller.ts", start: 190, end: 195 } });
  const request = threadAnalysis(doc, doc.threads[0], "review", { provider: "fixture", id: "model" });
  expect(request.details[1].startLine).toBe(190);
  expect(request.details[1].patch).toContain("line 189");
  expect(request.details[1].patch).not.toContain("line 1\n");
});

it("keeps bounded follow-up context while excluding author notes and prior AI opinions from independent review", () => {
  const doc = document(), item = doc.threads[0];
  item.messages.push(
    { role: "author", text: "Author claims everything is safe", model: null, usage: null },
    { role: "assistant", text: "Earlier interpretation of retries", model: "fixture/model", usage: null },
    { role: "human", text: "What happens if that call fails?", model: null, usage: null },
  );
  const explain = threadAnalysis(doc, item, "explain", { provider: "fixture", id: "model" }).explain!.question!;
  expect(explain).toContain(item.messages[0].text);
  expect(explain).toContain("Earlier interpretation of retries");
  expect(explain).toContain("What happens if that call fails?");
  expect(explain).not.toContain("Author claims");
  const independent = threadAnalysis(doc, item, "review", { provider: "fixture", id: "model" }).explain!.question!;
  expect(independent).not.toContain("Earlier interpretation of retries");
});

/** An independent in-memory HTTP contract: loads, revision checks, and explicit inference are distinct. */
function server(initial = emptyNotebook(), authorNotes?: unknown) {
  let stored = structuredClone(initial), failWrite = false, liveFile = file;
  let calls = 0;
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/source")) {
      if (body.kind === "preferences") return new Response(JSON.stringify({ enabled: authorNotes !== undefined }));
      if (body.kind === "author" && body.automatic) {
        const value = authorNotes as { notes: unknown[] };
        return new Response(JSON.stringify({ ...value, notes: value.notes.map(note => ({ ...(note as object), binding: { recordedBy: "tool-v1", checkoutKey: file.checkoutKey, base: "b".repeat(40), head: "c".repeat(40), fingerprint: "d".repeat(64), patch: file.patch } })) }));
      }
    }
    if (url.endsWith("/notebook")) {
      if (body.document) {
        if (failWrite) { failWrite = false; return new Response(JSON.stringify({ error: "Storage failed" }), { status: 500 }); }
        if (body.revision !== stored.revision) return new Response(JSON.stringify({ error: "Conflict; reload" }), { status: 409 });
        stored = { ...structuredClone(body.document), revision: stored.revision + 1 };
      }
      return new Response(JSON.stringify(stored));
    }
    if (url.endsWith("/groups")) {
      calls++;
      return new Response(JSON.stringify({ explanation: { observations: [{ text: "The selected return changed.", citations: [{ path: "a.ts", startLine: body.details[0].startLine, endLine: body.details[0].startLine }] }], inferences: [], risks: [], limitations: ["No tests ran."] }, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: .001 } }));
    }
    return new Response(JSON.stringify({ ...snapshot(), files: [liveFile] }));
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, stored: () => stored, calls: () => calls, failWrite: () => { failWrite = true; }, changeFile: (next: ReviewFile) => { liveFile = next; } };
}

it("saves live discussions without rounds and makes changed source stale without erasing replies", async () => {
  const remote = server();
  let current = file;
  const review = createLocalReview(async () => ({ ...snapshot(), files: [current] }));
  const book = createReviewNotebook("session", () => "cap", review, () => ({ provider: "fixture", id: "model" }));
  await review.refresh(); await book.load();
  expect(await book.addThread(file, 5, 7, "Does this preserve retries?")).toBe(true);
  expect(remote.stored().rounds).toEqual([]);
  const note = book.document()!.threads[0];
  expect(note.anchor.live?.quote).toBe(" unchanged\n-old\n+new");
  expect(book.isStale(note)).toBe(false);
  await book.updateThread(note.id, thread => ({ ...thread, status: "verified" }));
  current = { ...file, fingerprint: "two", patch: file.patch.replace("+new", "+fixed") };
  await review.refresh(); flush();
  expect(book.isStale(book.document()!.threads[0])).toBe(true);
  expect(book.document()!.threads[0].messages[0].text).toBe("Does this preserve retries?");
  await book.ask(book.document()!.threads[0], "review");
  expect(book.error()).toContain("stale");
  expect(remote.calls()).toBe(0);
  const resumed = createReviewNotebook("session", () => "cap", review, () => undefined);
  await resumed.load();
  expect(resumed.isStale(resumed.document()!.threads[0])).toBe(true);
  expect(remote.stored().rounds).toEqual([]);
});

it("rechecks live source before an explicit AI call and blocks changed or unavailable evidence", async () => {
  const remote = server();
  let current = file, failRead = false;
  const review = createLocalReview(async () => { if (failRead) throw new Error("Source unavailable"); return { ...snapshot(), files: [current] }; });
  const book = createReviewNotebook("session", () => "cap", review, () => ({ provider: "fixture", id: "model" }));
  await review.refresh(); await book.load();
  await book.addThread(file, 5, 7, "Check cancellation.");
  const note = book.document()!.threads[0];
  await book.ask(note, "review");
  expect(remote.calls()).toBe(1);
  expect(book.document()!.threads[0].messages.at(-1)?.role).toBe("assistant");
  expect(remote.stored().rounds).toEqual([]);
  // Disk changes are detected even when the displayed diff is still the previous one.
  current = { ...file, fingerprint: "changed", patch: file.patch.replace("+new", "+fixed") };
  await book.ask(book.document()!.threads[0], "review");
  expect(book.error()).toContain("stale");
  expect(remote.calls()).toBe(1);
  failRead = true;
  await book.ask(book.document()!.threads[0], "review");
  expect(book.error()).toBe("Source unavailable");
  expect(remote.calls()).toBe(1);
});

it("keeps continuous chapter reviews usable after an older linked discussion becomes stale", async () => {
  server();
  let other = { ...file, path: "caller.ts", fingerprint: "caller-one" };
  const review = createLocalReview(async () => ({ ...snapshot(), files: [file, other] }));
  const book = createReviewNotebook("session", () => "cap", review, () => ({ provider: "fixture", id: "model" }));
  await review.refresh(); await book.load();
  await book.addThread(file, 5, 7, "Check retries.", "Recovery");
  await book.addThread(other, 5, 7, "Old caller discussion.", "Recovery");
  other = { ...other, fingerprint: "caller-two", patch: other.patch.replace("+new", "+fixed") };
  await review.refresh();
  await book.addThread(other, 5, 7, "Fresh caller discussion.", "Recovery");
  const request = book.analysisInput(book.document()!.threads[0], "review");
  expect(request.details).toHaveLength(2);
  expect(request.details[1].patch).toContain("+fixed");
  expect(request.details[1].patch).not.toContain("+new");
});

it("marks a live discussion stale across checkout and scope changes", async () => {
  server();
  const review = createLocalReview(async () => snapshot());
  const book = createReviewNotebook("session", () => "cap", review, () => undefined);
  await review.refresh(); await book.load(); await book.addThread(file, 5, 7, "Check this.");
  const note = book.document()!.threads[0];
  expect(locateThread(book.document()!, note, { ...file, checkoutKey: "f".repeat(64) }, undefined, JSON.stringify(review.target()))).toBeUndefined();
  await review.refresh("staged");
  expect(book.isStale(note)).toBe(true);
  expect(await book.updateThread(note.id, thread => ({ ...thread, status: "verified" }))).toBe(false);
});

it("resumes retained rounds and reviewed marks without reading changed workspace content", async () => {
  const remote = server();
  const read = vi.fn(async () => ({ ...snapshot(), files: [{ ...file, lineStats: { added: 1, removed: 1 } }] })), review = createLocalReview(read);
  const book = createReviewNotebook("session", () => "cap", review, () => undefined);
  await review.refresh(); await book.load(); await book.capture("First review"); flush();
  expect(remote.stored().rounds).toHaveLength(1);
  expect(remote.stored().rounds[0].files[0]).not.toHaveProperty("lineStats");
  expect(review.saved()).toBe(true);
  await book.mark(file, true); flush();
  const secondReview = createLocalReview(vi.fn(async () => { throw new Error("Must not read workspace"); }));
  const second = createReviewNotebook("session", () => "cap", secondReview, () => undefined);
  await second.load(); second.openRound(second.document()!.rounds[0]); flush();
  expect(secondReview.snapshot()?.files[0].patch).toBe(file.patch);
  expect(secondReview.isReviewed(secondReview.snapshot()!.files[0])).toBe(true);
  expect(remote.calls()).toBe(0);
});

it("does not duplicate a live author note already present in a durable discussion", () => {
  const input = { notes: [{ path: "a.ts", side: "new", line: 2, quote: "new", text: "Preserve retries." }] };
  const doc = { ...document(), threads: authorThreads(input, round()) };
  const slots = [...annotationSlots(doc, file, parseAuthorNotes(input)).values()];
  expect(slots.flatMap(slot => slot.threads)).toHaveLength(1);
  expect(slots.flatMap(slot => slot.authors ?? [])).toHaveLength(0);
});

it("keeps saved author notes bound to their checkout and whole hunk", () => {
  const doc = document();
  const author: ReviewThread = { ...thread(), kind: "author", anchor: { ...thread().anchor, start: 7, end: 7 }, messages: [{ role: "author", text: "Keep retries.", model: null, usage: null }] };
  expect(locateThread(doc, author, file)).toEqual({ start: 7, end: 7 });
  expect(locateThread(doc, author, { ...file, checkoutKey: "f".repeat(64) })).toBeUndefined();
  expect(locateThread(doc, author, { ...file, patch: file.patch.replace("-old", "-different") })).toBeUndefined();
  doc.rounds[0].files[0] = { ...doc.rounds[0].files[0], checkoutKey: undefined };
  const legacy = { ...file, checkoutKey: undefined };
  expect(locateThread(doc, author, legacy, "round-1")).toEqual({ start: 7, end: 7 });
  expect(locateThread(doc, author, legacy)).toBeUndefined();
});

it("automatically saves matching author notes with a captured round without inference", async () => {
  const remote = server(emptyNotebook(), { notes: [
    { path: "a.ts", side: "new", line: 2, quote: "new", text: "Preserve retries." },
    { path: "a.ts", side: "new", line: 2, quote: "stale", text: "Outdated rationale." },
  ] });
  const review = createLocalReview(async () => snapshot());
  const book = createReviewNotebook("session", () => "cap", review, () => undefined);
  await review.refresh(); await book.load(); await book.capture("With notes"); flush();
  expect(remote.stored().threads).toHaveLength(1);
  expect(remote.stored().threads[0]).toMatchObject({ kind: "author", status: "open", messages: [{ role: "author", text: "Preserve retries." }] });
  expect(remote.calls()).toBe(0);
});

it("collects author notes once when the real session model receives a completed run", async () => {
  const remote = server(emptyNotebook(), { turn: "epoch:1", notes: [{ path: "a.ts", side: "new", line: 2, quote: "new", text: "Completed turn rationale." }] });
  const model = createSessionModel("session", () => true, () => true, undefined, () => "cap");
  model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } } }); flush();
  const done = { v: 1, sessionId: "session", epoch: "epoch", body: { type: "run_completed", runId: "1", outcome: "success" } } as const;
  model.receive(done); model.receive(done); flush();
  await waitFor(() => expect(model.notebook.authorNotes()).toHaveLength(1));
  expect(remote.fetcher.mock.calls.filter(([, init]) => JSON.parse(String(init.body)).kind === "author")).toHaveLength(1);
  expect(remote.calls()).toBe(0);
  model.dispose();
});

it("refreshes live discussions on completion even when automatic author notes are disabled", async () => {
  const remote = server();
  const model = createSessionModel("session", () => true, () => true, undefined, () => "cap");
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } } });
  await model.review.refresh(); await model.notebook.load();
  await model.notebook.addThread(file, 5, 7, "Check retries.");
  remote.changeFile({ ...file, fingerprint: "changed", patch: file.patch.replace("+new", "+fixed") });
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "run_completed", runId: "1", outcome: "success" } }); flush();
  await waitFor(() => expect(model.review.snapshot()?.files[0].fingerprint).toBe("changed"));
  expect(model.notebook.isStale(model.notebook.document()!.threads[0])).toBe(true);
  expect(remote.calls()).toBe(0);
  model.dispose();
});

it("rejects notes from an earlier turn even if their quotes still match", async () => {
  const notes = { turn: "epoch:1", notes: [{ path: "a.ts", side: "new", line: 2, quote: "new", text: "Old rationale." }] };
  const remote = server(emptyNotebook(), notes);
  const book = createReviewNotebook("session", () => "cap", createLocalReview(async () => snapshot()), () => undefined);
  await book.collectAuthorNotes("epoch:2"); flush();
  expect(book.authorNotes()).toEqual([]);
  expect(book.authorNotice()).toContain("Earlier notes were not attached");
  notes.turn = "epoch:2";
  await book.collectAuthorNotes(); flush();
  expect(book.authorNotes()).toHaveLength(1);
  expect(remote.calls()).toBe(0);
});

it("loads discussions and automatic notes beside live code without an explicit notebook step", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const remote = server(emptyNotebook(), { notes: [
    { path: "a.ts", side: "new", line: 2, quote: "new", text: "Keep the recovery path." },
    { path: "a.ts", side: "new", line: 2, quote: "missing", text: "Stale note." },
  ] });
  const model = createSessionModel("auto-notes-ui", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={vi.fn()} />);
  const summary = await page.findByText("Author note · Keep the recovery path.");
  expect(summary.closest("details")!.open).toBe(false);
  expect(summary.closest('[aria-label="Hunk discussion"]')).not.toBeNull();
  expect(page.getByText("1 unmatched author notes for this file")).toBeTruthy();
  expect(model.notebook.document()).toBeDefined();
  expect(remote.calls()).toBe(0);
  page.unmount(); model.dispose();
});

it("releases captured source from the reader when the saved review is cleared", async () => {
  const remote = server(document()), review = createLocalReview(async () => snapshot());
  const book = createReviewNotebook("session", () => "cap", review, () => undefined);
  await book.load(); book.openRound(book.document()!.rounds[0]); flush();
  expect(review.saved()).toBe(true);
  expect(await book.save(emptyNotebook())).toBe(true); flush();
  expect(review.saved()).toBe(false);
  expect(review.snapshot()).toBeUndefined();
  expect(book.activeRound()).toBe("");
  expect(remote.calls()).toBe(0);
});

it("retains a paid answer after storage failure and retries persistence without another model call", async () => {
  const remote = server(document());
  const book = createReviewNotebook("session", () => "cap", createLocalReview(async () => snapshot()), () => ({ provider: "fixture", id: "model" }));
  await book.load(); remote.failWrite();
  await book.ask(book.document()!.threads[0], "review"); flush();
  expect(remote.calls()).toBe(1);
  expect(book.unsavedAnswer()?.message.text).toContain("selected return changed");
  expect(book.document()!.threads[0].status).toBe("open");
  await book.load(); await book.persistAnswer(); flush();
  expect(book.unsavedAnswer()).toBeUndefined();
  expect(remote.calls()).toBe(1);
  expect(remote.stored().threads[0].messages.at(-1)?.usage).toContain("100 input");
  expect(remote.stored().threads[0].status).toBe("open");
});

it("shows stale discussions and retains fix requests without creating review snapshots", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const remote = server();
  const transport = vi.fn(() => true);
  const model = createSessionModel("continuous-ui", transport, () => true, undefined, () => "cap");
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: model.id, epoch: "epoch", body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } } });
  const page = render(() => <LocalReview model={model} conversation={vi.fn()} />);
  await page.findByText("Discuss this hunk");
  await model.notebook.addThread(file, 5, 7, "Check retry cleanup.");
  const note = model.notebook.document()!.threads[0];
  await model.notebook.updateThread(note.id, thread => ({ ...thread, status: "verified" }));
  remote.changeFile({ ...file, fingerprint: "two", patch: file.patch.replace("+new", "+fixed") });
  await model.review.refresh(); flush();
  fireEvent.click(page.getByText("Other and stale discussions · 1")); flush();
  fireEvent.click(page.getByText("Discussion · Stale · Check retry cleanup.")); flush();
  expect(page.getByText(/Previous status: verified/)).toBeTruthy();
  expect((page.getByRole("button", { name: "Verify resolution" }) as HTMLButtonElement).disabled).toBe(true);
  expect((page.getByRole("button", { name: "Run explanation · 1 AI call" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(page.getByRole("button", { name: "Request fix from coding agent" })); flush();
  expect(transport).toHaveBeenCalledWith(expect.objectContaining({ action: expect.objectContaining({ type: "prompt", text: expect.stringContaining("Check retry cleanup.") }) }));
  expect(remote.stored().rounds).toEqual([]);
  expect(remote.calls()).toBe(0);
  page.unmount(); model.dispose();
});

it("keeps review and discussion in the diff and requires an explicit click before paid analysis", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const remote = server();
  const model = createSessionModel("notebook-ui", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={vi.fn()} />);
  await page.findByRole("heading", { name: file.path });
  await page.findByText("Discuss this hunk");
  expect(page.queryByRole("button", { name: "Save current round" })).toBeNull();
  fireEvent.click(page.getByText("Discuss this hunk")); flush();
  fireEvent.input(page.getByRole("textbox", { name: "Hunk feedback" }), { target: { value: "Does this preserve retries?" } }); flush();
  fireEvent.click(page.getByRole("button", { name: "Save discussion" })); flush();
  await waitFor(() => expect(remote.stored().threads).toHaveLength(1));
  expect(remote.calls()).toBe(0);
  expect(remote.stored().rounds).toEqual([]);
  await waitFor(() => expect(page.getByLabelText("Hunk discussion").textContent).toContain("Does this preserve retries?"));
  const summary = page.getByText(/Discussion · open · Does this preserve retries/);
  fireEvent.click(summary); flush();
  fireEvent.click(page.getByText("Ask AI beside this code")); flush();
  expect((page.getByRole("button", { name: "Run explanation · 1 AI call" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Choose an available review model first.")).toBeTruthy();
  expect(remote.calls()).toBe(0);
});
