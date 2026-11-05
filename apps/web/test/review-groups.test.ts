import { afterEach, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { waitFor } from "@solidjs/testing-library";
import { createLocalReview } from "../src/local-review";
import { createReviewGroups, fetchReviewGroups, normalizeGroups, type GroupInput, type GroupRequest } from "../src/review-groups";

const files: GroupInput[] = [{ path: "a.ts", patch: "+a", fingerprint: "a" }, { path: "b.ts", patch: "+b", fingerprint: "b" }];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each([null, {}, { groups: "x" }, { groups: [{ title: "", reason: "", paths: ["a.ts"] }] }, { groups: [{ title: "X", reason: [], paths: ["a.ts"] }] }, { groups: [{ title: "X", reason: "", paths: [] }] }, { groups: [{ title: "X", reason: "", paths: ["a.ts"] }, { title: "Y", reason: "", paths: ["a.ts"] }] }])("rejects malformed grouping output %j", value => {
  expect(() => normalizeGroups(value, files)).toThrow();
});
it("requires a capability and reports bounded server errors", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "Reopen the conversation to use AI grouping." }), { status: 422 }));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await expect(fetchReviewGroups("a/b", { files }, signal, null)).rejects.toThrow("Authentication");
  expect(fetch).not.toHaveBeenCalled();
  await expect(fetchReviewGroups("a/b", { files }, signal, "cap")).rejects.toThrow("Reopen the conversation");
  expect(fetch).toHaveBeenCalledWith("/review/a%2Fb/groups", expect.objectContaining({ method: "POST", redirect: "error", credentials: "omit" }));
});
it("invalidates suggestions when an analyzed patch fingerprint changes", async () => {
  const groups = createReviewGroups(async () => ({ groups: [{ title: "Feature", reason: "", paths: ["a.ts"] }] }));
  await groups.run(async () => files); flush();
  groups.observe("a.ts", "a"); flush(); expect(groups.value()).toBeTruthy();
  groups.observe("a.ts", "changed"); flush(); expect(groups.value()).toBeUndefined();
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
  await Promise.resolve();
  groups.reset(); finish({ groups: [{ title: "Late", reason: "", paths: ["a.ts"] }] }); await running; flush();
  expect(groups.value()).toBeUndefined(); expect(groups.mode()).toBe("folders");
  const failed = createReviewGroups(async () => { throw new Error("Provider unavailable"); });
  await failed.run(async () => files); flush();
  expect(failed.error()).toBe("Provider unavailable"); expect(failed.mode()).toBe("folders");
});
it("rejects a fingerprint change observed while other snippets are still loading", async () => {
  const entries = ["a.ts", "b.ts", "c.ts"].map(path => ({ path, previousPath: null, status: "modified", patch: null, fingerprint: null }));
  let bReads = 0, finishC: ((value: { files: typeof loaded[]; truncated: boolean; note: null }) => void) | undefined;
  const loaded = { ...entries[2], patch: "+c", fingerprint: "c" };
  const load = async (request: { path?: string }) => {
    if (!request.path) return { files: entries, truncated: false, note: null };
    if (request.path === "c.ts") return new Promise<{ files: typeof loaded[]; truncated: boolean; note: null }>(resolve => { finishC = resolve; });
    return { files: [{ ...entries.find(file => file.path === request.path)!, patch: "+x", fingerprint: request.path === "b.ts" ? String(++bReads) : "a" }], truncated: false, note: null };
  };
  const infer = vi.fn(async () => ({ groups: [] }));
  const review = createLocalReview(load, undefined, undefined, undefined, infer);
  await review.refresh(); flush();
  const grouping = review.groupWithAI(); await waitFor(() => expect(finishC).toBeTruthy());
  review.setSelected("b.ts"); await waitFor(() => { flush(); expect(review.snapshot()?.files[1].fingerprint).toBe("2"); });
  finishC!({ files: [loaded], truncated: false, note: null }); await grouping; flush();
  expect(infer).not.toHaveBeenCalled(); expect(review.grouping.value()).toBeUndefined();
  expect(review.grouping.error()).toContain("changed");
});
it("loads at most twenty patches explicitly without changing the selected file", async () => {
  const entries = Array.from({ length: 25 }, (_, i) => ({ path: `${i}.ts`, previousPath: null, status: "modified", patch: null, fingerprint: null }));
  const load = vi.fn(async (request: { path?: string }) => ({ files: request.path ? [{ ...entries.find(file => file.path === request.path)!, patch: "+x", fingerprint: request.path }] : entries, truncated: false, note: null }));
  const infer = vi.fn(async () => ({ groups: [] }));
  const review = createLocalReview(load, undefined, undefined, undefined, infer);
  await review.refresh(); flush(); expect(load).toHaveBeenCalledTimes(2);
  await review.groupWithAI(); flush();
  expect(load).toHaveBeenCalledTimes(21); expect(infer).toHaveBeenCalledTimes(1);
  expect(review.selected()).toBe("0.ts"); expect(review.grouping.value()?.[0].paths).toHaveLength(25);
  await review.refresh(); flush(); expect(review.grouping.value()).toBeUndefined();
});
it("bounds snippets without splitting Unicode and exposes partial coverage", async () => {
  const infer = vi.fn(async (_request: GroupRequest) => ({ groups: [{ title: "Feature", reason: "", paths: ["a.ts"] }] }));
  const groups = createReviewGroups(infer);
  await groups.run(async () => [{ ...files[0], patch: "界".repeat(5000) }, ...Array.from({ length: 25 }, (_, i) => ({ path: `${i}.ts`, patch: "+x", fingerprint: `${i}` }))]); flush();
  const input = infer.mock.calls[0][0];
  expect(input.files.filter(file => file.patch !== null)).toHaveLength(20);
  expect(new TextEncoder().encode(input.files[0].patch!).length).toBeLessThanOrEqual(8192);
  expect(input.files[0].patch).not.toContain("�");
  expect(groups.notice()).toContain("partial"); expect(groups.mode()).toBe("intent");
});
