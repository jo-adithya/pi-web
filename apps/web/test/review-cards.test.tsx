import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { createReviewCards, fileReviewCard, scopeReviewCard, reviewMessageParts, reviewMessageContent } from "../src/review-cards";
import { reviewDraft, reviewScopeDraft, type ReviewFile } from "../src/local-review";
import { MessageList } from "../src/Conversation";
import { initialState } from "../src/client-state";
import { createSessionModel } from "../src/session-model";
import type { BrowserMessage } from "../src/generated/protocol";
import { ReviewDiffCard } from "../src/components/ReviewDiffCard";

const file: ReviewFile = { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", fingerprint: "snapshot-1", patch: "@@ -8,2 +10,2 @@\n-oldSecret();\n+const count = 2;\n unchanged();" };
beforeEach(() => sessionStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("sends filenames, exact disjoint old/new ranges and scope without code", () => {
  const lines = [{ kind: "remove" as const, old: 8, text: "-oldSecret();" }, { kind: "add" as const, next: 10, text: "+const count = 2;" }, { kind: "add" as const, next: 12, text: "+anotherSecret();" }];
  const text = reviewDraft("Why?", file, { scope: "commit", commit: "abc123" }, lines);
  expect(text).toContain('commit abc123 against its first parent');
  expect(text).toContain('"src/new.ts"'); expect(text).toContain('Previous path: "src/old.ts"');
  expect(text).toContain("Old lines: 8\nNew lines: 10, 12");
  expect(text).not.toContain(file.fingerprint);
  expect(text).not.toContain("Snapshot:");
  for (const code of ["oldSecret", "const count", "anotherSecret", "unchanged()", "@@"]) expect(text).not.toContain(code);
  const card = fileReviewCard(file, { scope: "commit", commit: "abc123" }, lines);
  expect(card.files[0].lines).toEqual(lines);
  expect(card.files[0].lines).not.toBe(lines);
  expect(reviewMessageParts(text, [card])).toEqual(["Why?\n\n", card]);
});

it("renders a collapsed diff card in user chat, preserving the question and safe source text", async () => {
  const card = fileReviewCard(file, { scope: "staged" });
  const state = initialState(); state.order = ["q"];
  state.messages.q = { id: "q", role: "user", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: reviewDraft("Why change this?", file, { scope: "staged" }) }] };
  const page = render(() => <MessageList state={state} reviewCards={[card]} />); flush();
  expect(page.getByText("Why change this?")).toBeTruthy();
  const bubble = page.container.querySelector("article.message.user")!;
  const cardElement = page.container.querySelector(".chat-review-card")!;
  expect(bubble.contains(cardElement)).toBe(false);
  expect(cardElement.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(page.getByText("References only")).toBeTruthy();
  expect(page.queryByRole("region", { name: "Diff for src/new.ts" })).toBeNull();
  const details = page.container.querySelector("details")!;
  details.open = true; await fireEvent(details, new Event("toggle")); flush();
  const diff = page.getByRole("region", { name: "Diff for src/new.ts" });
  expect(diff.textContent).toContain("-oldSecret();"); expect(diff.textContent).toContain("+const count = 2;");
  expect(diff.querySelector(".remove")?.textContent).toContain("8");
  expect(diff.querySelector(".add")?.textContent).toContain("10");
  expect(diff.querySelector(".hljs-keyword")).not.toBeNull();
  expect(diff.querySelector(".chat-review-columns")).toBeNull();
});

it("shows just the selected-line question while keeping generated instructions in the actual message", () => {
  const card = fileReviewCard(file, { scope: "unstaged" });
  const text = reviewDraft("Review only. Do not edit files or run mutating commands.\n\nQuestion: whats this for?", file, { scope: "unstaged" });
  const state = initialState(); state.order = ["q"];
  state.messages.q = { id: "q", role: "user", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text }] };
  const page = render(() => <MessageList state={state} reviewCards={[card]} />); flush();
  expect(page.getByText("whats this for?")).toBeTruthy();
  expect(page.container.querySelector("article")?.textContent).not.toContain("Review only");
  expect(page.container.querySelector("article")?.textContent).not.toContain("Question:");
  expect(state.messages.q.blocks[0].text).toBe(text);
});

it("hides preset scaffolding only beside a known reference and preserves ordinary text", () => {
  const target = { scope: "staged" as const };
  const card = fileReviewCard(file, target);
  const text = reviewDraft("My draft", file, target, undefined, "risks");
  const display = reviewMessageContent(text, [card]);
  expect(display.text).toContain("My draft"); expect(display.text).toContain("What could break?");
  expect(display.text).not.toContain("Review only.");
  expect(reviewMessageContent(text, []).text).toBe(text);
  const question = "Question: should this say Review only.?";
  expect(reviewMessageContent(reviewDraft(question, file, target), [card]).text).toBe(question);
  const second = fileReviewCard({ ...file, path: "second.ts" }, target);
  const combined = reviewMessageContent(`First question\n\n${card.reference}\n\nSecond question\n\n${second.reference}`, [card, second]);
  expect(combined.cards).toEqual([card, second]);
  expect(combined.text).toContain("First question"); expect(combined.text).toContain("Second question");
});

it("retains multiple cards across remount/reload and falls back to references for edited or evicted entries", () => {
  const store = createReviewCards("one"), card = fileReviewCard(file, { scope: "unstaged" });
  store.remember(card); flush();
  expect(createReviewCards("one").cards()).toEqual([card]);
  expect(createReviewCards("two").cards()).toEqual([]);
  const changed = card.reference.replace("New lines: 10", "New lines: 100");
  expect(reviewMessageParts(changed, store.cards())).toEqual([changed]);
  for (let i = 0; i < 16; i++) store.remember(fileReviewCard({ ...file, path: `later-${i}.ts`, fingerprint: `later-${i}` }, { scope: "staged" }));
  flush(); expect(store.cards()).toHaveLength(16);
  expect(reviewMessageParts(card.reference, store.cards())).toEqual([card.reference]);
  sessionStorage.setItem("pi-web:review-cards:v1:bad", '[{"files":null}]');
  expect(createReviewCards("bad").cards()).toEqual([]);
});

