import { afterEach, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { waitFor } from "@solidjs/testing-library";
import { createLocalReview } from "../src/local-review";
import { createReviewGroups, fetchReviewGroups, normalizeGroups, type GroupInput, type GroupRequest } from "../src/review-groups";

const files: GroupInput[] = [{ path: "a.ts", status: "modified", patch: "+a", fingerprint: "a" }, { path: "b.ts", status: "modified", patch: "+b", fingerprint: "b" }];
const request: GroupRequest = { files: files.map(file => ({ path: file.path, status: file.status, patch: file.patch, added: 0, removed: 0, patchLines: 1, sampled: false })), details: [], readsRemaining: 8 };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each([null, {}, { groups: "x" }, { groups: [{ title: "", reason: "", paths: ["a.ts"] }] }, { groups: [{ title: "X", reason: [], paths: ["a.ts"] }] }, { groups: [{ title: "X", reason: "", paths: [] }] }, { groups: [{ title: "X", reason: "", paths: ["a.ts"] }, { title: "Y", reason: "", paths: ["a.ts"] }] }])("rejects malformed grouping output %j", value => {
  expect(() => normalizeGroups(value, files)).toThrow();
});
it("merges across former 100-file boundaries in one global request", async () => {
  const entries = Array.from({ length: 1000 }, (_, i) => ({ path: `${i}.ts`, status: "modified", patch: null, uncaptured: true }));
  const infer = vi.fn(async () => ({ groups: [{ title: "Feature", reason: "", paths: ["0.ts", "999.ts"] }] }));
  const groups = createReviewGroups(infer);
  await groups.run(async () => entries); flush();
  expect(groups.error()).toBe(""); expect(infer).toHaveBeenCalledTimes(1);
  expect(groups.value()![0].paths).toEqual(["0.ts", "999.ts"]);
  const paths = groups.value()!.flatMap(group => group.paths);
  expect(paths).toHaveLength(1000); expect(new Set(paths).size).toBe(1000);
  expect(groups.coverage()?.metadata).toBe(1000);
  expect(groups.notice()).not.toContain("batch-local");
});

it("groups 1000 files globally without eagerly loading patches", async () => {
  const entries = Array.from({ length: 1000 }, (_, i) => ({ path: `${i}.ts`, previousPath: null, status: "modified", patch: null, fingerprint: null }));
  let patchReads = 0;
  const load = async (request: { path?: string; cursor?: string }) => {
    if (request.path) { patchReads++; return { files: [{ ...entries.find(file => file.path === request.path)!, patch: "+x", fingerprint: request.path }], truncated: false, note: null }; }
    const start = Number(request.cursor ?? 0);
    return { files: entries.slice(start, start + 100), truncated: false, note: null, ...(start < 900 ? { nextCursor: String(start + 100) } : {}) };
  };
  const infer = vi.fn(async (request: GroupRequest) => {
    expect(patchReads).toBe(1);
    expect(request.files).toHaveLength(1000);
    return { groups: [{ title: "Batch", reason: "", paths: request.files.map(file => file.path) }] };
  });
  const review = createLocalReview(load, undefined, undefined, undefined, infer);
  await review.refresh(); await review.groupWithAI(); flush();
  expect(infer).toHaveBeenCalledTimes(1); expect(review.grouping.error()).toBe("");
  expect(review.grouping.coverage()?.files).toBe(1000);
  expect(review.snapshot()?.files.filter(file => file.patch !== null)).toHaveLength(1);
  expect(review.selected()).toBe("0.ts");
});

it("applies updated preferences to future runs without changing a running budget", async () => {
  const infer = vi.fn(async (request: GroupRequest) => merged(request));
  const groups = createReviewGroups(infer);
  groups.setOptions({ ...groups.options(), maxCalls: 1 }); flush();
  let ready!: (files: GroupInput[]) => void;
  const run = groups.run(() => new Promise(resolve => { ready = resolve; })); flush();
  groups.setOptions({ ...groups.options(), maxCalls: 10 }); flush();
  expect(groups.options().maxCalls).toBe(10);
  ready(oversized()); await run; flush();
  expect(infer).toHaveBeenCalledTimes(1);
  expect(groups.error()).toContain("budget");
  await groups.run(async () => files); flush();
  expect(groups.error()).toBe("");
});

it("stops before exceeding the configured paid-call budget", async () => {
  const infer = vi.fn(async (request: GroupRequest) => merged(request));
  const groups = createReviewGroups(infer);
  groups.setOptions({ ...groups.options(), maxCalls: 1 }); flush();
  await groups.run(async () => oversized()); flush();
  expect(infer).toHaveBeenCalledTimes(1);
  expect(groups.error()).toContain("budget");
  expect(groups.value()).toBeUndefined();
  expect(groups.usage().calls).toBe(1);
});

it("stops before the next request would cross its total byte allowance", async () => {
  const infer = vi.fn(async () => ({ readDiffs: [{ path: "a.ts", startLine: 1 }] }));
  const groups = createReviewGroups(infer);
  groups.setOptions({ ...groups.options(), maxRequestBytes: 1024 }); flush();
  await groups.run(async () => [{ ...files[0], patch: "x".repeat(400) }]); flush();
  expect(infer).toHaveBeenCalledTimes(1); expect(groups.error()).toContain("budget");
  expect(groups.usage().requestBytes).toBeLessThanOrEqual(1024);
});
it("persists bounded suggestions in the same tab and isolates content/model cache keys", async () => {
  sessionStorage.clear();
  const infer = vi.fn(async () => ({ groups: [{ title: "Feature", reason: "", paths: ["a.ts", "b.ts"] }] }));
  const first = createReviewGroups(infer, "cache-test");
  await first.run(async () => files, undefined, { cacheKey: "content-model-1" });
  const second = createReviewGroups(infer, "cache-test");
  await second.run(async () => files, undefined, { cacheKey: "content-model-1" }); flush();
  expect(infer).toHaveBeenCalledTimes(1); expect(second.usage().reused).toBe(true);
  await second.run(async () => files, undefined, { cacheKey: "content-model-2" });
  expect(infer).toHaveBeenCalledTimes(2);
  expect(sessionStorage.getItem("pi-review-groups-v2:cache-test")).not.toContain("+hello");
  sessionStorage.clear();
});
it("retains twenty groups and one ungrouped remainder across repeated refreshes", async () => {
  const files = Array.from({ length: 20 }, (_, i) => ({ path: `${i}.ts`, previousPath: null, status: "modified", patch: "+a", fingerprint: "a" }));
  let snapshotKey = "a".repeat(64);
  const load = async (request: { path?: string }) => ({ files: request.path ? files.filter(file => file.path === request.path) : files, truncated: false, note: null, snapshotKey });
  const infer = vi.fn(async () => ({ groups: files.map(file => ({ title: file.path, reason: "", paths: [file.path] })) }));
  const review = createLocalReview(load, undefined, undefined, undefined, infer);
  await review.refresh(); await review.groupWithAI();
  for (let i = 20; i < 23; i++) {
    files.push({ ...files[0], path: `${i}.ts` }); snapshotKey = "b".repeat(64);
    await review.refresh(); flush();
    expect(review.error()).toBe("");
    expect(review.grouping.value()).toHaveLength(21);
    expect(review.grouping.value()?.at(-1)?.paths).toHaveLength(i - 19);
  }
  expect(infer).toHaveBeenCalledTimes(1);
});

it.each([true, false])("retains stale navigation when a snapshot has no cache identity (initial key: %s)", async initialKey => {
  let snapshotKey: string | undefined = initialKey ? "a".repeat(64) : undefined;
  const files = [{ path: "a.ts", previousPath: null, status: "modified", patch: "+a", fingerprint: "a" }];
  const load = async (request: { path?: string }) => ({ files: request.path ? files.filter(file => file.path === request.path) : files, truncated: false, note: null, snapshotKey });
  const infer = vi.fn(async () => ({ groups: [{ title: "Feature", reason: "", paths: ["a.ts"] }] }));
  const review = createLocalReview(load, undefined, undefined, undefined, infer);
  await review.refresh(); await review.groupWithAI();
  snapshotKey = undefined; files.push({ ...files[0], path: "b.ts" });
  await review.refresh(); await review.refresh(); flush();
  expect(review.grouping.stale()).toBe(true);
  expect(review.grouping.value()?.map(group => group.paths)).toEqual([["a.ts"], ["b.ts"]]);
  expect(infer).toHaveBeenCalledTimes(1);
});

it("keeps unchanged groups across refresh but marks same-name changed content stale", async () => {
  let snapshotKey = "a".repeat(64);
  const entry = { path: "a.ts", previousPath: null, status: "modified", patch: "+a", fingerprint: "a" };
  const load = async (request: { path?: string }) => ({ files: [entry], truncated: false, note: null, ...(request.path ? {} : { snapshotKey }) });
  const infer = vi.fn(async () => ({ groups: [{ title: "Feature", reason: "", paths: ["a.ts"] }] }));
  const review = createLocalReview(load, undefined, undefined, undefined, infer, undefined, { model: () => ({ provider: "test", id: "cheap" }) });
  await review.refresh(); await review.groupWithAI(); await review.refresh(); flush();
  expect(review.grouping.value()?.[0].title).toBe("Feature"); expect(review.grouping.stale()).toBe(false);
  snapshotKey = "b".repeat(64);
  await review.refresh(); flush();
  expect(review.grouping.stale()).toBe(true); expect(infer).toHaveBeenCalledTimes(1);
});

it("reuses verified content only and supports an explicit forced refresh", async () => {
  const infer = vi.fn(async () => ({ groups: [{ title: "Feature", reason: "", paths: ["a.ts", "b.ts"] }] }));
  const groups = createReviewGroups(infer);
  const reuse = { cacheKey: "scope-content-model-v2", verify: async () => true };
  await groups.run(async () => files, undefined, reuse);
  await groups.run(async () => files, undefined, reuse); flush();
  expect(infer).toHaveBeenCalledTimes(1); expect(groups.usage().reused).toBe(true);
  await groups.run(async () => files, undefined, { ...reuse, force: true }); flush();
  expect(infer).toHaveBeenCalledTimes(2);
  await groups.run(async () => files, undefined, { ...reuse, verify: async () => false }); flush();
  expect(infer).toHaveBeenCalledTimes(2); expect(groups.error()).toContain("moved on");
});
it("does not send noisy bodies or read them while leaving every filename in groups", async () => {
  const infer = vi.fn(async (request: GroupRequest) => merged(request));
  const groups = createReviewGroups(infer);
  await groups.run(async () => [{ ...files[0], path: "pnpm-lock.yaml", patch: "secret noisy content" }]); flush();
  expect(infer.mock.calls[0][0].files[0]).toMatchObject({ path: "pnpm-lock.yaml", status: "generated", patch: null, patchLines: 0 });
  expect(groups.value()![0].paths).toEqual(["pnpm-lock.yaml"]);
});
it("accounts repeated request bytes and provider usage without pretending missing prices are zero", async () => {
  const groups = createReviewGroups(async () => ({ groups: [], usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 2, costUsd: null } }));
  await groups.run(async () => files); flush();
  expect(groups.error()).toBe("");
  expect(groups.usage()).toMatchObject({ calls: 1, reportedCalls: 1, inputTokens: 20, outputTokens: 4, cacheReadTokens: 10, pricedCalls: 0 });
  expect(groups.usage().requestBytes).toBeGreaterThan(0);
});

