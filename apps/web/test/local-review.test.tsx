import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { LocalReview } from "../src/LocalReview";
import { SettingsPage } from "../src/SettingsPage";
import { createSessionModel } from "../src/session-model";
import { initialState } from "../src/client-state";
import type { BrowserMessage } from "../src/generated/protocol";
import { createLocalReview, diffLines, fetchReview, reviewDraft, reviewScopeDraft, type ReviewEntry, type ReviewFile, type ReviewSnapshot } from "../src/local-review";

const file: ReviewFile = { fingerprint: "snapshot-a", path: "src/a.ts", previousPath: null, status: "modified", patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n same\n-old\n+<script>alert(1)</script>\n" };
const snapshot = (files: ReviewEntry[] = [file]): ReviewSnapshot => ({ files, truncated: false, note: null });
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); vi.spyOn(window, "scrollTo").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("prepares focused selection questions without sending or replacing the draft", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const transport = vi.fn(() => true), conversation = vi.fn();
  const model = createSessionModel("questions", transport, () => true, undefined, () => "cap");
  model.setDraft("My question");
  const page = render(() => <LocalReview model={model} conversation={conversation} />);
  await page.findByRole("button", { name: "Select new line 2" });
  fireEvent.click(page.getByRole("button", { name: "Select new line 2" })); flush();
  fireEvent.keyDown(page.getByRole("button", { name: "Focused questions" }), { key: "Enter" }); flush();
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "What could break?" }), { key: "Enter" }); flush();
  expect(model.draft()).toBe("My question");
  expect((screen.getByRole("textbox", { name: "Your question" }) as HTMLTextAreaElement).value).toContain("What could break?");
  expect(screen.getByLabelText("Selected code").textContent).toContain("2+<script>alert(1)</script>");
  expect(screen.getByLabelText("Selected code").textContent).not.toContain("-old");
  expect(transport).not.toHaveBeenCalled();
  expect(conversation).not.toHaveBeenCalled();
});

it("omits the toolbar Ask dropdown while retaining grouping and file/selection questions", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const model = createSessionModel("ask-actions", vi.fn(() => true), () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("button", { name: "Select new line 2" });
  expect(page.queryByRole("button", { name: /^Ask$/ })).toBeNull();
  expect(page.queryByRole("region", { name: "Ask" })).toBeNull();
  expect(page.getByRole("button", { name: "Group with AI" })).toBeTruthy();
  expect(page.getByRole("button", { name: "Ask Pi about file" })).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Select new line 2" })); flush();
  expect(page.getByRole("button", { name: "Ask Pi about selected lines" })).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Overview" })); flush();
  expect(page.queryByRole("button", { name: /^Ask$/ })).toBeNull();
});



it("keeps overall questions tied to the exact Git comparison and reports incomplete evidence", () => {
  const partial = { ...snapshot(), truncated: true, nextCursor: "next" };
  const branch = reviewScopeDraft("Notes", partial, { scope: "branch", base: "release/v2" }, "risks");
  expect(branch).toContain('branch changes against merge-base with "release/v2"');
  expect(branch).toContain("file list is incomplete");
  expect(branch).toContain("Discover the remaining files");
  expect(branch).toContain("not just the selected file");
  expect(branch).not.toContain(file.patch);
  expect(reviewScopeDraft("", snapshot(), { scope: "commit", commit: "abc123" }, "explain")).toContain("commit abc123 against its first parent (empty tree for a root commit)");
  expect(reviewScopeDraft("", snapshot(), { scope: "staged" }, "security")).toContain("overall local staged changes");
  expect(reviewScopeDraft("Notes", snapshot(), { scope: "unstaged" }, "security")).toMatch(/^Notes\n\n/);
  expect(reviewScopeDraft("/existing notes", snapshot(), { scope: "unstaged" }, "security")).toMatch(/^\/existing notes\n\n/);
  expect(() => reviewScopeDraft("🙂".repeat(9000), snapshot(), { scope: "unstaged" }, "risks")).toThrow("message limit");
});


it("sends file questions separately while preserving draft commands and a pending quote", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const transport = vi.fn((_message: BrowserMessage) => true), conversation = vi.fn();
  const model = createSessionModel("file-question", transport, () => true, undefined, () => "cap");
  model.receive({ v: 1, sessionId: model.id, epoch: "e", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: model.id, epoch: "e", body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } } });
  model.setDraft("/existing keep these arguments");
  model.quoteReply({ author: "Pi", text: "Quoted context" }); flush();
  const quote = model.quote();
  const page = render(() => <LocalReview model={model} conversation={conversation} />);
  await page.findByRole("button", { name: "Select new line 2" });
  // A file question must include all changes even when a line is selected.
  fireEvent.click(page.getByRole("button", { name: "Select new line 2" })); flush();
  fireEvent.click(page.getByRole("button", { name: "Ask Pi about file" })); flush();
  expect(screen.getByRole("dialog", { name: "Ask Pi about file" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Send to Pi" }) as HTMLButtonElement).disabled).toBe(true);
  expect(transport).not.toHaveBeenCalled(); expect(conversation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Explain change" })); flush();
  fireEvent.click(screen.getByRole("button", { name: "Send to Pi" })); flush();
  expect(transport).toHaveBeenCalledOnce();
  const action = transport.mock.calls[0][0].action;
  expect(action.type).toBe("prompt");
  if (action.type !== "prompt") throw new Error("Expected prompt");
  expect(action.text).toContain("Explain this");
  expect(action.text).toContain("src/a.ts");
  expect(action.text).toContain("All changed lines");
  expect(action.text).toContain("Old lines: 2\nNew lines: 2");
  expect(action.text).not.toMatch(/\/skill:|Quoted context|existing keep|<script>/);
  expect(model.draft()).toBe("/existing keep these arguments"); expect(model.quote()).toBe(quote);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(conversation).toHaveBeenCalledOnce();
});

it("validates the modal question budget independently and cancels without changing the composer", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const conversation = vi.fn(), transport = vi.fn(() => true);
  const model = createSessionModel("quoted-budget", transport, () => true, undefined, () => "cap");
  const draft = "x".repeat(32768);
  model.setDraft(draft); model.quoteReply({ author: "Pi", text: "é" }); flush();
  const quote = model.quote();
  const page = render(() => <LocalReview model={model} conversation={conversation} />);
  await page.findByRole("button", { name: "Select new line 2" });
  fireEvent.click(page.getByRole("button", { name: "Ask Pi about file" })); flush();
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.input(screen.getByRole("textbox", { name: "Your question" }), { target: { value: draft } }); flush();
  expect(screen.getByRole("alert").textContent).toContain("exceed the message limit");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); flush();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(model.draft()).toBe(draft); expect(model.quote()).toBe(quote);
  expect(conversation).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
});

it("counts explicit user skill commands in the complete draft byte limit", () => {
  const target = { scope: "unstaged" as const };
  const plain = reviewDraft("", file, target, undefined, "risks");
  const draft = "x".repeat(32768 - new TextEncoder().encode(plain).length - 2);
  expect(new TextEncoder().encode(reviewDraft(draft, file, target, undefined, "risks")).length).toBe(32768);
  expect(() => reviewDraft(`/skill:assess-impact ${draft}`, file, target, undefined, "risks")).toThrow("message limit");
});

it("generates explanations only on request and links validated evidence without marking or sending", async () => {
  const explanation = { explanation: { observations: [{ text: "Replaces the old expression.", citations: [{ path: file.path, startLine: 6, endLine: 7 }] }], inferences: [], risks: [], limitations: ["Only the supplied patch."] } };
  const fetch = vi.fn(async (url: string, init: RequestInit) => new Response(JSON.stringify(url.endsWith("/groups")
    ? JSON.parse(init.body as string).explain ? explanation : { groups: [{ title: "Behavior", reason: "Related change", paths: [file.path] }] }
    : snapshot())));
  vi.stubGlobal("fetch", fetch);
  const transport = vi.fn(() => true), conversation = vi.fn();
  const model = createSessionModel("explain", transport, () => true, undefined, () => "cap");
  model.setDraft("Keep draft");
  const page = render(() => <LocalReview model={model} conversation={conversation} />);
  await page.findByRole("heading", { name: file.path });
  fireEvent.click(page.getByRole("button", { name: "Group with AI" }));
  await page.findByRole("button", { name: "Regenerate groups" });
  fireEvent.click(page.getByRole("button", { name: "Overview" })); flush();
  const calls = () => fetch.mock.calls.filter(([, init]) => JSON.parse(init.body as string).explain);
  expect(calls()).toHaveLength(0);
  fireEvent.click(page.getByRole("button", { name: "Explain this group" }));
  await page.findByText("Replaces the old expression.");
  expect(calls()).toHaveLength(1);
  expect(page.getByText(/AI interpretation—not verified facts/)).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Hide explanation" })); flush();
  fireEvent.click(page.getByRole("button", { name: "Show explanation" })); flush();
  expect(calls()).toHaveLength(1);
  fireEvent.click(page.getByRole("button", { name: `${file.path} · diff 6–7` }));
  await waitFor(() => expect(page.container.querySelectorAll("[data-review-evidence]")).toHaveLength(2));
  expect(model.draft()).toBe("Keep draft"); expect(transport).not.toHaveBeenCalled(); expect(conversation).not.toHaveBeenCalled();
  expect(model.review.isReviewed(file)).toBe(false);
});

