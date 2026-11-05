import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { LocalReview } from "../src/LocalReview";
import { createSessionModel } from "../src/session-model";
import { createLocalReview, diffLines, fetchReview, reviewDraft, type ReviewFile, type ReviewSnapshot } from "../src/local-review";

const file: ReviewFile = { fingerprint: "snapshot-a", path: "src/a.ts", previousPath: null, status: "modified", patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n same\n-old\n+<script>alert(1)</script>\n" };
const snapshot = (files = [file]): ReviewSnapshot => ({ files, truncated: false, note: null });
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); vi.spyOn(window, "scrollTo").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
  fireEvent.click(page.getByRole("button", { name: "Group with AI" }));
  await page.findByRole("heading", { name: "<script>Feature</script>" });
  expect(page.getByRole("heading", { name: "Ungrouped" })).toBeTruthy();
  expect(page.container.querySelector("script")).toBeNull();
  expect(model.draft()).toBe("Keep my draft"); expect(transport).not.toHaveBeenCalled();
  const groupRequest = request.mock.calls.find(([url]) => url.endsWith("/groups"))![1];
  expect(groupRequest.headers).toEqual({ "content-type": "application/json", "x-pi-capability": "cap" });
  expect(JSON.parse(groupRequest.body as string)).toEqual({ files: [file, second].map(({ path, patch }) => ({ path, patch })) });
  fireEvent.click(page.getByRole("button", { name: "Folders" })); flush();
  expect(page.getByRole("heading", { name: "src" })).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Refresh" }));
  await waitFor(() => { flush(); expect(page.queryByRole("button", { name: "AI intent" })).toBeNull(); });
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
  fireEvent.click(page.getByRole("button", { name: "Ask Pi" })); flush();
  expect(model.draft()).toContain(selected.patch); expect(model.draft()).not.toContain("const value5");
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
  expect((page.getByRole("button", { name: "Ask Pi" }) as HTMLButtonElement).disabled).toBe(true);
  expect((page.getByRole("button", { name: "Structural" }) as HTMLButtonElement).disabled).toBe(true);
  expect((page.getByLabelText("Reviewed") as HTMLInputElement).disabled).toBe(true);
  reply(new Response(JSON.stringify(snapshot())));
  await waitFor(() => { flush(); expect((page.getByRole("button", { name: "Ask Pi" }) as HTMLButtonElement).disabled).toBe(false); });
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
  expect(draft).toContain("My question\n\nReview the local branch changes"); expect(draft).toContain(file.patch);
  expect(() => reviewDraft("x".repeat(32768), file, { scope: "staged" })).toThrow("message limit");
});

it("renders escaped diff text, tracks review and adds Ask Pi to an unsent draft", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const transport = vi.fn(() => true); const conversation = vi.fn();
  const model = createSessionModel("session", transport, () => true, undefined, () => "cap"); model.setDraft("Existing question");
  const page = render(() => <LocalReview model={model} conversation={conversation} />);
  await waitFor(() => { flush(); expect(page.container.querySelector(".diff-add code")?.textContent).toBe("<script>alert(1)</script>"); });
  expect(page.container.querySelector("script")).toBeNull();
  fireEvent.click(page.getByRole("button", { name: "Staged" })); flush();
  await waitFor(() => { flush(); expect(model.review.target()).toEqual({ scope: "staged" }); expect(model.review.busy()).toBe(false); });
  fireEvent.click(page.getByLabelText("Reviewed")); flush(); expect(page.getByText("1 / 1 files reviewed")).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Ask Pi" })); flush();
  expect(model.draft()).toContain("Existing question\n\nReview the local staged changes");
  expect(transport).not.toHaveBeenCalled(); expect(conversation).toHaveBeenCalledOnce();
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
  fireEvent.click(page.getByRole("button", { name: "Ask Pi" })); flush();
  expect(model.draft()).toContain(patch);
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
  const control = page.container.querySelector(".checkbox-control");
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
  fireEvent.input(page.getByRole("searchbox", { name: "Filter files" }), { target: { value: "tests/" } }); flush();
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
  expect(picker.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(picker); flush();
  expect(picker.getAttribute("aria-expanded")).toBe("true");
  await waitFor(() => expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.instances).toContain(page.getByRole("navigation", { name: "Changed files" })));
  vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
  fireEvent.click(page.getByRole("button", { name: "src/b.ts — modified" })); flush();
  expect(picker.getAttribute("aria-expanded")).toBe("false");
  await waitFor(() => expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" }));
  expect(page.getByRole("heading", { name: "src/b.ts" })).toBeTruthy();
  expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.instances).toContain(page.getByRole("article", { name: "Diff for src/b.ts" }));
  expect(document.activeElement).toBe(page.getByRole("article", { name: "Diff for src/b.ts" }));
  page.unmount();
  expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "instant" });
});

it("cancels a pending scroll when leaving changes", async () => {
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 72));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.getByRole("heading", { name: file.path })).toBeTruthy(); });
  fireEvent.click(page.getByRole("button", { name: "Files (1)" })); flush();
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