const oversized = () => Array.from({ length: 1001 }, (_, i) => ({ path: `${i}.ts`, status: "modified", patch: null, uncaptured: true }));
const merged = (request: GroupRequest) => ({ groups: [{ title: "Whole change", reason: "Shared intent", paths: request.files.map(file => file.path) }] });
it("globally reconciles partitions rather than concatenating their groups", async () => {
  const infer = vi.fn(async (request: GroupRequest) => merged(request));
  const groups = createReviewGroups(infer);
  await groups.run(async () => oversized()); flush();
  expect(groups.error()).toBe(""); expect(infer).toHaveBeenCalledTimes(3);
  const last = infer.mock.calls[2][0];
  expect(last.files).toHaveLength(2);
  expect(last.files.every(file => file.status === "summary" && file.patchLines === 0 && file.sampled)).toBe(true);
  expect(last.files[0].patch).not.toContain("999.ts");
  expect(groups.value()).toHaveLength(1); expect(groups.value()![0].paths).toHaveLength(1001);
  expect(groups.notice()).toContain("Globally reconciled");
});
it("does not publish partial results when global reconciliation fails", async () => {
  const infer = vi.fn(async (request: GroupRequest) => {
    if (request.files[0].status === "summary") throw new Error("Provider unavailable");
    return merged(request);
  });
  const groups = createReviewGroups(infer);
  await groups.run(async () => oversized()); flush();
  expect(infer).toHaveBeenCalledTimes(3); expect(groups.value()).toBeUndefined();
  expect(groups.mode()).toBe("folders"); expect(groups.error()).toBe("Provider unavailable");
});
it("cancels global reconciliation without publishing partial results", async () => {
  let finish!: (result: unknown) => void;
  const infer = vi.fn(async (request: GroupRequest) => request.files[0].status !== "summary" ? merged(request) : new Promise<unknown>(resolve => { finish = resolve; }));
  const groups = createReviewGroups(infer), run = groups.run(async () => oversized());
  await waitFor(() => expect(infer).toHaveBeenCalledTimes(3));
  groups.cancel(); finish({ groups: [] }); await run; flush();
  expect(groups.value()).toBeUndefined(); expect(groups.busy()).toBe(false);
});
it("renews the deadline for each inference unit", async () => {
  vi.useFakeTimers();
  try {
    const groups = createReviewGroups(async (request, signal) => {
      await vi.advanceTimersByTimeAsync(60000);
      expect(signal.aborted).toBe(false); return merged(request);
    });
    await groups.run(async () => oversized()); flush();
    expect(groups.error()).toBe(""); expect(groups.coverage()?.files).toBe(1001);
  } finally { vi.useRealTimers(); }
});