it("does not bind a separately reviewed patch to an earlier matching metadata identity", async () => {
  const other = { ...file, path: "src/other.ts", fingerprint: "other" };
  let version = file;
  const review = createLocalReview(async request => request.path
    ? snapshot([request.path === file.path ? version : other])
    : { ...snapshot([file, other].map(item => ({ ...item, patch: null, fingerprint: null }))), snapshotKey: "a".repeat(64) });
  await review.refresh(); flush();
  await review.setSelected(other.path); flush();
  version = { ...file, patch: file.patch.replace("-old", "-version-b"), fingerprint: "version-b" };
  await review.setSelected(file.path); flush();
  // Force a fresh captured B patch instead of the earlier cached A patch.
  await review.refresh(); flush();
  review.mark(review.snapshot()!.files.find(item => item.path === file.path)!, true); flush();
  await review.setSelected(other.path); flush();
  version = file;
  await review.refresh(); flush();
  const pending = review.snapshot()!.files.find(item => item.path === file.path)!;
  expect(review.historyReview.reviewedFingerprint(file.path)).toBe("version-b");
  expect(review.isReviewed(pending)).toBe(false);
  expect(review.historyReview.status(pending)).toBe("pending");
  await review.setSelected(file.path); flush();
  expect(review.historyReview.status(review.snapshot()!.files.find(item => item.path === file.path)!)).toBe("changed");
});

it("highlights later edits against the last manual review and preserves unchanged marks", async () => {
  let current = file;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot([current])))));
  const model = createSessionModel("incremental", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("button", { name: "Select new line 2" });
  fireEvent.click(page.getByRole("checkbox", { name: "Reviewed" })); flush();
  await model.review.refresh(); flush();
  expect(model.review.isReviewed(file)).toBe(true);
  current = { ...file, fingerprint: "later", patch: file.patch.replace("+<script>alert(1)</script>", "+return 42") };
  await model.review.refresh(); flush();
  expect(page.getByRole("region", { name: "Changes since last review" })).toBeTruthy();
  expect(page.container.querySelectorAll(".diff-since-review")).toHaveLength(1);
  expect(page.container.querySelector(".diff-since-review code")?.textContent).toBe("return 42");
  fireEvent.click(page.getByRole("button", { name: "Previously reviewed rows replaced or removed" })); flush();
  expect(page.getByText("+<script>alert(1)</script>")).toBeTruthy();
  fireEvent.click(page.getByRole("checkbox", { name: "Reviewed" })); flush();
  expect(page.queryByRole("region", { name: "Changes since last review" })).toBeNull();
  const allFiles = page.getByRole("button", { name: "All files" });
  const unreviewed = page.getByRole("button", { name: "Unreviewed" });
  expect(allFiles.getAttribute("aria-pressed")).toBe("true");
  expect(unreviewed.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(unreviewed); flush();
  expect(unreviewed.getAttribute("aria-pressed")).toBe("true");
  expect(allFiles.getAttribute("aria-pressed")).toBe("false");
  expect(page.queryByRole("button", { name: `${file.path} — modified — reviewed` })).toBeNull();
  fireEvent.click(allFiles); flush();
  expect(page.getByRole("button", { name: `${file.path} — modified — reviewed` })).toBeTruthy();
  expect(allFiles.getAttribute("aria-pressed")).toBe("true");
  expect(unreviewed.getAttribute("aria-pressed")).toBe("false");
});

it("lets grouping use a separate model and shows measured usage without changing chat", async () => {
  const cheap = { provider: "test", id: "small", name: "Small", images: false };
  const chat = { ...cheap, id: "large", name: "Large" };
  const fetch = vi.fn(async (url: string, _init: RequestInit) => new Response(JSON.stringify(url.endsWith("/groups")
    ? { groups: [{ title: "Feature", reason: "", paths: [file.path] }], usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 } }
    : snapshot())));
  vi.stubGlobal("fetch", fetch);
  const model = createSessionModel("cost-ui", () => true, () => true, undefined, () => "cap");
  model.receive({ v: 1, sessionId: "cost-ui", epoch: "epoch", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: "cost-ui", epoch: "epoch", body: { type: "settings", settings: { models: [chat, cheap], model: chat, thinkingLevel: "off", thinkingLevels: ["off"], codexFast: null } } }); flush();
  const settings = render(() => <SettingsPage model={model} grouping={{ options: model.review.grouping.options, setOptions: model.review.grouping.setOptions, disabled: () => false, status: () => "Saved" }} theme="system" setTheme={() => {}} />);
  fireEvent.keyDown(settings.getByRole("button", { name: /^Grouping model/ }), { key: "Enter" }); flush();
  fireEvent.click(screen.getByRole("option", { name: "Small · test" })); flush();
  expect(fetch).not.toHaveBeenCalled(); settings.unmount();
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("heading", { name: file.path });
  expect(page.queryByText("AI settings & cost")).toBeNull();
  expect(page.queryByLabelText("Grouping model")).toBeNull();
  fireEvent.click(page.getByRole("button", { name: "Group with AI" }));
  await page.findByLabelText("Grouping usage");
  await waitFor(() => expect(page.getByLabelText("Grouping usage").textContent).toContain("$0.0010"));
  expect(model.state.settings.model?.id).toBe("large");
  const request = fetch.mock.calls.find(([url]) => url.endsWith("/groups"))!;
  expect(JSON.parse(request[1].body as string).model).toEqual({ provider: "test", id: "small" });
  expect(page.getByRole("button", { name: "Regenerate groups" })).toBeTruthy();
});

it("opens an overview without AI calls and follows purpose evidence into the same diff", async () => {
  const files = [file, { ...file, path: "src/auth.ts" }, { ...file, path: "test/auth.test.ts" }];
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/groups")
    ? { groups: [{ title: "Sign-in validation", reason: "Reject invalid credentials before creating a session.", paths: ["src/auth.ts", "test/auth.test.ts"] }] }
    : snapshot(files))));
  vi.stubGlobal("fetch", fetch);
  const transport = vi.fn(() => true), conversation = vi.fn();
  const model = createSessionModel("s", transport, () => true, undefined, () => "cap");
  model.setDraft("Keep my question");
  const page = render(() => <LocalReview model={model} conversation={conversation} />);
  await page.findByRole("heading", { name: "src/a.ts" });
  const views = within(page.getByRole("group", { name: "Review view" }));
  fireEvent.click(views.getByRole("button", { name: "Overview" })); flush();
  const overview = within(page.getByRole("region", { name: "Change overview" }));
  expect(page.queryByRole("region", { name: "Unified diff" })).toBeNull();
  expect(overview.getByText(/Tests are not run here/)).toBeTruthy();
  expect(overview.getByText(/Filename hints, not a security assessment/)).toBeTruthy();
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/groups"))).toBe(false);
  fireEvent.click(page.getByRole("button", { name: "Group with AI" }));
  await overview.findByText("Reject invalid credentials before creating a session.");
  expect(overview.getByText(/AI-suggested/)).toBeTruthy();
  fireEvent.click(overview.getByRole("button", { name: "Review Sign-in validation" }));
  await page.findByRole("heading", { name: "src/auth.ts" });
  expect(views.getByRole("button", { name: "Files" }).getAttribute("aria-pressed")).toBe("true");
  const picker = within(page.getByRole("navigation", { name: "Changed files" }));
  expect(picker.getByRole("button", { name: /Review group.*Sign-in validation/ })).toBeTruthy();
  expect(picker.queryByRole("button", { name: "src/a.ts — modified" })).toBeNull();
  expect(picker.getAllByRole("button", { name: / — modified$/ }).map(button => button.getAttribute("aria-label"))).toEqual(["src/auth.ts — modified", "test/auth.test.ts — modified"]);
  await waitFor(() => expect(document.activeElement).toBe(page.getByRole("article", { name: "Diff for src/auth.ts" })));
  fireEvent.click(page.getByRole("button", { name: "Next unreviewed" }));
  await page.findByRole("heading", { name: "test/auth.test.ts" });
  expect(model.draft()).toBe("Keep my question");
  expect(page.getByRole("progressbar", { name: "Review progress" }).getAttribute("aria-valuenow")).toBe("0");
  expect(transport).not.toHaveBeenCalled(); expect(conversation).not.toHaveBeenCalled();
  fireEvent.click(page.getByRole("button", { name: "src/auth.ts — modified" }));
  await page.findByRole("heading", { name: "src/auth.ts" });
  fireEvent.click(page.getByRole("checkbox", { name: "Reviewed" })); flush();
  fireEvent.click(views.getByRole("button", { name: "Overview" })); flush();
  const updated = within(page.getByRole("region", { name: "Change overview" }));
  expect(updated.getByText("1/2 reviewed")).toBeTruthy();
  fireEvent.click(updated.getByRole("button", { name: "Review Sign-in validation" }));
  await page.findByRole("heading", { name: "test/auth.test.ts" });
  expect(page.getByRole("button", { name: "Next unreviewed" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(page.getByRole("button", { name: "Show all files" })); flush();
  expect(within(page.getByRole("navigation", { name: "Changed files" })).getByRole("button", { name: "src/a.ts — modified" })).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Next unreviewed" }));
  await page.findByRole("heading", { name: "src/a.ts" });
});

it("keeps group order in the dialog picker and resets focus when that group disappears", async () => {
  const files = [file, { ...file, path: "src/z.ts" }, { ...file, path: "src/b.ts" }];
  let grouping = [{ title: "Ordered", reason: "", paths: ["src/z.ts", file.path] }, { title: "Other", reason: "", paths: ["src/b.ts"] }];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/groups") ? { groups: grouping } : snapshot(files)))));
  const model = createSessionModel("group-order", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("heading", { name: file.path });
  fireEvent.click(page.getByRole("button", { name: "Group with AI" }));
  await page.findByRole("button", { name: "Regenerate groups" });
  fireEvent.click(page.getByRole("button", { name: "Overview" })); flush();
  fireEvent.click(page.getByRole("button", { name: "Review Ordered" }));
  await page.findByRole("heading", { name: "src/z.ts" });
  fireEvent.click(page.getByRole("button", { name: "Files (3)" })); flush();
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getAllByRole("button", { name: / — modified$/ }).map(button => button.getAttribute("aria-label"))).toEqual(["src/z.ts — modified", "src/a.ts — modified"]);
  fireEvent.keyDown(dialog.getByRole("button", { name: /Review group/ }), { key: "Enter" }); flush();
  fireEvent.click(screen.getByRole("option", { name: "Other (1)" })); flush();
  await page.findByRole("heading", { name: "src/b.ts" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(page.getByRole("button", { name: "Next unreviewed" }).hasAttribute("disabled")).toBe(true);
  grouping = [{ title: "Combined", reason: "", paths: files.map(item => item.path) }];
  fireEvent.click(page.getByRole("button", { name: "Regenerate groups" }));
  await page.findByRole("heading", { name: "Combined" });
  expect(page.queryByRole("button", { name: "Show all files" })).toBeNull();
  expect(within(page.getByRole("navigation", { name: "Changed files" })).getAllByRole("button", { name: / — modified$/ })).toHaveLength(3);
});

it("loads 1000 metadata entries in pages and fetches only selected patches", async () => {
  const entries = Array.from({ length: 1000 }, (_, i) => ({ ...file, path: `file-${i}.ts`, patch: null, fingerprint: null }));
  const load = vi.fn(async (request: { path?: string; cursor?: string }) => {
    if (request.path) return snapshot([{ ...file, path: request.path }]);
    const start = Number(request.cursor ?? 0);
    return { ...snapshot(entries.slice(start, start + 100)), ...(start < 900 ? { nextCursor: String(start + 100) } : {}), ...(start === 0 ? { lineStats: { added: 1000, totalAdded: 1000, removed: 0, totalRemoved: 0, unavailableFiles: 0 } } : {}) };
  });
  const review = createLocalReview(load);
  await review.refresh(); flush();
  expect(review.snapshot()?.files).toHaveLength(1000);
  expect(review.snapshot()?.lineStats?.added).toBe(1000);
  expect(load).toHaveBeenCalledTimes(11);
  expect(load.mock.calls.filter(([request]) => request.path)).toHaveLength(1);
  review.setSelected("file-999.ts");
  await waitFor(() => expect(review.snapshot()?.files[999].patch).toBe(file.patch));
});

it("filters and opens the thousandth file through the Changes UI", async () => {
  const entries = Array.from({ length: 1000 }, (_, i) => ({ ...file, path: `src/file-${i}.ts`, patch: null, fingerprint: null }));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    if (request.path) return new Response(JSON.stringify(snapshot([{ ...file, path: request.path }])));
    const start = Number(request.cursor ?? 0);
    return new Response(JSON.stringify({ ...snapshot(entries.slice(start, start + 100)), ...(start < 900 ? { nextCursor: String(start + 100) } : {}) }));
  }));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("button", { name: "Files (1000)" });
  fireEvent.input(page.getByRole("searchbox", { name: "Filter files" }), { target: { value: "file-999.ts" } }); flush();
  fireEvent.click(page.getByRole("button", { name: "src/file-999.ts — modified" }));
  await page.findByRole("heading", { name: "src/file-999.ts" });
  await waitFor(() => expect(page.getByRole("checkbox", { name: "Reviewed" }).hasAttribute("disabled")).toBe(false));
  expect(model.review.snapshot()?.files).toHaveLength(1000);
});

