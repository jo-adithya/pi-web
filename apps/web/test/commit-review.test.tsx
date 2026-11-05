import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { LocalReview } from "../src/LocalReview";
import { createSessionModel } from "../src/session-model";
import { createCommitHistory, fetchCommits } from "../src/commit-review";
import { createLocalReview } from "../src/local-review";

const latest = "a".repeat(40), older = "b".repeat(40);
const history = { commits: [{ id: latest, subject: "Latest change" }, { id: older, subject: "<script>Older change</script>" }], truncated: false };
const snapshot = { files: [{ path: "main.ts", previousPath: null, status: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n", fingerprint: "file" }], truncated: false, note: null };
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); vi.spyOn(window, "scrollTo").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("loads commits only on demand and pins selection and unsent review context to a full commit ID", async () => {
  const request = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/commits") ? history : snapshot)));
  vi.stubGlobal("fetch", request);
  const transport = vi.fn(() => true);
  const model = createSessionModel("s", transport, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("article", { name: "Diff for main.ts" });
  expect(request.mock.calls.some(([url]) => url.endsWith("/commits"))).toBe(false);
  fireEvent.click(page.getByRole("button", { name: "Commit" }));
  const picker = await page.findByRole("combobox", { name: "Commit" });
  await waitFor(() => { flush(); expect(model.review.target()).toEqual({ scope: "commit", commit: latest }); });
  expect((picker as HTMLSelectElement).value).toBe(latest);
  fireEvent.change(picker, { target: { value: older } });
  await waitFor(() => { flush(); expect(model.review.target()).toEqual({ scope: "commit", commit: older }); });
  expect(page.container.querySelector("script")).toBeNull();
  fireEvent.click(await page.findByRole("button", { name: "Ask Pi" })); flush();
  expect(model.draft()).toContain(older); expect(model.draft()).toContain("first parent");
  expect(transport).not.toHaveBeenCalled();
});

it("shows empty history and can reload commits without changing the workspace", async () => {
  let populated = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/commits") ? populated ? history : { commits: [], truncated: false } : snapshot))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("article"); fireEvent.click(page.getByRole("button", { name: "Commit" }));
  await page.findByText(/No commits in local HEAD history/);
  populated = true; fireEvent.click(page.getByRole("button", { name: "Reload commits" }));
  await waitFor(() => { flush(); expect(model.review.target()).toEqual({ scope: "commit", commit: latest }); });
  expect((page.getByRole("combobox", { name: "Commit" }) as HTMLSelectElement).value).toBe(latest);
});

it("shows actionable history errors and retries without hiding the previous snapshot's scope", async () => {
  let failed = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/commits") && failed ? new Response(JSON.stringify({ error: "Local history unavailable" }), { status: 422 }) : new Response(JSON.stringify(url.endsWith("/commits") ? history : snapshot))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("article"); fireEvent.click(page.getByRole("button", { name: "Commit" }));
  expect((await page.findByRole("alert")).textContent).toBe("Local history unavailable");
  expect(page.getByText("Snapshot: unstaged")).toBeTruthy();
  failed = false; fireEvent.click(page.getByRole("button", { name: "Reload commits" }));
  await waitFor(() => { flush(); expect(model.review.target()?.commit).toBe(latest); });
});

it("fetches bounded authenticated history and rejects malformed commit identities and metadata", async () => {
  const request = vi.fn(async () => new Response(JSON.stringify(history))); vi.stubGlobal("fetch", request);
  const signal = new AbortController().signal;
  expect(await fetchCommits("session", signal, "cap")).toEqual(history);
  expect(request).toHaveBeenCalledWith("/review/session/commits", expect.objectContaining({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store", body: "{}", headers: { "content-type": "application/json", "x-pi-capability": "cap" } }));
  await expect(fetchCommits("s", signal, null)).rejects.toThrow("Authentication required");
  for (const malformed of [
    { ...history, truncated: "yes" }, { ...history, commits: Array(101).fill(history.commits[0]) },
    { ...history, commits: [history.commits[0], history.commits[0]] },
    ...["HEAD", "a".repeat(39), "A".repeat(40), "https://example.com", [latest]].map(id => ({ ...history, commits: [{ id, subject: "test" }] })),
    ...[null, "x".repeat(513), "line\nbreak", "\0"].map(subject => ({ ...history, commits: [{ id: latest, subject }] })),
  ]) {
    request.mockImplementationOnce(async () => new Response(JSON.stringify(malformed)));
    await expect(fetchCommits("s", signal, "cap")).rejects.toThrow("Invalid commit history");
  }
  request.mockImplementationOnce(async () => new Response("x".repeat(256 * 1024 + 1)));
  await expect(fetchCommits("s", signal, "cap")).rejects.toThrow("exceeds its limit");
  request.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "Local commit is unavailable" }), { status: 422 }));
  await expect(fetchCommits("s", signal, "cap")).rejects.toThrow("Local commit is unavailable");
});

it("keeps history on failure and ignores replies after cancellation", async () => {
  const load = vi.fn(async (_signal: AbortSignal) => history);
  const model = createCommitHistory(load);
  await model.refresh(); flush();
  load.mockRejectedValueOnce(new Error("Retry history")); await model.refresh(); flush();
  expect(model.value()).toEqual(history); expect(model.error()).toBe("Retry history");
  let reply!: (value: typeof history) => void;
  load.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  const pending = model.refresh(); model.cancel(); reply({ commits: [], truncated: false }); await pending; flush();
  expect(load.mock.calls.at(-1)![0].aborted).toBe(true); expect(model.value()).toEqual(history); expect(model.busy()).toBe(false);
});

it("does not load a commit snapshot when history is empty or the scope changed while history loaded", async () => {
  const load = vi.fn(async () => snapshot);
  const historyLoad = vi.fn(async (_signal: AbortSignal) => ({ commits: [], truncated: false } as typeof history));
  const model = createLocalReview(load, undefined, undefined, historyLoad);
  await model.refresh("commit"); flush(); expect(load).not.toHaveBeenCalled(); expect(model.snapshot()).toBeUndefined();
  const second = createLocalReview(load, undefined, undefined, historyLoad);
  let reply!: (value: typeof history) => void;
  historyLoad.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  const pending = second.refresh("commit"); await second.refresh("staged");
  reply(history); await pending; flush();
  expect(second.target()).toEqual({ scope: "staged" }); expect(load).toHaveBeenCalledTimes(1);
  expect(historyLoad.mock.calls.at(-1)![0].aborted).toBe(true);
});

it("keeps the selected commit pinned when the recent history changes", async () => {
  const load = vi.fn(async () => snapshot), historyLoad = vi.fn(async () => history);
  const model = createLocalReview(load, undefined, undefined, historyLoad);
  await model.refresh("commit"); flush();
  historyLoad.mockResolvedValueOnce({ commits: [{ id: older, subject: "New HEAD" }], truncated: false });
  await model.history.refresh(); flush(); await model.refresh("commit"); flush();
  expect(model.target()).toEqual({ scope: "commit", commit: latest });
  expect(load.mock.calls).toHaveLength(2);
});

it("keeps the picker and snapshot pinned when reload omits the selected commit", async () => {
  let current = history;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/commits") ? current : snapshot))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("article"); fireEvent.click(page.getByRole("button", { name: "Commit" }));
  await waitFor(() => { flush(); expect(model.review.target()?.commit).toBe(latest); expect(model.review.busy()).toBe(false); });
  current = { commits: [{ id: older, subject: "New HEAD" }], truncated: false };
  fireEvent.click(page.getByRole("button", { name: "Reload commits" }));
  await page.findByRole("option", { name: /New HEAD/ });
  expect((page.getByRole("combobox", { name: "Commit" }) as HTMLSelectElement).value).toBe(latest);
  expect(model.review.target()).toEqual({ scope: "commit", commit: latest });
  fireEvent.click(page.getByRole("button", { name: "Refresh" }));
  await waitFor(() => { flush(); expect(model.review.busy()).toBe(false); });
  expect(model.review.target()).toEqual({ scope: "commit", commit: latest });
});

it("carries commit identity to context and structural requests", async () => {
  const selected = { ...snapshot, files: [{ ...snapshot.files[0], patch: "@@ -25 +25 @@\n-old\n+new\n" }] };
  const request = vi.fn(async (url: string, init: RequestInit) => new Response(JSON.stringify(url.endsWith("/commits") ? history : url.endsWith("/structural") ? { mode: "text", reason: "Not installed" } : url.endsWith("/context") ? { oldStart: 5, newStart: 5, lines: ["context"], hasMore: false, noNewline: false } : selected)));
  vi.stubGlobal("fetch", request);
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("article"); fireEvent.click(page.getByRole("button", { name: "Commit" }));
  await waitFor(() => { flush(); expect(model.review.target()?.commit).toBe(latest); expect(model.review.busy()).toBe(false); });
  fireEvent.click(await page.findByRole("button", { name: "Expand 20 lines above" }));
  await waitFor(() => expect(request.mock.calls.some(([url]) => url.endsWith("/context"))).toBe(true));
  fireEvent.click(page.getByRole("button", { name: "Structural" }));
  await waitFor(() => expect(request.mock.calls.some(([url]) => url.endsWith("/structural"))).toBe(true));
  for (const [url, init] of request.mock.calls.filter(([url]) => /\/(context|structural)$/.test(url))) {
    expect(JSON.parse(init.body as string), url).toMatchObject({ scope: "commit", commit: latest });
  }
});
