import { afterEach, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { createContextReview, fetchContextReview, type ContextChunk, type ContextRequest } from "../src/context-review";
import { createLocalReview, diffLines, type ReviewFile } from "../src/local-review";

const file: ReviewFile = { path: "file.ts", previousPath: null, status: "modified", fingerprint: "snapshot", patch: "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -25,3 +25,4 @@ example\n before\n-old\n+new\n+extra\n after\n@@ -70,3 +71,3 @@\n before70\n-old71\n+new72\n after72\n" };
const target = { scope: "unstaged" } as const;
const chunk = (request: ContextRequest, hasMore = false): ContextChunk => ({ oldStart: request.oldStart, newStart: request.newStart, lines: Array.from({ length: request.count }, (_, i) => `line${request.oldStart + i}`), hasMore, noNewline: false });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("requests bounded snapshot context with capability proof and validates positions", async () => {
  const request: ContextRequest = { ...target, path: file.path, fingerprint: file.fingerprint, oldStart: 5, newStart: 5, count: 20 };
  const fetch = vi.fn(async () => new Response(JSON.stringify(chunk(request)))); vi.stubGlobal("fetch", fetch);
  expect(await fetchContextReview("a/b", request, new AbortController().signal, "cap")).toEqual(chunk(request));
  expect(fetch).toHaveBeenCalledWith("/review/a%2Fb/context", expect.objectContaining({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal: expect.any(AbortSignal), headers: { "content-type": "application/json", "x-pi-capability": "cap" }, body: JSON.stringify(request) }));
});

it.each([
  {}, { oldStart: 1, newStart: 2, lines: [], hasMore: false, noNewline: false }, { oldStart: 1, newStart: 1, lines: [2], hasMore: false, noNewline: false },
  { oldStart: 1, newStart: 1, lines: ["a\nb"], hasMore: false, noNewline: false }, { oldStart: 1, newStart: 1, lines: ["x".repeat(65536)], hasMore: false, noNewline: false },
  { oldStart: 1, newStart: 1, lines: Array(21).fill("x"), hasMore: true, noNewline: false }, { oldStart: 1, newStart: 1, lines: [], hasMore: true, noNewline: false },
  { oldStart: 1, newStart: 1, lines: [], hasMore: false, noNewline: true }, { oldStart: 1, newStart: 1, lines: Array(20).fill("x"), hasMore: true, noNewline: true },
])("rejects malformed, oversized and mismatched responses", async value => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value))));
  await expect(fetchContextReview("s", { ...target, path: "a", fingerprint: "f", oldStart: 1, newStart: 1, count: 20 }, new AbortController().signal, "cap")).rejects.toThrow();
});

it("preserves CR and tabs and reports actionable failures", async () => {
  const request = { ...target, path: "a", fingerprint: "f", oldStart: 1, newStart: 1, count: 20 };
  const fetch = vi.fn(async () => new Response(JSON.stringify({ oldStart: 1, newStart: 1, lines: ["\t<script>x</script>\r"], hasMore: false, noNewline: true }))); vi.stubGlobal("fetch", fetch);
  expect((await fetchContextReview("s", request, new AbortController().signal, "cap")).lines).toEqual(["\t<script>x</script>\r"]);
  await expect(fetchContextReview("s", request, new AbortController().signal, null)).rejects.toThrow("Authentication required");
  fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(fetchContextReview("s", request, new AbortController().signal, "cap")).rejects.toThrow("Authentication required");
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Snapshot changed. Refresh." }), { status: 422 }));
  await expect(fetchContextReview("s", request, new AbortController().signal, "cap")).rejects.toThrow("Snapshot changed. Refresh.");
});