it("validates and preserves continuation tokens at the HTTP boundary", async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ...snapshot([{ ...file, patch: null, fingerprint: null }]), nextCursor: "100:listing" })));
  vi.stubGlobal("fetch", fetch);
  const page = await fetchReview("s", { scope: "staged", cursor: "previous" }, new AbortController().signal, "cap");
  expect(page.nextCursor).toBe("100:listing");
  expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).cursor).toBe("previous");
  for (const nextCursor of [null, "", 100, "x".repeat(257)]) {
    fetch.mockImplementation(async () => new Response(JSON.stringify({ ...snapshot([file]), nextCursor })));
    await expect(fetchReview("s", { scope: "staged" }, new AbortController().signal, "cap")).rejects.toThrow("continuation");
  }
});

it("discards a late metadata page after switching scopes", async () => {
  let finish!: (page: ReviewSnapshot) => void;
  const load = vi.fn(async (request: { scope: string; cursor?: string }) => {
    if (request.scope === "staged") return snapshot([]);
    if (request.cursor) return new Promise<ReviewSnapshot>(resolve => { finish = resolve; });
    return { ...snapshot([file]), nextCursor: "next" };
  });
  const review = createLocalReview(load), first = review.refresh();
  await waitFor(() => expect(finish).toBeTruthy());
  await review.refresh("staged");
  finish(snapshot([{ ...file, path: "late.ts" }])); await first; flush();
  expect(review.snapshot()?.files).toEqual([]); expect(review.target()?.scope).toBe("staged");
});

it.each([1, 2])("enforces the file budget with a final short page of %i files", async last => {
  let index = 0;
  const review = createLocalReview(async request => {
    if (request.path) return snapshot([{ ...file, path: request.path }]);
    const page = index++;
    return { files: Array.from({ length: page < 101 ? 99 : last }, (_, i) => ({ ...file, path: `${page}/${i}.ts`, patch: null, fingerprint: null })), truncated: false, note: null, ...(page < 101 ? { nextCursor: String(page + 1) } : {}) };
  });
  await review.refresh(); flush();
  if (last === 1) { expect(review.error()).toBe(""); expect(review.snapshot()?.files).toHaveLength(10000); }
  else { expect(review.error()).toContain("10,000"); expect(review.snapshot()).toBeUndefined(); }
});

it("rejects repeated pages without replacing a complete review", async () => {
  let paged = false;
  const review = createLocalReview(async () => ({ ...snapshot([file]), ...(paged ? { nextCursor: "same" } : {}) }));
  await review.refresh(); paged = true; await review.refresh(); flush();
  expect(review.error()).toContain("listing changed"); expect(review.snapshot()?.files).toEqual([file]);
});

it("keeps compact file controls named and preserves review, navigation and draft actions", async () => {
  const first = { ...file, path: "src/deeply/nested/components/LocalReview.tsx" };
  const second = { ...file, path: "README.md", fingerprint: "second" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot([first, second])))));
  const transport = vi.fn(() => true);
  const model = createSessionModel("session", transport, () => true, undefined, () => "cap");
  const conversation = vi.fn();
  const page = render(() => <LocalReview model={model} conversation={conversation} />);
  const heading = await page.findByRole("heading", { name: first.path });
  expect(heading.getAttribute("title")).toBe(first.path);
  expect(heading.querySelector(".review-path-basename")?.textContent).toBe("LocalReview.tsx");
  const header = within(page.container.querySelector(".review-file-header")! as HTMLElement);
  expect(header.getByRole("button", { name: "Files (2)" }).querySelector("svg[aria-hidden=true]")).toBeTruthy();
  expect(header.getByRole("button", { name: "Ask Pi about file" }).querySelector("svg[aria-hidden=true]")).toBeTruthy();
  expect(header.getByRole("checkbox", { name: "Reviewed" }).closest(".review-file-heading")).toBeTruthy();
  expect(header.getByRole("button", { name: "Files (2)" }).closest(".review-file-actions")).toBeTruthy();
  for (const name of ["Text", "Structural", "Files (2)", "Next unreviewed", "Ask Pi about file"]) {
    const button = header.getByRole("button", { name });
    expect(button.querySelector("svg[aria-hidden=true]")).toBeTruthy();
    expect(button.getAttribute("title")).toBeTruthy();
  }
  expect(header.getByRole("button", { name: "Next unreviewed" }).textContent).toBe("Next");
  expect(header.getByRole("button", { name: "Ask Pi about file" }).textContent).toBe("Ask Pi");
  expect(header.getByRole("button", { name: "Files (2)" }).textContent).toBe("Files (2)");
  expect(header.getByRole("button", { name: "Text" }).getAttribute("aria-pressed")).toBe("true");
  expect(page.getByTitle("Mark file as reviewed")).toBeTruthy();
  fireEvent.click(header.getByRole("checkbox", { name: "Reviewed" })); flush();
  expect(model.review.isReviewed(first)).toBe(true);
  expect(page.getByTitle("Mark file as unreviewed")).toBeTruthy();
  fireEvent.click(header.getByRole("button", { name: "Next unreviewed" })); flush();
  await page.findByRole("heading", { name: second.path });
  fireEvent.click(header.getByRole("button", { name: "Ask Pi about file" })); flush();
  expect(screen.getByRole("dialog", { name: "Ask Pi about file" }).textContent).toContain(second.path);
  expect(conversation).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it("shows scope-wide line totals without loading all patches and refreshes them with the scope", async () => {
  const entries = [file, { ...file, path: "src/b.ts" }];
  const request = vi.fn(async (_url: string, init: RequestInit) => {
    const input = JSON.parse(init.body as string);
    return new Response(JSON.stringify(input.path ? snapshot(entries.filter(entry => entry.path === input.path)) : {
      ...snapshot(entries.map(entry => ({ ...entry, patch: null, fingerprint: null }))),
      lineStats: input.scope === "unstaged" ? { added: 500, totalAdded: 1120, removed: 75, totalRemoved: 175, unavailableFiles: 2 } : { added: 0, totalAdded: 0, removed: 0, totalRemoved: 0, unavailableFiles: 0 },
    }));
  });
  vi.stubGlobal("fetch", request);
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByText("+500 added");
  expect(page.getByText("+500 added")).toBeTruthy(); expect(page.getByText("−75 deleted")).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "About line totals" })); flush();
  const tooltip = await screen.findByRole("tooltip");
  expect(within(tooltip).getByRole("row", { name: "Added 500 620 1,120" })).toBeTruthy();
  expect(within(tooltip).getByRole("row", { name: "Deleted 75 100 175" })).toBeTruthy();
  expect(tooltip.textContent).toContain("Shown counts exclude tests, generated files, lockfiles, and .md files");
  expect(page.getByText("+500 added")).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" }); flush();
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  expect(page.queryByText(/files without line counts/)).toBeNull();
  expect(page.queryByText(/Snapshot:/)).toBeNull();
  expect(page.queryByText("575 lines changed")).toBeNull();
  await page.findByLabelText("Reviewed");
  expect(request).toHaveBeenCalledTimes(2);
  fireEvent.click(page.getByLabelText("Reviewed")); flush();
  expect(page.getByText("+500 added")).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Staged" }));
  await page.findByText("+0 added");
  expect(page.getByText("−0 deleted")).toBeTruthy();
  expect(page.queryByText("+500 added")).toBeNull();
  expect(page.queryByText(/files without line counts/)).toBeNull();
});