it("samples later hunks and supplies requested excerpts from the captured patch", async () => {
  const patch = Array.from({ length: 12 }, (_, i) => `@@ -${i * 20 + 1},1 +${i * 20 + 1},1 @@\n-old${i}\n+new${i}\n`).join("");
  const original = [{ ...files[0], patch }];
  const infer = vi.fn(async (_request: GroupRequest) => infer.mock.calls.length === 1
    ? { readDiffs: [{ path: "a.ts", startLine: 31 }] }
    : { groups: [{ title: "Behavior", reason: "Related edits", paths: ["a.ts"] }] });
  const groups = createReviewGroups(infer);
  await groups.run(async () => original); flush();
  const first = infer.mock.calls[0][0], second = infer.mock.calls[1][0];
  expect(first.files[0]).toMatchObject({ status: "modified", added: 12, removed: 12, patchLines: 36 });
  expect(first.files[0].patch).toContain("new11");
  expect(first.details).toEqual([]);
  expect(second.details).toEqual([{ path: "a.ts", startLine: 31, patch: patch.split("\n").slice(30).join("\n") }]);
  expect(groups.value()?.[0].title).toBe("Behavior");
  expect(groups.coverage()?.reads).toBe(1);
});
it.each([
  { readDiffs: [{ path: "outside", startLine: 1 }] },
  { readDiffs: [{ path: "a.ts", startLine: 0 }] },
  { readDiffs: [{ path: "a.ts", startLine: 2 }] },
  { readDiffs: [{ path: "a.ts", startLine: 1.5 }] },
  { readDiffs: [{ path: "a.ts", startLine: 1 }, { path: "a.ts", startLine: 1 }] },
  { readDiffs: [] },
  { readDiffs: [{ path: "a.ts", startLine: 1 }], groups: [] },
])("rejects invalid diff requests without another model call: %j", async response => {
  const infer = vi.fn(async () => response), groups = createReviewGroups(infer);
  await groups.run(async () => files); flush();
  expect(infer).toHaveBeenCalledTimes(1); expect(groups.value()).toBeUndefined();
  expect(groups.error()).toBeTruthy(); expect(groups.mode()).toBe("folders");
});
it("bounds retrieval rounds and rejects repeated excerpts", async () => {
  const infer = vi.fn(async () => ({ readDiffs: [{ path: "a.ts", startLine: infer.mock.calls.length }] }));
  const groups = createReviewGroups(infer);
  await groups.run(async () => [{ ...files[0], patch: "+a\n+b\n+c\n+d" }]); flush();
  expect(infer).toHaveBeenCalledTimes(3); expect(groups.value()).toBeUndefined();
  expect(groups.error()).toContain("limit");
  const repeat = vi.fn(async () => ({ readDiffs: [{ path: "a.ts", startLine: 1 }] }));
  const repeated = createReviewGroups(repeat);
  await repeated.run(async () => files); flush();
  expect(repeat).toHaveBeenCalledTimes(2); expect(repeated.error()).toBeTruthy();
});
it("drops a late retrieval reply after cancellation", async () => {
  let finish!: (value: unknown) => void;
  const infer = vi.fn(() => new Promise<unknown>(resolve => { finish = resolve; }));
  const groups = createReviewGroups(infer), run = groups.run(async () => files);
  await waitFor(() => expect(infer).toHaveBeenCalledOnce()); groups.cancel();
  finish({ readDiffs: [{ path: "a.ts", startLine: 1 }] }); await run; flush();
  expect(infer).toHaveBeenCalledTimes(1); expect(groups.value()).toBeUndefined(); expect(groups.busy()).toBe(false);
});
it("requires a capability and reports bounded server errors", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "Reopen the conversation to use AI grouping." }), { status: 422 }));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await expect(fetchReviewGroups("a/b", request, signal, null)).rejects.toThrow("Authentication");
  expect(fetch).not.toHaveBeenCalled();
  await expect(fetchReviewGroups("a/b", request, signal, "cap")).rejects.toThrow("Reopen the conversation");
  expect(fetch).toHaveBeenCalledWith("/review/a%2Fb/groups", expect.objectContaining({ method: "POST", redirect: "error", credentials: "omit" }));
});
it("invalidates suggestions when an analyzed patch fingerprint changes", async () => {
  const groups = createReviewGroups(async () => ({ groups: [{ title: "Feature", reason: "", paths: ["a.ts"] }] }));
  await groups.run(async () => files); flush();
  groups.observe("a.ts", "a"); flush(); expect(groups.value()).toBeTruthy();
  groups.observe("a.ts", "changed"); flush(); expect(groups.value()).toBeTruthy(); expect(groups.stale()).toBe(true);
});
it("rejects invented or duplicated paths and retains omitted files as ungrouped", () => {
  expect(normalizeGroups({ groups: [{ title: "Feature", reason: "Shared change", paths: ["a.ts"] }] }, files)).toEqual([
    { title: "Feature", reason: "Shared change", paths: ["a.ts"] }, { title: "Ungrouped", reason: "Not assigned by the model.", paths: ["b.ts"] },
  ]);
  for (const paths of [["outside.ts"], ["a.ts", "a.ts"]]) expect(() => normalizeGroups({ groups: [{ title: "Feature", reason: "", paths }] }, files)).toThrow();
});
it("runs only explicitly, preserves folders on failure, and ignores cancelled responses", async () => {
  let finish!: (value: unknown) => void;
  const infer = vi.fn(() => new Promise<unknown>(resolve => { finish = resolve; }));
  const groups = createReviewGroups(infer);
  expect(infer).not.toHaveBeenCalled();
  const running = groups.run(async () => files); flush();
  await waitFor(() => expect(infer).toHaveBeenCalledOnce());
  groups.reset(); finish({ groups: [{ title: "Late", reason: "", paths: ["a.ts"] }] }); await running; flush();
  expect(groups.value()).toBeUndefined(); expect(groups.mode()).toBe("folders");
  const failed = createReviewGroups(async () => { throw new Error("Provider unavailable"); });
  await failed.run(async () => files); flush();
  expect(failed.error()).toBe("Provider unavailable"); expect(failed.mode()).toBe("folders");
});
it("rejects fingerprint changes observed while a selected model read is loading", async () => {
  let finish!: (file: GroupInput) => void;
  const infer = vi.fn(async () => ({ readDiffs: [{ path: "a.ts", startLine: 1 }] }));
  const groups = createReviewGroups(infer);
  const running = groups.run(async () => [{ ...files[0], patch: null, fingerprint: null, uncaptured: true }], () => new Promise(resolve => { finish = resolve; }));
  await waitFor(() => expect(finish).toBeTruthy());
  groups.observe("a.ts", "changed"); finish(files[0]); await running; flush();
  expect(infer).toHaveBeenCalledTimes(1); expect(groups.value()).toBeUndefined(); expect(groups.error()).toContain("changed");
});
it("captures only selected model reads without changing UI selection or cache", async () => {
  const entries = Array.from({ length: 25 }, (_, i) => ({ path: `${i}.ts`, previousPath: null, status: "modified", patch: null, fingerprint: null }));
  const load = vi.fn(async (request: { path?: string }) => ({ files: request.path ? [{ ...entries.find(file => file.path === request.path)!, patch: "+x", fingerprint: request.path }] : entries, truncated: false, note: null }));
  const infer = vi.fn(async (_request: GroupRequest) => infer.mock.calls.length === 1 ? { readDiffs: [{ path: "24.ts", startLine: 1 }] } : { groups: [] });
  const review = createLocalReview(load, undefined, undefined, undefined, infer);
  await review.refresh(); flush(); expect(load).toHaveBeenCalledTimes(2);
  await review.groupWithAI(); flush();
  expect(load).toHaveBeenCalledTimes(3); expect(infer).toHaveBeenCalledTimes(2);
  expect(infer.mock.calls[0][0].files[24]).toMatchObject({ patch: null, patchLines: null, sampled: true, added: 0, removed: 0 });
  expect(infer.mock.calls[1][0].details).toEqual([{ path: "24.ts", startLine: 1, patch: "+x" }]);
  expect(review.snapshot()?.files.filter(file => file.patch !== null)).toHaveLength(1);
  expect(review.selected()).toBe("0.ts"); expect(review.grouping.value()?.[0].paths).toHaveLength(25);
  await review.refresh(); flush(); expect(review.grouping.value()?.[0].paths).toHaveLength(25);
  expect(review.grouping.stale()).toBe(true); expect(infer).toHaveBeenCalledTimes(2);
});
it.each([
  ["untracked", "Untracked content omitted; file has not been read.\n"],
  ["modified", "Binary content omitted.\n"],
  ["modified", "Non-UTF-8 patch omitted.\n"],
  ["modified", "Patch exceeds 64 KiB; content omitted.\n"],
])("reports omitted %s content as unavailable: %s", async (status, patch) => {
  const entry = { path: "omitted.ts", previousPath: null, status, patch, fingerprint: "omitted" };
  const infer = vi.fn(async (_request: GroupRequest) => ({ groups: [] }));
  const review = createLocalReview(async () => ({ files: [entry], truncated: true, note: "Content omitted" }), undefined, undefined, undefined, infer);
  await review.refresh(); await review.groupWithAI(); flush();
  expect(infer.mock.calls[0][0].files[0]).toMatchObject({ path: "omitted.ts", status, patch: null, patchLines: 0 });
  expect(review.grouping.coverage()?.unavailable).toBe(1);
  expect(review.grouping.value()?.[0].paths).toEqual(["omitted.ts"]);
  expect(review.snapshot()?.files[0].patch).toBe(patch);
});
it("rejects additional reads of unavailable patches", async () => {
  const infer = vi.fn(async () => ({ readDiffs: [{ path: "a.ts", startLine: 1 }] }));
  const groups = createReviewGroups(infer);
  await groups.run(async () => [{ ...files[0], patch: null }]); flush();
  expect(infer).toHaveBeenCalledTimes(1);
  expect(groups.error()).toContain("out-of-range");
});
it("bounds snippets without splitting Unicode and exposes partial coverage", async () => {
  const infer = vi.fn(async (_request: GroupRequest) => ({ groups: [{ title: "Feature", reason: "", paths: ["a.ts"] }] }));
  const groups = createReviewGroups(infer);
  await groups.run(async () => [{ ...files[0], patch: "界".repeat(5000) }, ...Array.from({ length: 25 }, (_, i) => ({ path: `${i}.ts`, status: "modified", patch: "+x", fingerprint: `${i}` }))]); flush();
  const input = infer.mock.calls[0][0];
  expect(input.files.filter(file => file.patch !== null)).toHaveLength(26);
  expect(new TextEncoder().encode(input.files[0].patch!).length).toBeLessThanOrEqual(8192);
  expect(input.files[0].patch).not.toContain("�");
  expect(groups.notice()).toContain("sampled"); expect(groups.mode()).toBe("intent");
});

