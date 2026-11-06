import { expect, it, vi } from "vitest";
import { createReviewExplanations, validateExplanation } from "../src/review-explanations";
import type { GroupRequest } from "../src/review-groups";
import type { ReviewFile } from "../src/local-review";
const file: ReviewFile = { path: "src/a.ts", previousPath: null, status: "modified", fingerprint: "a", patch: "@@ -1 +1 @@\n-old\n+new\n" };
const request: GroupRequest = { files: [{ path: file.path, status: "modified", patch: "", added: 0, removed: 0, patchLines: 3, sampled: true }], details: [{ path: file.path, startLine: 1, patch: file.patch }], readsRemaining: 0, explain: { title: "Feature" } };
const response = { explanation: { observations: [{ text: "Changes the return value.", citations: [{ path: file.path, startLine: 2, endLine: 3 }] }], inferences: [], risks: [], limitations: ["Only supplied diff context."] } };
const group = { title: "Feature", reason: "", paths: [file.path] };
const options = { maxCalls: 6, maxRequestBytes: 512 * 1024, includeGenerated: false };
function setup(load = vi.fn(async () => response)) {
  let current = file;
  const read = vi.fn(async () => current);
  const model = createReviewExplanations(load, read, () => ({ files: [current], target: { scope: "unstaged" }, options, model: { provider: "test", id: "small" } }));
  return { model, load, read, change: (value: ReviewFile) => { current = value; model.invalidate(); } };
}
it("accepts only evidence within supplied raw diff rows", () => {
  expect(validateExplanation(response, request)).toEqual(response.explanation);
  for (const citation of [{ path: "other", startLine: 2, endLine: 3 }, { path: file.path, startLine: 3, endLine: 4 }, { path: file.path, startLine: 0, endLine: 1 }, { path: file.path, startLine: 3, endLine: 2 }]) {
    expect(() => validateExplanation({ explanation: { ...response.explanation, observations: [{ text: "Claim", citations: [citation] }] } }, request)).toThrow();
  }
  expect(() => validateExplanation({ ...response, groups: [] }, request)).toThrow();
  expect(() => validateExplanation({ explanation: { ...response.explanation, observations: [{ text: "Uncited", citations: [] }] } }, request)).toThrow();
});
it("is opt-in, caches exact evidence and invalidates changed fingerprints", async () => {
  const { model, load, change } = setup();
  expect(load).not.toHaveBeenCalled();
  await model.explain(group);
  expect(load).toHaveBeenCalledTimes(1);
  expect(model.result(group)?.value).toEqual(response.explanation);
  await model.explain(group);
  expect(load).toHaveBeenCalledTimes(1);
  expect(model.result(group)?.usage.reused).toBe(true);
  change({ ...file, fingerprint: "b", patch: file.patch.replace("new", "newer") });
  expect(model.result(group)).toBeUndefined();
  await model.explain(group);
  expect(load).toHaveBeenCalledTimes(2);
});
it("bounds generated context and refuses requests over the configured budget", async () => {
  const load = vi.fn(async () => response), read = vi.fn(async () => file);
  const model = createReviewExplanations(load, read, () => ({ files: [file], target: { scope: "unstaged" }, options: { ...options, maxRequestBytes: 10 } }));
  await model.explain(group);
  expect(load).not.toHaveBeenCalled();
  expect(model.error()).toMatch(/budget/i);
});
it("omits generated bodies and caps explanation evidence at eight files", async () => {
  const files = ["package-lock.json", ...Array.from({ length: 10 }, (_, i) => `src/${i}.ts`)].map(path => ({ ...file, path }));
  let sent!: GroupRequest;
  const load = vi.fn(async (request: GroupRequest) => { sent = request; return { explanation: { ...response.explanation, observations: [{ text: "Change", citations: [{ path: "src/0.ts", startLine: 2, endLine: 3 }] }] } }; });
  const read = vi.fn(async (path: string) => files.find(file => file.path === path)!);
  const model = createReviewExplanations(load, read, () => ({ files, target: { scope: "unstaged" }, options }));
  const all = { ...group, paths: files.map(file => file.path) };
  await model.explain(all);
  expect(read).toHaveBeenCalledTimes(8);
  expect(sent.files).toHaveLength(11); expect(sent.details).toHaveLength(8);
  expect(sent.files[0].patch).toBeNull();
  expect(model.result(all)?.supplied).toBe(8);
});
it("rejects moved snapshot evidence, including cached results", async () => {
  let stable = true;
  const load = vi.fn(async () => response);
  const model = createReviewExplanations(load, async () => file, () => ({ files: [file], target: { scope: "unstaged" }, options, snapshotKey: "a".repeat(64) }), async () => stable);
  await model.explain(group);
  expect(load).toHaveBeenCalledOnce();
  model.invalidate(); stable = false;
  await model.explain(group);
  expect(load).toHaveBeenCalledOnce();
  expect(model.result(group)).toBeUndefined();
  expect(model.error()).toMatch(/Changes moved/);
});
it("does not publish a result when the snapshot changes during inference", async () => {
  let verified = 0;
  const model = createReviewExplanations(async () => response, async () => file, () => ({ files: [file], target: { scope: "unstaged" }, options }), async () => ++verified === 1);
  await model.explain(group);
  expect(model.result(group)).toBeUndefined();
  expect(model.error()).toMatch(/during explanation/);
});
it("ignores cancelled late results and never caches them", async () => {
  let resolve!: (value: typeof response) => void;
  const load = vi.fn(() => new Promise<typeof response>(done => { resolve = done; }));
  const { model } = setup(load);
  const pending = model.explain(group);
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  model.cancel(); resolve(response); await pending;
  expect(model.result(group)).toBeUndefined();
  expect(model.busy()).toBe("");
});