it("groups only on request, renders suggestions safely, preserves omissions and leaves chat unchanged", async () => {
  const second = { ...file, path: "tests/a.test.ts", fingerprint: "second" };
  const request = vi.fn(async (url: string, init: RequestInit) => new Response(JSON.stringify(url.endsWith("/groups")
    ? { groups: [{ title: "<script>Feature</script>", reason: "Implementation changes", paths: [file.path] }] }
    : snapshot([file, second]))));
  vi.stubGlobal("fetch", request);
  const transport = vi.fn(() => true);
  const model = createSessionModel("session", transport, () => true, undefined, () => "cap");
  model.setDraft("Keep my draft"); flush();
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("heading", { name: "src" });
  expect(request.mock.calls.some(([url]) => url.endsWith("/groups"))).toBe(false);
  expect(page.queryByText(/Optional · sends file names/)).toBeNull();
  expect(page.queryByText("Context & privacy")).toBeNull();
  fireEvent.click(page.getByRole("button", { name: "Group with AI" }));
  await page.findByRole("heading", { name: "<script>Feature</script>" });
  expect(page.getByRole("heading", { name: "Ungrouped" })).toBeTruthy();
  expect(page.container.querySelector("script")).toBeNull();
  expect(model.draft()).toBe("Keep my draft"); expect(transport).not.toHaveBeenCalled();
  const groupRequest = request.mock.calls.find(([url]) => url.endsWith("/groups"))![1];
  expect(groupRequest.headers).toEqual({ "content-type": "application/json", "x-pi-capability": "cap" });
  expect(JSON.parse(groupRequest.body as string)).toMatchObject({ files: [file, second].map(({ path }) => ({ path, status: "modified", added: 1, removed: 1 })), details: [], readsRemaining: 8 });
  expect(page.getByRole("region", { name: "Organize changed files" })).toBeTruthy();
  expect(page.getByText(/Suggestions, not a correctness review/)).toBeTruthy();
  expect(page.getByRole("progressbar", { name: "Review progress" }).getAttribute("aria-valuenow")).toBe("0");
  expect(page.getByText("0 / 2 files reviewed")).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Folders" })); flush();
  expect(page.getByRole("heading", { name: "src" })).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Refresh" }));
  await waitFor(() => { flush(); expect(page.getByRole("button", { name: "Update groups with AI" })).toBeTruthy(); });
  expect(page.getByRole("button", { name: "By purpose" })).toBeTruthy();
  expect(page.getByRole("heading", { name: "src" })).toBeTruthy();
});

it("expands unchanged context above a hunk without changing the snapshot or sending a prompt", async () => {
  const selected = { ...file, patch: file.patch.replace("@@ -1,2 +1,2 @@", "@@ -25,2 +25,2 @@") };
  const request = vi.fn(async (url: string, init: RequestInit) => new Response(JSON.stringify(url.endsWith("/context")
    ? { oldStart: 5, newStart: 5, lines: Array.from({ length: 20 }, (_, i) => `const value${i + 5} = '<script>context</script>';`), hasMore: false, noNewline: false }
    : snapshot([selected]))));
  vi.stubGlobal("fetch", request);
  const transport = vi.fn(() => true);
  const model = createSessionModel("session", transport, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  const expand = await page.findByRole("button", { name: "Expand 20 lines above" });
  const existingRow = page.container.querySelector(".diff-add");
  fireEvent.click(page.getByLabelText("Reviewed")); flush(); fireEvent.click(expand);
  await waitFor(() => { flush(); expect(page.container.textContent).toContain("const value5"); });
  expect(JSON.parse(request.mock.calls.find(([url]) => url.endsWith("/context"))![1].body as string)).toEqual({ scope: "unstaged", path: selected.path, fingerprint: selected.fingerprint, oldStart: 5, newStart: 5, count: 20 });
  expect(page.getByRole("button", { name: "Expand 4 lines above" })).toBeTruthy();
  expect(page.container.querySelector(".diff-add")).toBe(existingRow);
  expect(page.container.querySelector("script")).toBeNull();
  expect(page.getByText("1 / 1 files reviewed")).toBeTruthy();
  expect(model.review.snapshot()?.files[0].patch).toBe(selected.patch);
  fireEvent.click(page.getByRole("button", { name: "Ask Pi about file" })); flush();
  expect([...screen.getByLabelText("File changes").querySelectorAll("code")].map(code => code.textContent).join("\n")).toBe(selected.patch.trimEnd());
  expect(screen.getByLabelText("File changes").textContent).not.toContain("const value5");
  expect(model.draft()).toBe("");
  expect(transport).not.toHaveBeenCalled();
});

it.each(["above", "below"] as const)("places accessible %s expansion icons beside one hunk header", async direction => {
  const header = "@@ -25,2 +25,2 @@ function example()";
  const selected = { ...file, patch: `${file.patch}${header}\n context\n-before\n+after\n` };
  const request = vi.fn(async (url: string, init: RequestInit) => {
    if (!url.endsWith("/context")) return new Response(JSON.stringify(snapshot([selected])));
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ oldStart: body.oldStart, newStart: body.newStart, lines: Array(20).fill("unchanged"), hasMore: true, noNewline: false }));
  });
  vi.stubGlobal("fetch", request);
  const model = createSessionModel("session", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  const above = await page.findByRole("button", { name: "Expand 20 lines above" });
  const row = above.closest(".review-context")!;
  expect(row.textContent).toBe(header);
  expect(page.getAllByText(header)).toHaveLength(1);
  const buttons = row.querySelectorAll("button");
  expect([...buttons].map(button => button.getAttribute("aria-label"))).toEqual(["Expand 20 lines below", "Expand 20 lines above"]);
  for (const button of buttons) { expect(button.textContent).toBe(""); expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull(); }
  fireEvent.click(buttons[direction === "below" ? 0 : 1]);
  await waitFor(() => { flush(); expect(page.container.textContent).toContain("unchanged"); });
  expect(JSON.parse(request.mock.calls.find(([url]) => url.endsWith("/context"))![1].body as string)).toMatchObject({ oldStart: direction === "above" ? 5 : 3, newStart: direction === "above" ? 5 : 3, count: 20 });
});

it("uses authenticated same-origin POST and validates the snapshot", async () => {
  const request = vi.fn(async () => new Response(JSON.stringify(snapshot()))); vi.stubGlobal("fetch", request);
  const signal = new AbortController().signal;
  expect(await fetchReview("session", { scope: "branch", base: "main" }, signal, "cap")).toEqual(snapshot());
  expect(request).toHaveBeenCalledWith("/review/session", { method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal,
    headers: { "content-type": "application/json", "x-pi-capability": "cap" }, body: JSON.stringify({ scope: "branch", base: "main" }) });
});

it.each([{}, { ...snapshot(), files: [{}] }, { ...snapshot(), files: [{ ...file, patch: 3 }] }, { ...snapshot(), files: [{ ...file, status: "surprise" }] }, { ...snapshot(), truncated: "yes" }, { ...snapshot(), files: [{ ...file, patch: "x".repeat(65537) }] }])("rejects invalid server snapshots", async value => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value))));
  await expect(fetchReview("session", { scope: "unstaged" }, new AbortController().signal, "cap")).rejects.toThrow();
});

it.each([null, {}, { added: -1, totalAdded: 0, removed: 0, totalRemoved: 0, unavailableFiles: 0 }, { added: 1.5, totalAdded: 2, removed: 0, totalRemoved: 0, unavailableFiles: 0 },
  { added: 0, totalAdded: 0, removed: "2", totalRemoved: 2, unavailableFiles: 0 }, { added: 0, totalAdded: 0, removed: 0, totalRemoved: 0, unavailableFiles: -1 },
  { added: Number.MAX_SAFE_INTEGER, totalAdded: Number.MAX_SAFE_INTEGER, removed: 1, totalRemoved: 1, unavailableFiles: 0 },
  ...[undefined, -1, 1.5, "10", 4, Number.MAX_SAFE_INTEGER + 1].map(totalAdded => ({ added: 5, totalAdded, removed: 0, totalRemoved: 0, unavailableFiles: 0 })),
  ...[undefined, -1, 1.5, "10", 4, Number.MAX_SAFE_INTEGER].map(totalRemoved => ({ added: 1, totalAdded: 1, removed: 5, totalRemoved, unavailableFiles: 0 }))])("rejects invalid line totals", async lineStats => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...snapshot(), lineStats }))));
  await expect(fetchReview("s", { scope: "staged" }, new AbortController().signal, "cap")).rejects.toThrow("Invalid review line totals");
});

it("shows unavailable totals explicitly rather than reporting zero", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByText("Line totals unavailable");
  expect(page.queryByText("0 lines changed")).toBeNull();
});

it("fails authentication before fetching and handles failed requests", async () => {
  const request = vi.fn(async () => new Response(null, { status: 403 })); vi.stubGlobal("fetch", request);
  await expect(fetchReview("s", { scope: "staged" }, new AbortController().signal, null)).rejects.toThrow("Authentication required");
  expect(request).not.toHaveBeenCalled();
  await expect(fetchReview("s", { scope: "staged" }, new AbortController().signal, "cap")).rejects.toThrow("Authentication required");
});

it("shows actionable repository compatibility errors", async () => {
  const error = "Repositories with configured Git filters are unsupported for local review";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error }), { status: 422 })));
  await expect(fetchReview("s", { scope: "unstaged" }, new AbortController().signal, "cap")).rejects.toThrow(error);
});