it("expands both ends of gaps without duplicates or shifted line numbers", async () => {
  const load = vi.fn(async (request: ContextRequest) => chunk(request));
  const context = createContextReview(load);
  expect(context.view(file).gaps.map(gap => gap.remaining)).toEqual([24, 42, null]);
  await context.expand(file, target, 0, "above"); flush();
  expect(load.mock.lastCall?.[0]).toMatchObject({ oldStart: 5, newStart: 5, count: 20 });
  await context.expand(file, target, 0, "above"); flush();
  expect(load.mock.lastCall?.[0]).toMatchObject({ oldStart: 1, newStart: 1, count: 4 });
  expect(context.view(file).gaps.map(gap => gap.remaining)).toEqual([42, null]);
  await context.expand(file, target, 1, "below"); flush();
  expect(load.mock.lastCall?.[0]).toMatchObject({ oldStart: 28, newStart: 29, count: 20 });
  await context.expand(file, target, 1, "above"); flush();
  expect(load.mock.lastCall?.[0]).toMatchObject({ oldStart: 50, newStart: 51, count: 20 });
  await context.expand(file, target, 1, "below"); flush();
  expect(load.mock.lastCall?.[0]).toMatchObject({ oldStart: 48, newStart: 49, count: 2 });
  expect(context.view(file).gaps.map(gap => gap.remaining)).toEqual([null]);
  const lines = diffLines(context.view(file).patch);
  const contextLines = lines.filter(line => line.kind === "context");
  expect(contextLines.filter(line => line.old! < 25).map(line => line.old)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
  expect(contextLines.filter(line => line.old! >= 28 && line.old! < 70).map(line => line.next)).toEqual(Array.from({ length: 42 }, (_, i) => i + 29));
  expect(lines.find(line => line.text === "+new72")?.next).toBe(72);
  expect(lines.find(line => line.text === "-old71")?.old).toBe(71);
});

it("discovers trailing EOF without re-requesting it", async () => {
  const load = vi.fn(async (request: ContextRequest) => ({ ...chunk(request), lines: ["last\r"], hasMore: false }));
  const context = createContextReview(load);
  await context.expand(file, target, 2, "below"); flush();
  expect(load.mock.lastCall?.[0]).toMatchObject({ oldStart: 73, newStart: 74 });
  expect(context.view(file).gaps.map(gap => gap.id)).toEqual([0, 1]);
  expect(diffLines(context.view(file).patch).at(-1)).toEqual({ text: " last\r", kind: "context", old: 73, next: 74 });
  await context.expand(file, target, 2, "below"); expect(load).toHaveBeenCalledOnce();
});

it("retains a newly revealed unterminated EOF marker without counting it as a source line", async () => {
  const context = createContextReview(async request => ({ ...chunk(request), lines: ["unterminated"], hasMore: false, noNewline: true }));
  await context.expand(file, target, 2, "below"); flush();
  const displayed = context.view(file).patch;
  expect(displayed.split("\n").filter(line => line === "\\ No newline at end of file")).toHaveLength(1);
  const rows = diffLines(displayed);
  expect(rows.at(-2)).toEqual({ text: " unterminated", kind: "context", old: 73, next: 74 });
  expect(rows.at(-1)).toEqual({ text: "\\ No newline at end of file", kind: "header" });
});

it("preserves prior expansion on stale errors and resets on file change and refresh", async () => {
  const load = vi.fn(async (request: ContextRequest) => chunk(request));
  const review = createLocalReview(async () => ({ files: [file], truncated: false, note: null }), undefined, load);
  await review.refresh(); flush();
  await review.context.expand(file, target, 0, "above"); flush();
  const displayed = review.context.view(file).patch;
  load.mockRejectedValueOnce(new Error("Snapshot changed. Refresh."));
  await review.context.expand(file, target, 0, "above"); flush();
  expect(review.context.error()).toBe("Snapshot changed. Refresh.");
  expect(review.context.view(file).patch).toBe(displayed);
  review.setSelected("other.ts"); flush();
  expect(review.context.view(file).patch).toBe(file.patch); expect(review.context.error()).toBe("");
  await review.context.expand(file, target, 0, "above"); flush();
  await review.refresh(); flush(); expect(review.context.view(file).patch).toBe(file.patch);
});

it("bounds retained context without discarding the preceding expansion", async () => {
  const selected = { ...file, patch: "@@ -500,1 +500,1 @@\n-old\n+new\n" };
  const context = createContextReview(async request => ({ ...chunk(request), lines: Array(request.count).fill("x".repeat(2000)) }));
  for (let i = 0; i < 6; i++) { await context.expand(selected, target, 0, "above"); flush(); }
  const displayed = context.view(selected).patch;
  await context.expand(selected, target, 0, "above"); flush();
  expect(context.error()).toContain("256 KiB limit"); expect(context.view(selected).patch).toBe(displayed);
  expect(context.view(selected).gaps[0].remaining).toBe(379);
});

it("aborts reset work and ignores its late reply, admitting only one request at a time", async () => {
  let reply!: (value: ContextChunk) => void;
  const load = vi.fn((_request: ContextRequest, _signal: AbortSignal) => new Promise<ContextChunk>(resolve => { reply = resolve; }));
  const context = createContextReview(load);
  const pending = context.expand(file, target, 0, "above");
  await context.expand(file, target, 1, "below"); expect(load).toHaveBeenCalledOnce();
  context.reset(); flush(); expect(load.mock.calls[0][1].aborted).toBe(true);
  reply(chunk(load.mock.calls[0][0])); await pending; flush();
  expect(context.view(file).patch).toBe(file.patch); expect(context.busy()).toBe(false);
});

it.each(["added", "deleted", "untracked", "unmerged"])("has no controls for %s files", status => {
  expect(createContextReview(vi.fn()).view({ ...file, status }).gaps).toEqual([]);
});

it("rejects malformed hunks and handles zero-count insertion/deletion boundaries", async () => {
  const context = createContextReview(async request => chunk(request));
  expect(context.view({ ...file, patch: "Binary files differ" }).gaps).toEqual([]);
  expect(context.view({ ...file, patch: "@@ -2,4 +2,4 @@\n x\n" }).gaps).toEqual([]);
  const insertion = { ...file, patch: "@@ -5,0 +6,1 @@\n+added\n" };
  await context.expand(insertion, target, 0, "above"); flush();
  expect(diffLines(context.view(insertion).patch).filter(line => line.kind === "context").map(line => line.old)).toEqual([1, 2, 3, 4, 5]);
  expect(diffLines(context.view(insertion).patch).at(-1)?.next).toBe(6);
  context.reset(); flush();
  const deletion = { ...file, patch: "@@ -6,1 +5,0 @@\n-removed\n\\ No newline at end of file\n" };
  await context.expand(deletion, target, 0, "above"); flush();
  expect(diffLines(context.view(deletion).patch).find(line => line.kind === "remove")?.old).toBe(6);
  expect(context.view(deletion).gaps).toEqual([]);
});