it("does not replace old previews when identical references are reused after edits", () => {
  const store = createReviewCards("reused");
  const first = fileReviewCard(file, { scope: "staged" });
  const second = fileReviewCard({ ...file, fingerprint: "new-snapshot", patch: file.patch.replace("const count = 2", "const count = 3") }, { scope: "staged" });
  expect(first.reference).toBe(second.reference);
  store.remember(first); store.remember(second); flush();
  expect(store.cards()[0].ambiguous).toBe(true);
  expect(store.cards()[0].files[0].lines).toBeNull();
  const restored = createReviewCards("reused"); restored.remember(second); flush();
  expect(restored.cards()[0].ambiguous).toBe(true);
});

it("keeps previews working without storage and bounds oversized snapshots", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
  const store = createReviewCards("memory"), card = fileReviewCard(file, { scope: "unstaged" });
  store.remember(card); flush(); expect(store.cards()).toEqual([card]);
  store.remember(fileReviewCard({ ...file, path: "huge.ts", fingerprint: "huge", patch: "+" + "x".repeat(1024 * 1024) }, { scope: "unstaged" }));
  flush(); expect(store.cards()).toEqual([]);
});

it("shows all-change file sections and loads missing previews explicitly without sending code", async () => {
  const unloaded = { ...file, path: "missing.ts", patch: null, fingerprint: null };
  const snapshot = { files: [file, unloaded], truncated: true, note: "Limited", snapshotKey: "snapshot-all" };
  const target = { scope: "branch" as const, base: "main" };
  const card = scopeReviewCard(snapshot, target);
  const text = reviewScopeDraft("Question", snapshot, target, "risks");
  expect(text).not.toContain("oldSecret"); expect(text).not.toContain("const count");
  expect(text).toContain("file list is incomplete"); expect(text).toContain("missing.ts");
  expect(text).not.toContain(file.fingerprint);
  expect(text).not.toContain(snapshot.snapshotKey);
  expect(text).not.toContain('"snapshot":');
  expect(reviewMessageParts(text, [card]).at(-1)).toEqual(card);
  const load = vi.fn(async (_request: unknown, _signal: AbortSignal) => ({ ...file, path: "missing.ts" }));
  const page = render(() => <ReviewDiffCard card={card} load={load} />);
  const root = page.container.querySelector("details")!;
  root.open = true; await fireEvent(root, new Event("toggle")); flush();
  const section = page.getByText("missing.ts").closest("details")!;
  section.open = true; await fireEvent(section, new Event("toggle")); flush();
  expect(load).not.toHaveBeenCalled();
  await fireEvent.click(page.getByRole("button", { name: "Load current diff" }));
  await waitFor(() => expect(page.getByText("Current diff · may differ from the original review")).toBeTruthy());
  expect(load.mock.calls[0][0]).toEqual({ scope: "branch", base: "main", path: "missing.ts" });
  expect(page.getByRole("region", { name: "Diff for missing.ts" }).textContent).toContain("oldSecret");
  expect(card.files[1].lines).toBeNull();
});

it("sends reference-only drafts for file and all-change questions even with cached previews", () => {
  const snapshot = { files: [file], truncated: false, note: null };
  const target = { scope: "staged" as const };
  for (const [index, card] of [fileReviewCard(file, target), scopeReviewCard(snapshot, target)].entries()) {
    const transport = vi.fn((_message: BrowserMessage) => true);
    const model = createSessionModel(`wire-${index}`, transport, () => true);
    const envelope = { v: 1 as const, sessionId: model.id, epoch: "epoch" };
    model.receive({ ...envelope, body: { type: "hello", project: "fixture", process: "ready" } });
    model.receive({ ...envelope, body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } } });
    const text = index === 0 ? reviewDraft("Question", file, target) : reviewScopeDraft("Question", snapshot, target, "explain");
    model.reviewCards.remember(card); model.setDraft(text); flush(); model.submit(); flush();
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0].action).toEqual({ type: "prompt", text, images: [] });
    expect(JSON.stringify(transport.mock.calls)).not.toMatch(/oldSecret|const count|unchanged/);
    expect(model.reviewCards.cards()[0].files[0].lines?.map(line => line.text).join("\n")).toContain("oldSecret");
    model.dispose();
  }
});

it("renders source markup as inert text", async () => {
  const malicious = { ...file, patch: '@@ -1 +1 @@\n+<img src=x onerror=alert(1)>' };
  const page = render(() => <ReviewDiffCard card={fileReviewCard(malicious, { scope: "unstaged" })} />);
  const root = page.container.querySelector("details")!;
  root.open = true; await fireEvent(root, new Event("toggle")); flush();
  expect(page.getByRole("region").textContent).toContain("<img src=x onerror=alert(1)>");
  expect(page.container.querySelector("img")).toBeNull();
});

it("never turns assistant text into a local preview card", () => {
  const card = fileReviewCard(file, { scope: "unstaged" });
  const state = initialState(); state.order = ["a"];
  state.messages.a = { id: "a", role: "assistant", complete: true, truncated: false, error: null, blocks: [{ kind: "text", text: card.reference }] };
  const page = render(() => <MessageList state={state} reviewCards={[card]} />); flush();
  expect(page.queryByText("References only")).toBeNull();
});