it("accepts metadata-only lists but requires a matching loaded selected-file response", async () => {
  const metadata = { ...snapshot(), files: [{ ...file, patch: null, fingerprint: null }] };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(metadata))));
  const signal = new AbortController().signal;
  expect(await fetchReview("s", { scope: "unstaged" }, signal, "cap")).toEqual(metadata);
  await expect(fetchReview("s", { scope: "unstaged", path: file.path }, signal, "cap")).rejects.toThrow("selected-file response");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  await expect(fetchReview("s", { scope: "unstaged", path: "other.ts" }, signal, "cap")).rejects.toThrow("selected-file response");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...metadata, files: [{ ...file, patch: null }] }))));
  await expect(fetchReview("s", { scope: "unstaged" }, signal, "cap")).rejects.toThrow("Invalid local review response");
});

it("loads only the selected patch, reuses it on revisit and invalidates it on refresh", async () => {
  const entries = [file, { ...file, path: "src/b.ts", fingerprint: "snapshot-b" }];
  const load = vi.fn(async (request: { path?: string }) => request.path
    ? snapshot(entries.filter(item => item.path === request.path))
    : { ...snapshot(), files: entries.map(item => ({ ...item, patch: null, fingerprint: null })) });
  const review = createLocalReview(load);
  await review.refresh(); flush();
  expect(load.mock.calls.map(([request]) => request.path)).toEqual([undefined, file.path]);
  expect(review.snapshot()?.files[0].patch).toBe(file.patch);
  review.mark(file, true); flush();
  review.setSelected("src/b.ts"); flush();
  await waitFor(() => { flush(); expect(review.patchBusy()).toBe(false); });
  review.setSelected(file.path); flush();
  expect(load).toHaveBeenCalledTimes(3);
  expect(review.isReviewed(file)).toBe(true);
  await review.refresh(); flush();
  expect(load.mock.calls.map(([request]) => request.path)).toEqual([undefined, file.path, "src/b.ts", undefined, file.path]);
  expect(review.isReviewed(file)).toBe(true);
});

it("ignores late selected-file replies and disables review actions until a patch arrives", async () => {
  let reply!: (value: ReviewSnapshot) => void;
  const entries = [file, { ...file, path: "src/b.ts" }].map(item => ({ ...item, patch: null, fingerprint: null }));
  let signal!: AbortSignal;
  const load = vi.fn((request: { path?: string }, current: AbortSignal) => {
    if (!request.path) return Promise.resolve({ ...snapshot(), files: entries });
    if (request.path === file.path) { signal = current; return new Promise<ReviewSnapshot>(resolve => { reply = resolve; }); }
    return Promise.resolve(snapshot([{ ...file, path: request.path }]));
  });
  const review = createLocalReview(load); const first = review.refresh();
  await waitFor(() => { flush(); expect(review.patchBusy()).toBe(true); });
  expect(review.isReviewed(entries[0])).toBe(false);
  review.setSelected("src/b.ts"); flush();
  expect(signal.aborted).toBe(true);
  reply(snapshot()); await first; flush();
  await waitFor(() => { flush(); expect(review.snapshot()?.files[1].patch).toBe(file.patch); });
  expect(review.snapshot()?.files[0].patch).toBeNull();
});

it("keeps file navigation on patch failure and supports retry without reloading the list", async () => {
  let fail = true;
  const load = vi.fn(async (request: { path?: string }) => {
    if (!request.path) return { ...snapshot(), files: [{ ...file, patch: null, fingerprint: null }] };
    if (fail) throw new Error("File snapshot changed; refresh review");
    return snapshot();
  });
  const review = createLocalReview(load); await review.refresh(); flush();
  expect(review.error()).toBe(""); expect(review.patchError()).toContain("File snapshot changed");
  expect(review.snapshot()?.files).toHaveLength(1); expect(review.snapshot()?.files[0].patch).toBeNull();
  fail = false; await review.loadPatch(); flush();
  expect(review.snapshot()?.files[0].patch).toBe(file.patch); expect(review.patchError()).toBe("");
  expect(load.mock.calls.map(([request]) => request.path)).toEqual([undefined, file.path, file.path]);
});

it("bounds loaded patches to 1 MiB and reloads an evicted patch on demand", async () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ ...file, path: `${i}.ts`, fingerprint: `id-${i}`, patch: "x".repeat(65536) }));
  const load = vi.fn(async (request: { path?: string }) => request.path
    ? snapshot(entries.filter(item => item.path === request.path))
    : { ...snapshot(), files: entries.map(item => ({ ...item, patch: null, fingerprint: null })) });
  const review = createLocalReview(load); await review.refresh(); flush();
  for (const entry of entries.slice(1)) { review.setSelected(entry.path); flush(); await waitFor(() => { flush(); expect(review.patchBusy()).toBe(false); }); }
  expect(review.snapshot()?.files.reduce((sum, item) => sum + (item.patch?.length ?? 0), 0)).toBeLessThanOrEqual(1024 * 1024);
  expect(review.snapshot()?.files[0].patch).toBeNull();
  review.setSelected(entries[0].path); flush();
  await waitFor(() => { flush(); expect(review.patchBusy()).toBe(false); });
  expect(load.mock.calls.filter(([request]) => request.path === entries[0].path)).toHaveLength(2);
});

it("loads a file selected during a failed refresh from the retained snapshot", async () => {
  const entries = [file, { ...file, path: "src/b.ts", fingerprint: "snapshot-b" }];
  let rejectListing!: (reason: Error) => void;
  let listings = 0;
  const load = vi.fn((request: { path?: string }): Promise<ReviewSnapshot> => {
    if (request.path) return Promise.resolve(snapshot(entries.filter(item => item.path === request.path)));
    if (++listings === 2) return new Promise((_resolve, reject) => { rejectListing = reject; });
    return Promise.resolve({ ...snapshot(), files: entries.map(item => ({ ...item, patch: null, fingerprint: null })) });
  });
  const review = createLocalReview(load); await review.refresh(); flush();
  const refreshing = review.refresh(); flush();
  review.setSelected("src/b.ts"); flush();
  expect(load.mock.calls.map(([request]) => request.path)).toEqual([undefined, file.path, undefined]);
  rejectListing(new Error("Listing unavailable")); await refreshing; flush();
  expect(review.error()).toBe("Listing unavailable");
  expect(review.selected()).toBe("src/b.ts");
  expect(load).toHaveBeenLastCalledWith({ scope: "unstaged", path: "src/b.ts" }, expect.any(AbortSignal));
  expect(review.snapshot()?.files[1].patch).toBe(file.patch);
  expect(review.busy()).toBe(false); expect(review.patchBusy()).toBe(false);
});

it("disables selected-file actions until the lazy patch arrives", async () => {
  let reply!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => JSON.parse(init.body as string).path
    ? new Promise<Response>(resolve => { reply = resolve; })
    : Promise.resolve(new Response(JSON.stringify({ ...snapshot(), files: [{ ...file, patch: null, fingerprint: null }] })))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByText("Loading patch…");
  expect((page.getByRole("button", { name: "Ask Pi about file" }) as HTMLButtonElement).disabled).toBe(true);
  expect((page.getByRole("button", { name: "Structural" }) as HTMLButtonElement).disabled).toBe(true);
  expect((page.getByLabelText("Reviewed") as HTMLInputElement).disabled).toBe(true);
  reply(new Response(JSON.stringify(snapshot())));
  await waitFor(() => { flush(); expect((page.getByRole("button", { name: "Ask Pi about file" }) as HTMLButtonElement).disabled).toBe(false); });
});

it("renders at most 500 diff rows per page and exposes every remaining row", async () => {
  const patch = "@@ -0,0 +1,1100 @@\n" + Array.from({ length: 1100 }, (_, i) => `+row ${i + 1}`).join("\n");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot([{ ...file, status: "added", patch }])))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.container.querySelectorAll(".diff-line")).toHaveLength(500); });
  expect(page.container.textContent).toContain("Rows 1–500 of 1101");
  fireEvent.click(page.getAllByRole("button", { name: "Next rows" })[0]); flush();
  expect(page.container.querySelectorAll(".diff-line")).toHaveLength(500);
  expect(page.container.textContent).toContain("Rows 501–1000 of 1101");
  fireEvent.click(page.getAllByRole("button", { name: "Next rows" })[0]); flush();
  expect(page.container.querySelectorAll(".diff-line")).toHaveLength(101);
  expect(page.container.textContent).toContain("row 1100");
});

it("extends a selection across diff pages using source coordinates", async () => {
  const patch = "@@ -0,0 +1,510 @@\n" + Array.from({ length: 510 }, (_, i) => `+row ${i + 1}`).join("\n");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot([{ ...file, status: "added", patch }])))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  fireEvent.click(await page.findByRole("button", { name: "Select new line 499" })); flush();
  fireEvent.click(page.getByRole("button", { name: "Choose end line" })); flush();
  fireEvent.click(page.getAllByRole("button", { name: "Next rows" })[0]); flush();
  fireEvent.click(page.getByRole("button", { name: "Select new line 501" })); flush();
  expect(page.getByRole("button", { name: "Ask Pi about selected lines" }).textContent).toContain("3 lines");
  fireEvent.click(page.getByRole("button", { name: "Ask Pi about selected lines" })); flush();
  expect(screen.getByLabelText("Selected code").textContent).toContain("499+row 499500+row 500501+row 501");
  expect(screen.getByLabelText("Selected code").textContent).not.toContain("+row 502");
});

it("numbers unified hunks without treating file headers as additions", () => {
  const lines = diffLines(file.patch);
  expect(lines[2]).toEqual({ text: "+++ b/src/a.ts", kind: "header" });
  expect(lines[4]).toEqual({ text: " same", kind: "context", old: 1, next: 1 });
  expect(lines[5]).toEqual({ text: "-old", kind: "remove", old: 2 });
  expect(lines[6]).toEqual({ text: "+<script>alert(1)</script>", kind: "add", next: 2 });
});