it.each([{ paths: ["group/invented"] }, { paths: ["group/0-0", "group/0-0"] }])("rejects unknown or duplicate reconciliation IDs: %j", async ({ paths }) => {
  const infer = vi.fn(async (request: GroupRequest) => request.files[0].status === "summary"
    ? { groups: [{ title: "Invalid", reason: "", paths }] } : merged(request));
  const groups = createReviewGroups(infer);
  await groups.run(async () => oversized()); flush();
  expect(groups.error()).toContain("unknown or repeated"); expect(groups.value()).toBeUndefined();
});
it("preserves omissions at both partition and reconciliation levels as visibly Ungrouped", async () => {
  const infer = vi.fn(async (request: GroupRequest) => ({ groups: [{ title: "Feature", reason: "", paths: request.files.slice(0, request.files[0].status === "summary" ? 1 : 2).map(file => file.path) }] }));
  const groups = createReviewGroups(infer);
  await groups.run(async () => oversized()); flush();
  expect(groups.error()).toBe("");
  expect(groups.value()![0].paths).toEqual(["0.ts", "1.ts"]);
  expect(groups.value()![1].title).toBe("Ungrouped"); expect(groups.value()![1].paths).toHaveLength(999);
  expect(new Set(groups.value()!.flatMap(group => group.paths)).size).toBe(1001);
});
it("caps final output at 20 groups while retaining all omitted files", async () => {
  const entries = Array.from({ length: 21 }, (_, i) => ({ ...files[0], path: `${i}.ts` }));
  const groups = createReviewGroups(async () => ({ groups: entries.slice(0, 20).map(file => ({ title: file.path, reason: "", paths: [file.path] })) }));
  await groups.run(async () => entries); flush();
  expect(groups.value()).toHaveLength(20);
  expect(groups.value()![19]).toMatchObject({ title: "Ungrouped", paths: ["19.ts", "20.ts"] });
});
it("partitions long escaped names by JSON bytes then globally merges bounded summaries", async () => {
  const entries = Array.from({ length: 300 }, (_, i) => ({ path: `${i}/${'界"'.repeat(240)}`, status: "modified", patch: null, uncaptured: true }));
  const infer = vi.fn(async (request: GroupRequest) => {
    expect(new TextEncoder().encode(JSON.stringify(request)).length).toBeLessThanOrEqual(192 * 1024);
    expect(request.files.length).toBeLessThanOrEqual(1000);
    return merged(request);
  });
  const groups = createReviewGroups(infer);
  await groups.run(async () => entries); flush();
  expect(groups.error()).toBe(""); expect(infer.mock.calls.length).toBeGreaterThan(2);
  expect(infer.mock.calls.at(-1)![0].files.every(file => file.status === "summary")).toBe(true);
  expect(groups.value()).toHaveLength(1); expect(groups.value()![0].paths).toEqual(entries.map(file => file.path));
});
it("bounds actual JSON bytes for heavily escaped requested detail", async () => {
  const entries = Array.from({ length: 900 }, (_, i) => ({ path: `${i}.ts`, status: "modified", patch: null, uncaptured: true }));
  const infer = vi.fn(async (request: GroupRequest) => {
    expect(new TextEncoder().encode(JSON.stringify(request)).length).toBeLessThanOrEqual(192 * 1024);
    const snippets = [...request.files.map(file => file.patch ?? ""), ...request.details.map(detail => detail.patch)].join("");
    expect(new TextEncoder().encode(snippets).length).toBeLessThanOrEqual(48 * 1024);
    return infer.mock.calls.length < 3 ? { readDiffs: entries.slice((infer.mock.calls.length - 1) * 4, infer.mock.calls.length * 4).map(file => ({ path: file.path, startLine: 1 })) } : merged(request);
  });
  const read = vi.fn(async (path: string) => ({ path, status: "modified", patch: "\u0001".repeat(65536), fingerprint: path }));
  const groups = createReviewGroups(infer);
  await groups.run(async () => entries, read); flush();
  expect(groups.error()).toBe(""); expect(read).toHaveBeenCalledTimes(8); expect(infer).toHaveBeenCalledTimes(3);
});
it.each([null, ""])("keeps newly unavailable content visible without fabricated excerpts: %j", async patch => {
  const infer = vi.fn(async (_request: GroupRequest) => infer.mock.calls.length === 1 ? { readDiffs: [{ path: "a.ts", startLine: 1 }] } : { groups: [] });
  const groups = createReviewGroups(infer);
  await groups.run(async () => [{ ...files[0], patch: null, uncaptured: true }], async () => ({ ...files[0], patch })); flush();
  expect(groups.error()).toBe(""); expect(infer.mock.calls[1][0].details).toEqual([]);
  expect(groups.value()![0].paths).toEqual(["a.ts"]);
  expect(infer.mock.calls[1][0].files[0].patchLines).toBe(0);
});
it("allows only line one for uncaptured diffs without invoking the reader", async () => {
  const read = vi.fn(async () => files[0]);
  const groups = createReviewGroups(async () => ({ readDiffs: [{ path: "a.ts", startLine: 2 }] }));
  await groups.run(async () => [{ ...files[0], patch: null, uncaptured: true }], read); flush();
  expect(read).not.toHaveBeenCalled(); expect(groups.error()).toContain("out-of-range");
});
it("does not mutate cached inputs when refreshing lazy metadata", async () => {
  const entry = { ...files[0], patch: null, fingerprint: null, uncaptured: true };
  const infer = vi.fn(async () => infer.mock.calls.length === 1 ? { readDiffs: [{ path: "a.ts", startLine: 1 }] } : { groups: [] });
  const groups = createReviewGroups(infer);
  await groups.run(async () => [entry], async () => files[0]); flush();
  expect(entry).toMatchObject({ patch: null, fingerprint: null, uncaptured: true });
  groups.observe("a.ts", "changed"); flush(); expect(groups.value()).toBeTruthy(); expect(groups.stale()).toBe(true);
});
it("recursively reconciles summaries when their metadata still exceeds one request", async () => {
  const entries = Array.from({ length: 7000 }, (_, i) => ({ path: `${i}/${"x".repeat(950)}`, status: "modified", patch: null, uncaptured: true }));
  const infer = vi.fn(async (request: GroupRequest) => request.files[0].status === "summary" ? merged(request)
    : { groups: request.files.slice(0, 20).map(file => ({ title: "Feature", reason: "", paths: [file.path] })) });
  const groups = createReviewGroups(infer);
  groups.setOptions({ ...groups.options(), maxCalls: 100, maxRequestBytes: 16 * 1024 * 1024 }); flush();
  await groups.run(async () => entries); flush();
  expect(groups.error()).toBe("");
  const summaryCalls = infer.mock.calls.filter(([request]) => request.files[0].status === "summary");
  expect(summaryCalls.length).toBeGreaterThan(2);
  expect(summaryCalls.at(-1)![0].files.every(file => file.path.startsWith("group/1-"))).toBe(true);
  const paths = groups.value()!.flatMap(group => group.paths);
  expect(paths).toHaveLength(7000); expect(new Set(paths).size).toBe(7000);
});
it("cancels an on-demand capture and ignores its late result", async () => {
  let finish!: (file: GroupInput) => void;
  const infer = vi.fn(async () => ({ readDiffs: [{ path: "a.ts", startLine: 1 }] }));
  const groups = createReviewGroups(infer);
  const read = vi.fn((_path: string, signal: AbortSignal) => new Promise<GroupInput>(resolve => { expect(signal.aborted).toBe(false); finish = resolve; }));
  const running = groups.run(async () => [{ ...files[0], patch: null, uncaptured: true }], read);
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  groups.cancel(); expect(read.mock.calls[0][1].aborted).toBe(true);
  finish(files[0]); await running; flush();
  expect(infer).toHaveBeenCalledOnce(); expect(groups.value()).toBeUndefined(); expect(groups.details()).toEqual([]);
});
it("rejects more than four reads in a round before capturing anything", async () => {
  const entries = oversized().slice(0, 5), read = vi.fn(async () => files[0]);
  const groups = createReviewGroups(async () => ({ readDiffs: entries.map(file => ({ path: file.path, startLine: 1 })) }));
  await groups.run(async () => entries, read); flush();
  expect(read).not.toHaveBeenCalled(); expect(groups.error()).toBe("Invalid AI diff request.");
});
it("rejects manifests exceeding the admitted 10000-file bound", async () => {
  const infer = vi.fn(async () => ({ groups: [] })), groups = createReviewGroups(infer);
  await groups.run(async () => Array.from({ length: 10001 }, (_, i) => ({ ...files[0], path: `${i}.ts` }))); flush();
  expect(infer).not.toHaveBeenCalled(); expect(groups.error()).toContain("10,000");
});
it("expires one inference unit after 90 seconds without publishing", async () => {
  vi.useFakeTimers();
  try {
    const groups = createReviewGroups(async () => {
      await vi.advanceTimersByTimeAsync(90001); return { groups: [] };
    });
    await groups.run(async () => files); flush();
    expect(groups.error()).toContain("timed out"); expect(groups.value()).toBeUndefined(); expect(groups.busy()).toBe(false);
  } finally { vi.useRealTimers(); }
});
it("rejects serialized request overflow before sending a network request", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(fetchReviewGroups("id", { ...request, details: [{ path: "a.ts", startLine: 1, patch: "\u0001".repeat(40000) }] }, new AbortController().signal, "cap")).rejects.toThrow("request limit");
  expect(fetch).not.toHaveBeenCalled();
});