it("retains unchanged reviewed marks but clears them when patches or scopes change", async () => {
  const load = vi.fn(async () => snapshot()); const review = createLocalReview(load);
  await review.refresh(); review.mark(file, true); flush(); expect(review.isReviewed(file)).toBe(true);
  await review.refresh(); expect(review.isReviewed(file)).toBe(true);
  const changed = { ...file, patch: "new patch", fingerprint: "changed-content" }; load.mockResolvedValueOnce(snapshot([changed]));
  await review.refresh(); expect(review.isReviewed(changed)).toBe(false);
  review.mark(changed, true); review.setScope("staged"); flush(); await review.refresh();
  expect(review.isReviewed(changed)).toBe(false);
  review.setScope("branch"); flush(); await review.refresh();
  expect(review.error()).toBe("Enter a local base branch or tag.");
  review.setBase("main"); flush(); await review.refresh();
  expect(load).toHaveBeenLastCalledWith({ scope: "branch", base: "main" }, expect.any(AbortSignal));
});

it("cancels requests and ignores out-of-order results", async () => {
  let reply!: (value: ReviewSnapshot) => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise<ReviewSnapshot>(resolve => { reply = resolve; })).mockResolvedValue(snapshot());
  const review = createLocalReview(load); const old = review.refresh(); const signal = load.mock.calls[0][1];
  review.setScope("staged"); flush(); await review.refresh(); expect(signal.aborted).toBe(true);
  reply(snapshot([{ ...file, path: "stale.ts" }])); await old;
  expect(review.snapshot()?.files[0].path).toBe("src/a.ts");
  expect(review.target()).toEqual({ scope: "staged" });
});

it("invalidates a reviewed mark when content identity changes outside the displayed patch", async () => {
  const load = vi.fn(async () => snapshot()); const review = createLocalReview(load);
  await review.refresh(); review.mark(file, true); flush(); expect(review.isReviewed(file)).toBe(true);
  const changed = { ...file, fingerprint: "new-full-content" };
  load.mockResolvedValueOnce(snapshot([changed])); await review.refresh(); flush();
  expect(review.isReviewed(changed)).toBe(false);
});

it("preserves a prior snapshot on refresh failure and keeps errors visible", async () => {
  const load = vi.fn(async () => snapshot()); const review = createLocalReview(load);
  await review.refresh(); load.mockRejectedValueOnce(new Error("network unavailable")); await review.refresh();
  expect(review.snapshot()).toEqual(snapshot()); expect(review.error()).toBe("network unavailable"); expect(review.busy()).toBe(false);
});

it("appends review context without losing a draft and rejects oversize prompts", () => {
  const draft = reviewDraft("My question", file, { scope: "branch", base: "main" });
  expect(draft).toContain("My question\n\nContext for this request: local branch changes"); expect(draft).not.toContain(file.patch);
  expect(draft).toContain("Old lines: 2\nNew lines: 2");
  expect(() => reviewDraft("x".repeat(32768), file, { scope: "staged" })).toThrow("message limit");
});

it("offers a floating Ask Pi action at the range endpoint without sending the excerpt", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const transport = vi.fn(() => true), conversation = vi.fn();
  const model = createSessionModel("s", transport, () => true, undefined, () => "cap");
  model.setDraft("Explain this");
  const page = render(() => <LocalReview model={model} conversation={conversation} />);
  const start = await page.findByRole("button", { name: "Select old line 2" });
  expect(page.queryByRole("button", { name: "Ask Pi about selected lines" })).toBeNull();
  fireEvent.click(start); flush();
  const end = page.getByRole("button", { name: "Select new line 2" });
  fireEvent.click(end, { shiftKey: true }); flush();
  const floating = page.getByRole("button", { name: "Ask Pi about selected lines" });
  expect(floating.closest(".diff-line")).toBe(end.closest(".diff-line"));
  fireEvent.click(floating); flush();
  const dialog = within(screen.getByRole("dialog", { name: "Ask Pi about selected lines" }));
  expect(dialog.getByLabelText("Selected code").textContent).toContain("2-old");
  expect(dialog.getByLabelText("Selected code").textContent).toContain("2+<script>alert(1)</script>");
  expect(dialog.getByRole("textbox", { name: "Your question" })).toBeTruthy();
  expect(model.draft()).toBe("Explain this");
  expect(transport).not.toHaveBeenCalled(); expect(conversation).not.toHaveBeenCalled();
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" })); flush();
  await waitFor(() => expect(document.activeElement).toBe(floating));
  fireEvent.click(page.getByRole("button", { name: "Clear selection" })); flush();
  expect(page.queryByRole("button", { name: "Ask Pi about selected lines" })).toBeNull();
});

it("dismisses floating actions with Escape from the gutter or diff without moving focus", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  const line = await page.findByRole("button", { name: "Select old line 2" });
  for (const target of [line, page.getByRole("region", { name: "Unified diff" })]) {
    fireEvent.click(line); flush(); target.focus();
    fireEvent.keyDown(target, { key: "ArrowDown" }); flush();
    expect(page.getByRole("group", { name: "Selected lines actions" })).toBeTruthy();
    fireEvent.keyDown(target, { key: "Escape" }); flush();
    expect(page.queryByRole("group", { name: "Selected lines actions" })).toBeNull();
    expect(page.container.querySelectorAll(".diff-selected")).toHaveLength(1);
    expect(document.activeElement).toBe(target);
  }
});

it("dismisses floating actions without losing the range and restores them on a new selection", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  const line = await page.findByRole("button", { name: "Select old line 2" });
  fireEvent.click(line); flush();
  const floating = page.getByRole("button", { name: "Ask Pi about selected lines" });
  floating.focus(); fireEvent.keyDown(floating, { key: "Escape" }); flush();
  expect(page.queryByRole("group", { name: "Selected lines actions" })).toBeNull();
  expect(page.container.querySelectorAll(".diff-selected")).toHaveLength(1); expect(document.activeElement).toBe(line);
  fireEvent.click(line); flush();
  fireEvent.click(page.getByRole("button", { name: "Dismiss selection actions" })); flush();
  expect(page.queryByRole("group", { name: "Selected lines actions" })).toBeNull();
  expect(page.container.querySelectorAll(".diff-selected")).toHaveLength(1);
  fireEvent.click(line); flush();
  fireEvent.click(page.getByRole("button", { name: "Choose end line" })); flush();
  expect(page.getByRole("button", { name: "Choose end line" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(page.getByRole("button", { name: "Select new line 2" })); flush();
  expect(page.getByRole("button", { name: "Ask Pi about selected lines" }).textContent).toContain("2 lines");
  fireEvent.click(page.getByRole("button", { name: "Refresh" })); flush();
  await waitFor(() => { flush(); expect(model.review.busy()).toBe(false); });
  expect(page.queryByRole("group", { name: "Selected lines actions" })).toBeNull();
});

it("keeps the floating action out of the way until a mouse drag finishes", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  const end = await page.findByRole("button", { name: "Select new line 2" });
  const start = page.getByRole("button", { name: "Select old line 2" });
  const pointer = (element: Element | Window, type: string, buttons = 1) => {
    const event = new MouseEvent(type, { bubbles: true, buttons, button: 0 });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    fireEvent(element, event); flush();
  };
  pointer(end, "pointerdown"); pointer(start.closest(".diff-line")!, "pointerenter");
  expect(page.container.querySelectorAll(".diff-selected")).toHaveLength(2);
  expect(page.queryByRole("group", { name: "Selected lines actions" })).toBeNull();
  pointer(window, "pointerup", 0);
  expect(page.getByRole("button", { name: "Ask Pi about selected lines" }).closest(".diff-line")).toBe(start.closest(".diff-line"));
  fireEvent.pointerCancel(window, { pointerType: "touch" }); flush();
  expect(page.getByRole("group", { name: "Selected lines actions" })).toBeTruthy();
});

it("keeps selection controls in the diff without a separate section", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  const first = await page.findByRole("button", { name: "Select old line 1, new line 1" });
  expect(page.queryByRole("group", { name: "Line selection" })).toBeNull();
  expect(page.queryByRole("status", { name: "Selection help" })).toBeNull();
  expect(page.queryByRole("button", { name: "Choose end line" })).toBeNull();
  expect(first.hasAttribute("aria-describedby")).toBe(false);
  fireEvent.click(first); flush();
  expect(page.getByRole("group", { name: "Selected lines actions" }).closest(".diff-line")).toBe(first.closest(".diff-line"));
});

it("previews only the selected excerpt while preserving an unsent draft", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const transport = vi.fn(() => true), conversation = vi.fn();
  const model = createSessionModel("session", transport, () => true, undefined, () => "cap");
  model.setDraft("Why did this change?");
  const page = render(() => <LocalReview model={model} conversation={conversation} />);
  fireEvent.click(await page.findByRole("button", { name: "Select old line 2" })); flush();
  fireEvent.click(page.getByRole("button", { name: "Select new line 2" }), { shiftKey: true }); flush();
  expect(page.container.querySelectorAll(".diff-selected")).toHaveLength(2);
  expect(page.container.querySelectorAll(".diff-selected")).toHaveLength(2);
  fireEvent.click(page.getByRole("button", { name: "Ask Pi about selected lines" })); flush();
  expect(model.draft()).toBe("Why did this change?");
  const dialog = within(screen.getByRole("dialog", { name: "Ask Pi about selected lines" }));
  expect(dialog.getByText("src/a.ts")).toBeTruthy();
  const excerpt = dialog.getByLabelText("Selected code").textContent;
  expect(excerpt).toContain("2-old");
  expect(excerpt).toContain("2+<script>alert(1)</script>");
  expect(excerpt).not.toContain(" same"); expect(excerpt).not.toContain("diff --git");
  expect(transport).not.toHaveBeenCalled(); expect(conversation).not.toHaveBeenCalled();
  expect(page.getByText("0 / 1 files reviewed")).toBeTruthy();
});

it("drags backwards across line numbers and clears selection on pointer cancellation", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const model = createSessionModel("session", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  const added = await page.findByRole("button", { name: "Select new line 2" });
  const removed = page.getByRole("button", { name: "Select old line 2" });
  const pointer = (element: Element | Window, type: string, buttons = 1) => {
    const event = new MouseEvent(type, { bubbles: true, buttons, button: 0 });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    fireEvent(element, event); flush();
  };
  pointer(added, "pointerdown"); pointer(removed.closest(".diff-line")!, "pointerenter"); pointer(window, "pointerup", 0);
  fireEvent.click(removed, { detail: 1 }); flush();
  expect(page.container.querySelectorAll(".diff-selected")).toHaveLength(2);
  expect(removed.getAttribute("aria-pressed")).toBe("true");
  expect(added.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(page.getByRole("button", { name: "Ask Pi about selected lines" })); flush();
  const excerpt = screen.getByLabelText("Selected code").textContent!;
  expect(excerpt.indexOf("-old")).toBeLessThan(excerpt.indexOf("+<script>"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); flush();
  pointer(added, "pointerdown"); pointer(window, "pointercancel", 0);
  expect(page.queryByRole("button", { name: "Ask Pi about selected lines" })).toBeNull();
});

it("extends a range with keyboard/tap activation and clears it on refresh and file changes", async () => {
  const second = { ...file, path: "src/b.ts", fingerprint: "b" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot([file, second])))));
  const model = createSessionModel("session", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  fireEvent.click(await page.findByRole("button", { name: "Select old line 1, new line 1" })); flush();
  fireEvent.click(page.getByRole("button", { name: "Choose end line" })); flush();
  expect(page.getByRole("button", { name: "Choose end line" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(page.getByRole("button", { name: "Select new line 2" })); flush();
  expect(page.container.querySelectorAll(".diff-selected")).toHaveLength(3);
  fireEvent.click(page.getByRole("button", { name: "Clear selection" })); flush();
  expect(page.container.querySelectorAll(".diff-selected")).toHaveLength(0);
  fireEvent.click(page.getByRole("button", { name: "Select new line 2" })); flush();
  fireEvent.click(page.getByRole("button", { name: /src\/b.ts/ })); flush();
  expect(page.queryByRole("button", { name: "Ask Pi about selected lines" })).toBeNull();
  fireEvent.click(page.getByRole("button", { name: "Select new line 2" })); flush();
  fireEvent.click(page.getByRole("button", { name: "Refresh" })); flush();
  await waitFor(() => { flush(); expect(model.review.busy()).toBe(false); });
  expect(page.queryByRole("button", { name: "Ask Pi about selected lines" })).toBeNull();
});

it("selects expanded context with correct source coordinates and clears it when scope changes", async () => {
  const selected = { ...file, patch: file.patch.replace("@@ -1,2 +1,2 @@", "@@ -25,2 +25,2 @@") };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/context")
    ? { oldStart: 5, newStart: 5, lines: Array.from({ length: 20 }, (_, i) => `context ${i + 5}`), hasMore: false, noNewline: false }
    : snapshot([selected])))));
  const model = createSessionModel("session", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  fireEvent.click(await page.findByRole("button", { name: "Select old line 26" })); flush();
  fireEvent.click(page.getByRole("button", { name: "Expand 20 lines above" }));
  const first = await page.findByRole("button", { name: "Select old line 5, new line 5" });
  expect(page.queryByRole("button", { name: "Ask Pi about selected lines" })).toBeNull();
  fireEvent.click(first); flush();
  fireEvent.click(page.getByRole("button", { name: "Select old line 25, new line 25" }), { shiftKey: true }); flush();
  expect(page.container.querySelectorAll(".diff-selected")).toHaveLength(21);
  fireEvent.click(page.getByRole("button", { name: "Ask Pi about selected lines" })); flush();
  expect(screen.getByLabelText("Selected code").textContent).toContain("55 context 5");
  expect(screen.getByLabelText("Selected code").textContent).toContain("2525 same");
  expect(screen.getByLabelText("Selected code").textContent).not.toContain("-old");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); flush();
  fireEvent.click(page.getByRole("button", { name: "Staged" })); flush();
  await waitFor(() => { flush(); expect(model.review.busy()).toBe(false); });
  expect(page.queryByRole("button", { name: "Ask Pi about selected lines" })).toBeNull();
});

it("preserves touch selections and extension state when native scrolling cancels a pointer", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const model = createSessionModel("session", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  fireEvent.click(await page.findByRole("button", { name: "Select old line 2" })); flush();
  fireEvent.click(page.getByRole("button", { name: "Choose end line" })); flush();
  fireEvent.pointerCancel(window, { pointerType: "touch" }); flush();
  expect(page.container.querySelectorAll(".diff-selected")).toHaveLength(1);
  expect(page.getByRole("button", { name: "Choose end line" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(page.getByRole("button", { name: "Select new line 2" })); flush();
  expect(page.container.querySelectorAll(".diff-selected")).toHaveLength(2);
});

it("allows selection in the text fallback after a structural comparison", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/structural")
    ? { mode: "text", reason: "Unsupported language" } : snapshot()))));
  const model = createSessionModel("session", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  fireEvent.click(await page.findByRole("button", { name: "Select old line 2" })); flush();
  fireEvent.click(page.getByRole("button", { name: "Structural" })); flush();
  await page.findByText(/Unsupported language/);
  expect(page.container.querySelectorAll(".diff-selected")).toHaveLength(0);
  fireEvent.click(page.getByRole("button", { name: "Select new line 2" })); flush();
  expect(page.container.querySelectorAll(".diff-selected")).toHaveLength(1);
  fireEvent.click(page.getByRole("button", { name: "Ask Pi about selected lines" })); flush();
  expect(screen.getByLabelText("Selected code").textContent).toContain("2+<script>alert(1)</script>");
});

it("rejects oversized selected context without losing the draft or leaving review", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const conversation = vi.fn(), transport = vi.fn(() => true);
  const model = createSessionModel("session", transport, () => true, undefined, () => "cap");
  const draft = "界".repeat(10920); model.setDraft(draft);
  const page = render(() => <LocalReview model={model} conversation={conversation} />);
  fireEvent.click(await page.findByRole("button", { name: "Select new line 2" })); flush();
  fireEvent.click(page.getByRole("button", { name: "Ask Pi about selected lines" })); flush();
  fireEvent.input(screen.getByRole("textbox", { name: "Your question" }), { target: { value: draft } }); flush();
  expect(screen.getByRole("alert").textContent).toContain("Select fewer lines");
  expect(model.draft()).toBe(draft); expect(conversation).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
});

it("renders escaped diff text, tracks review and opens the shared Ask Pi modal without changing the draft", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const transport = vi.fn(() => true); const conversation = vi.fn();
  const model = createSessionModel("session", transport, () => true, undefined, () => "cap"); model.setDraft("Existing question");
  const page = render(() => <LocalReview model={model} conversation={conversation} />);
  await waitFor(() => { flush(); expect(page.container.querySelector(".diff-add code")?.textContent).toBe("<script>alert(1)</script>"); });
  expect(page.container.querySelector("script")).toBeNull();
  fireEvent.click(page.getByRole("button", { name: "Staged" })); flush();
  await waitFor(() => { flush(); expect(model.review.target()).toEqual({ scope: "staged" }); expect(model.review.busy()).toBe(false); });
  fireEvent.click(page.getByLabelText("Reviewed")); flush(); expect(page.getByText("1 / 1 files reviewed")).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Ask Pi about file" })); flush();
  expect(screen.getByRole("dialog", { name: "Ask Pi about file" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Your question" })).toBeTruthy();
  expect([...screen.getByLabelText("File changes").querySelectorAll("code")].map(code => code.textContent).join("\n")).toBe(file.patch.trimEnd());
  expect(model.draft()).toBe("Existing question");
  expect(transport).not.toHaveBeenCalled(); expect(conversation).not.toHaveBeenCalled();
});

it.each(["example.ts", "example.txt"])("hides only diff prefixes and retains source operators in %s", async path => {
  const patch = "--- a/example\n+++ b/example\n@@ -1,3 +1,3 @@\n---count;\n+++count;\n   indented();\n \n\\ No newline at end of file";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot([{ ...file, path, patch }])))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("region", { name: "Unified diff" });
  expect(page.container.querySelector(".diff-remove code")?.textContent).toBe("--count;");
  expect(page.container.querySelector(".diff-add code")?.textContent).toBe("++count;");
  expect([...page.container.querySelectorAll(".diff-context code")].map(code => code.textContent)).toEqual(["  indented();", " "]);
  expect(page.getByText("--- a/example")).toBeTruthy(); expect(page.getByText("+++ b/example")).toBeTruthy();
  expect(page.getByText("\\ No newline at end of file")).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Ask Pi about file" })); flush();
  expect([...screen.getByLabelText("File changes").querySelectorAll("code")].map(code => code.textContent).join("\n")).toBe(patch.trimEnd());
  expect(model.draft()).toBe("");
});

it("highlights both sides of small diffs while preserving text, line numbers and multiline comments", async () => {
  const patch = "@@ -1,3 +1,3 @@\n /* comment\n-old text\n+new text\n */\n@@ -20 +20 @@\n-const count = 1;\n+const count = 2;";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot([{ ...file, patch }])))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.container.querySelector(".diff-add .hljs-keyword")?.textContent).toBe("const"); });
  expect(page.container.querySelector(".diff-remove .hljs-keyword")?.textContent).toBe("const");
  expect(page.container.querySelector(".diff-add .hljs-comment")?.textContent).toBe("new text");
  expect([...page.container.querySelectorAll(".diff-line code")].map(code => code.textContent).join("\n")).toBe("@@ -1,3 +1,3 @@\n/* comment\nold text\nnew text\n*/\n@@ -20 +20 @@\nconst count = 1;\nconst count = 2;");
  const added = page.container.querySelectorAll(".diff-add");
  expect(added[1].querySelectorAll(".diff-number")[1].textContent).toBe("20");
});

it.each([
  ["@@ -0,0 +1 @@\n+// note\rconst changed = 1;", "@@ -0,0 +1 @@\n// note\rconst changed = 1;"],
  ["@@ -1,2 +1,2 @@\n-const old = 1;\r\n+const changed = 2;\r\n // context\r", "@@ -1,2 +1,2 @@\nconst old = 1;\r\nconst changed = 2;\r\n// context\r"],
])("preserves carriage returns and every source row during highlighting", async (patch, displayed) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot([{ ...file, patch }])))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.container.querySelector(".diff-add code")).toBeTruthy(); });
  expect([...page.container.querySelectorAll(".diff-line code")].map(code => code.textContent).join("\n")).toBe(displayed);
  expect(page.container.querySelector(".hljs-keyword")).toBeTruthy();
});

it.each([
  ["unknown.xyz", "@@ -1 +1 @@\n-const x = 1;\n+const x = 2;"],
  ["__proto__", "@@ -1 +1 @@\n-const x = 1;\n+const x = 2;"],
  ["many-lines.ts", "@@ -0,0 +1,401 @@\n" + "+const x = 2;\n".repeat(401)],
  ["unicode.ts", "@@ -1 +1 @@\n-const x = 1;\n+//" + "界".repeat(5500)],
  ["large.ts", "@@ -1 +1 @@\n-const x = 1;\n+const x = 2; //" + "x".repeat(16384)],
])("keeps unsupported or large diffs plain: %s", async (path, patch) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot([{ ...file, path, patch }])))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.container.querySelector(".diff-add code")).toBeTruthy(); });
  expect(page.container.querySelector('[class*="hljs-"]')).toBeNull();
  expect(page.container.querySelector(".diff-add code")?.textContent).toBe(patch.split("\n")[2].slice(1));
  expect(page.getByText(/Plain text/)).toBeTruthy();
});

it("highlights HTML as inert text and resets syntax between disconnected hunks", async () => {
  const patch = '@@ -0,0 +1 @@\n+<!-- open comment\n@@ -0,0 +20 @@\n+<img src="x" onerror="alert(1)"><script>alert(1)</script>&amp;';
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot([{ ...file, path: "page.html", patch }])))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.container.querySelector(".hljs-name")?.textContent).toBe("img"); });
  expect(page.container.querySelector("img, script")).toBeNull();
  expect(page.container.querySelector(".hljs-comment")?.textContent).toBe("<!-- open comment");
  expect([...page.container.querySelectorAll(".diff-line code")].map(code => code.textContent).join("\n")).toBe('@@ -0,0 +1 @@\n<!-- open comment\n@@ -0,0 +20 @@\n<img src="x" onerror="alert(1)"><script>alert(1)</script>&amp;');
});

it("toggles Reviewed through the shared checkbox control and label", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.getByRole("checkbox", { name: "Reviewed" })).toBeTruthy(); });
  const input = page.getByRole("checkbox", { name: "Reviewed" }) as HTMLInputElement;
  const control = page.container.querySelector(".review-reviewed .checkbox-control");
  expect(control).not.toBeNull();
  expect(input.checked).toBe(false);
  fireEvent.click(control!); flush();
  expect(input.checked).toBe(true);
  expect(control!.hasAttribute("data-checked")).toBe(true);
  expect(model.review.isReviewed(file)).toBe(true);
  fireEvent.click(page.getByText("Reviewed", { selector: "label" })); flush();
  expect(input.checked).toBe(false);
  expect(control!.hasAttribute("data-checked")).toBe(false);
  expect(model.review.isReviewed(file)).toBe(false);
});

it("filters paths and moves to the next unreviewed file without sending anything", async () => {
  const other = { ...file, path: "tests/b.ts" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot([file, other])))));
  const transport = vi.fn(() => true);
  const model = createSessionModel("s", transport, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.getByRole("heading", { name: file.path })).toBeTruthy(); });
  const filter = page.getByRole("searchbox", { name: "Filter files" }) as HTMLInputElement;
  fireEvent.input(filter, { target: { value: "tests/" } });
  expect(filter.value).toBe("tests/"); // Kobalte must not restore the previous value during input.
  flush();
  expect(page.queryByRole("button", { name: /a.ts/ })).toBeNull();
  expect(page.getByRole("button", { name: /b.ts/ })).toBeTruthy();
  fireEvent.input(page.getByRole("searchbox", { name: "Filter files" }), { target: { value: "missing" } }); flush();
  expect(page.getByText("No files match your filter.")).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Clear filter" })); flush();
  fireEvent.click(page.getByLabelText("Reviewed")); flush();
  fireEvent.click(page.getByRole("button", { name: "Next unreviewed" })); flush();
  expect(page.getByRole("heading", { name: other.path })).toBeTruthy();
  fireEvent.click(page.getByLabelText("Reviewed")); flush();
  expect(page.getByRole("button", { name: "Next unreviewed" }).hasAttribute("disabled")).toBe(true);
  expect(transport).not.toHaveBeenCalled();
});

it("opens the file picker, closes it on selection and jumps to the selected diff", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot([file, { ...file, path: "src/b.ts" }])))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.getByRole("heading", { name: file.path })).toBeTruthy(); });
  const picker = page.getByRole("button", { name: "Files (2)" });
  expect(picker.closest(".review-file-header")).toBeTruthy();
  expect(picker.closest(".review-file-actions")).toBeTruthy();
  expect(page.container.querySelector(".review-toolbar .review-files-toggle")).toBeNull();
  expect(picker.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(picker); flush();
  expect(picker.getAttribute("aria-expanded")).toBe("true");
  const modal = within(within(document.body).getByRole("dialog", { name: "Changed files" }));
  expect(modal.getByRole("button", { name: "Close file picker" })).toBeTruthy();
  fireEvent.input(modal.getByRole("searchbox", { name: "Filter files" }), { target: { value: "b.ts" } }); flush();
  expect(modal.queryByRole("button", { name: "src/a.ts — modified" })).toBeNull();
  vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
  fireEvent.click(modal.getByRole("button", { name: "src/b.ts — modified" })); flush();
  expect(within(document.body).queryByRole("dialog")).toBeNull();
  expect(picker.getAttribute("aria-expanded")).toBe("false");
  await waitFor(() => expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" }));
  expect(page.getByRole("heading", { name: "src/b.ts" })).toBeTruthy();
  expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.instances).toContain(page.getByRole("article", { name: "Diff for src/b.ts" }));
  expect(document.activeElement).toBe(page.getByRole("article", { name: "Diff for src/b.ts" }));
  page.unmount();
  expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "instant" });
});

it("dismisses the file modal with Close or Escape and restores trigger focus", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.getByRole("heading", { name: file.path })).toBeTruthy(); });
  const picker = page.getByRole("button", { name: "Files (1)" });
  for (const method of ["close", "escape"]) {
    picker.focus(); fireEvent.click(picker); flush();
    const dialog = within(document.body).getByRole("dialog", { name: "Changed files" });
    if (method === "close") fireEvent.click(within(dialog).getByRole("button", { name: "Close file picker" }));
    else fireEvent.keyDown(dialog, { key: "Escape" });
    flush();
    expect(within(document.body).queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(picker));
    expect(page.getByRole("heading", { name: file.path })).toBeTruthy();
  }
});

it("cancels a pending scroll when leaving changes", async () => {
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 72));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.getByRole("heading", { name: file.path })).toBeTruthy(); });
  fireEvent.click(page.getByRole("button", { name: "src/a.ts — modified" })); flush();
  page.unmount();
  expect(cancelAnimationFrame).toHaveBeenCalledWith(72);
});

it("aborts the snapshot request when leaving changes", async () => {
  const request = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal("fetch", request);
  const model = createSessionModel("session", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  const signal = (request.mock.calls as unknown as [string, RequestInit][])[0][1].signal!;
  page.unmount(); expect(signal.aborted).toBe(true);
});

it("shows metadata file counts and retains them after selected patch loads", async () => {
  const entries = [
    { ...file, lineStats: { added: 12, removed: 3 }, patch: null, fingerprint: null },
    { ...file, path: "other.ts", lineStats: { added: 0, removed: 5 }, patch: null, fingerprint: null },
    { ...file, path: "binary", patch: null, fingerprint: null },
  ];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    return new Response(JSON.stringify(request.path ? snapshot([{ ...file, path: request.path }]) : snapshot(entries)));
  });
  vi.stubGlobal("fetch", fetch);
  const model = createSessionModel("file-counts", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  const first = await page.findByRole("button", { name: "src/a.ts — modified — 12 added, 3 deleted" });
  await page.findByRole("heading", { name: file.path });
  expect(first.textContent).toContain("+12"); expect(first.textContent).toContain("−3");
  expect(page.getByRole("button", { name: "other.ts — modified — 0 added, 5 deleted" }).textContent).toContain("+0");
  expect(page.getByRole("button", { name: "binary — modified" }).querySelector(".review-file-counts")).toBeNull();
  expect(fetch.mock.calls.filter(([, init]) => JSON.parse(init.body as string).path)).toHaveLength(1);
});


it.each([null, {}, { added: -1, removed: 0 }, { added: 1.5, removed: 0 }, { added: 0, removed: "1" }, { added: Number.MAX_SAFE_INTEGER, removed: 1 }])("rejects invalid file line counts", async lineStats => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...snapshot(), files: [{ ...file, lineStats }] }))));
  await expect(fetchReview("s", { scope: "unstaged" }, new AbortController().signal, "cap")).rejects.toThrow("Invalid file line counts.");
});
