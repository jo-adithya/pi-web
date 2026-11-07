import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { LocalReview } from "../src/LocalReview";
import { createSessionModel } from "../src/session-model";
import { createBranchList, fetchBranches, type BranchList } from "../src/branch-review";

const branches = { branches: [{ ref: "refs/heads/main", name: "main", kind: "local" }, { ref: "refs/remotes/origin/main", name: "origin/main", kind: "remote" }], truncated: false };
/** Exercise the touch click path used by Kobalte's select trigger. */
function openPicker(trigger: HTMLElement) {
  fireEvent(trigger, Object.assign(new Event("pointerdown", { bubbles: true }), { pointerType: "touch", button: 0 }));
  fireEvent.click(trigger); flush();
}
const snapshot = { files: [{ path: "main.ts", previousPath: null, status: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n", fingerprint: "file" }], truncated: false, note: null };
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); vi.spyOn(window, "scrollTo").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("compares a picked branch immediately without offering manual entry", async () => {
  const request = vi.fn(async (url: string, _init: RequestInit) => new Response(JSON.stringify(url.endsWith("/branches") ? branches : snapshot)));
  vi.stubGlobal("fetch", request);
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("article");
  expect(request.mock.calls.some(([url]) => url.endsWith("/branches"))).toBe(false);
  fireEvent.click(page.getByRole("button", { name: "Branch" }));
  const picker = await page.findByRole("button", { name: /^Compare against/ });
  await waitFor(() => { flush(); expect(model.review.branches.busy()).toBe(false); });
  openPicker(picker);
  await screen.findByRole("option", { name: "origin/main · Remote (stored locally)" });
  expect(page.queryByRole("alert")).toBeNull();
  expect((page.getByRole("button", { name: "Compare" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("option", { name: "origin/main · Remote (stored locally)" })); flush();
  expect(picker.textContent).toContain("origin/main");
  await waitFor(() => { flush(); expect(model.review.target()).toEqual({ scope: "branch", base: "refs/remotes/origin/main" }); expect(model.review.busy()).toBe(false); });
  expect(request.mock.calls.filter(([url]) => !url.endsWith("/branches"))).toHaveLength(2);
  expect(page.container.querySelector(".review-base .field-label")).toBeNull();
  expect(page.queryByText(/Committed changes since divergence; excludes uncommitted edits/)).toBeNull();
  expect(page.queryByText(/may be stale/)).toBeNull();
  openPicker(picker);
  expect(screen.queryByRole("option", { name: "Enter a branch or tag…" })).toBeNull();
  expect(page.queryByRole("textbox", { name: "Branch, tag, or full ref" })).toBeNull();
});

it("does not reload changes or cancel a pending search while typing with a selected base", async () => {
  let reply!: (value: Response) => void;
  const request = vi.fn(async (url: string, init: RequestInit) => {
    if (!url.endsWith("/branches")) return new Response(JSON.stringify(snapshot));
    const query = JSON.parse(init.body as string).query;
    return query ? new Promise<Response>(resolve => { reply = resolve; }) : new Response(JSON.stringify(branches));
  });
  vi.stubGlobal("fetch", request);
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  model.review.setScope("branch"); model.review.setBase("refs/heads/main");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("article");
  await waitFor(() => { flush(); expect(model.review.branches.busy()).toBe(false); });
  const before = request.mock.calls.filter(([url]) => !url.endsWith("/branches")).length;
  openPicker(page.getByRole("button", { name: /^Compare against/ }));
  fireEvent.input(await screen.findByRole("searchbox", { name: "Find a branch" }), { target: { value: "main" } }); flush();
  expect(request.mock.calls.filter(([url]) => !url.endsWith("/branches"))).toHaveLength(before);
  const searchRequest = request.mock.calls.find(([url, init]) => url.endsWith("/branches") && JSON.parse(init.body as string).query === "main");
  expect(searchRequest).toBeTruthy();
  expect(searchRequest![1].signal!.aborted).toBe(false);
  expect(screen.getByRole("option", { name: "main · Local" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "origin/main · Remote (stored locally)" })).toBeTruthy();
  expect(page.getByRole("article")).toBeTruthy();
  expect(model.review.busy()).toBe(false);
  reply(new Response(JSON.stringify(branches)));
  await screen.findByRole("option", { name: "origin/main · Remote (stored locally)" });
  expect(request.mock.calls.filter(([url]) => !url.endsWith("/branches"))).toHaveLength(before);
});

it("searches beyond the initial branch limit and compares only when a branch is picked", async () => {
  const initial = { branches: Array.from({ length: 100 }, (_, i) => ({ ref: `refs/heads/feature-${i}`, name: `feature-${i}`, kind: "local" })), truncated: true };
  const request = vi.fn(async (url: string, init: RequestInit) => {
    if (!url.endsWith("/branches")) return new Response(JSON.stringify(snapshot));
    const query = (JSON.parse(init.body as string).query ?? "").trim().toLowerCase();
    return new Response(JSON.stringify(!query ? initial : { branches: query === "origin/main" ? [branches.branches[1]] : [], truncated: false }));
  });
  vi.stubGlobal("fetch", request);
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("article"); fireEvent.click(page.getByRole("button", { name: "Branch" }));
  await waitFor(() => { flush(); expect(model.review.branches.busy()).toBe(false); });
  const picker = page.getByRole("button", { name: /^Compare against/ });
  openPicker(picker);
  const search = await screen.findByRole("searchbox", { name: "Find a branch" });
  fireEvent.input(search, { target: { value: " ORIGIN/MAIN " } }); flush();
  const choice = await screen.findByRole("option", { name: "origin/main · Remote (stored locally)" });
  expect(screen.queryByRole("option", { name: "feature-0 · Local" })).toBeNull();
  expect(model.review.base()).toBe("");
  expect(model.review.target()?.scope).toBe("unstaged");
  fireEvent.click(choice); flush();
  expect(model.review.base()).toBe("refs/remotes/origin/main");
  expect(picker.textContent).toContain("origin/main");
  await waitFor(() => { flush(); expect(model.review.target()).toEqual({ scope: "branch", base: "refs/remotes/origin/main" }); expect(model.review.busy()).toBe(false); });
  const comparisons = request.mock.calls.filter(([url]) => !url.endsWith("/branches")).length;
  openPicker(picker);
  fireEvent.input(screen.getByRole("searchbox", { name: "Find a branch" }), { target: { value: "absent" } }); flush();
  await screen.findByText("No matching branches.");
  expect(screen.queryByRole("option", { name: "Enter a branch or tag…" })).toBeNull();
  expect(model.review.base()).toBe("refs/remotes/origin/main");
  fireEvent.keyDown(screen.getByRole("searchbox", { name: "Find a branch" }), { key: "Escape" }); flush();
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(request.mock.calls.filter(([url]) => !url.endsWith("/branches"))).toHaveLength(comparisons);
  expect(model.review.target()).toEqual({ scope: "branch", base: "refs/remotes/origin/main" });
});

it("can reload a failed branch list without offering manual entry", async () => {
  let failed = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/branches") && failed
    ? new Response(JSON.stringify({ error: "Branches unavailable" }), { status: 422 })
    : new Response(JSON.stringify(url.endsWith("/branches") ? branches : snapshot))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("article"); fireEvent.click(page.getByRole("button", { name: "Branch" }));
  expect((await page.findByRole("alert")).textContent).toContain("Branches unavailable");
  openPicker(page.getByRole("button", { name: /^Compare against/ }));
  expect(screen.queryByRole("option", { name: "Enter a branch or tag…" })).toBeNull();
  expect(page.queryByRole("textbox", { name: "Branch, tag, or full ref" })).toBeNull();
  failed = false; fireEvent.click(page.getByRole("button", { name: "Reload branches" }));
  await waitFor(() => { flush(); expect(model.review.branches.busy()).toBe(false); });
  openPicker(page.getByRole("button", { name: /^Compare against/ }));
  await screen.findByRole("option", { name: "origin/main · Remote (stored locally)" });
  expect(model.review.base()).toBe("");
  expect(page.queryByRole("alert")).toBeNull();
});

it("reopens a blank-base review without an error and retries an interrupted branch list", async () => {
  let reply!: (value: Response) => void, loads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/branches") && ++loads === 1) return new Promise<Response>(resolve => { reply = resolve; });
    return new Response(JSON.stringify(url.endsWith("/branches") ? branches : snapshot));
  }));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const first = render(() => <LocalReview model={model} conversation={() => {}} />);
  await first.findByRole("article"); fireEvent.click(first.getByRole("button", { name: "Branch" }));
  await waitFor(() => expect(loads).toBe(1)); first.unmount(); flush();
  const second = render(() => <LocalReview model={model} conversation={() => {}} />);
  const picker = await second.findByRole("button", { name: /^Compare against/ });
  await waitFor(() => { flush(); expect(model.review.branches.busy()).toBe(false); });
  openPicker(picker);
  await screen.findByRole("option", { name: "origin/main · Remote (stored locally)" });
  expect(second.queryByRole("alert")).toBeNull();
  expect(model.review.target()?.scope).toBe("unstaged");
  reply(new Response(JSON.stringify({ branches: [], truncated: false })));
  await waitFor(() => { flush(); expect(model.review.branches.value()?.branches).toHaveLength(2); });
});

it("keeps a missing selected base displayed after reload and dismisses keyboard choices without changing it", async () => {
  let current = branches;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/branches") ? current : snapshot))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("article"); fireEvent.click(page.getByRole("button", { name: "Branch" }));
  await waitFor(() => { flush(); expect(model.review.branches.busy()).toBe(false); });
  model.review.setBase("refs/heads/main"); flush();
  const picker = page.getByRole("button", { name: /^Compare against/ });
  expect(picker.textContent).toContain("main · Local");
  current = { branches: [], truncated: false };
  fireEvent.click(page.getByRole("button", { name: "Reload branches" }));
  await waitFor(() => { flush(); expect(picker.textContent).toContain("Selected: refs/heads/main"); });
  fireEvent.keyDown(picker, { key: "Enter" }); flush();
  expect(screen.getByRole("option", { name: "Selected: refs/heads/main" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" }); flush();
  await waitFor(() => { flush(); expect(screen.queryByRole("listbox")).toBeNull(); });
  expect(model.review.base()).toBe("refs/heads/main");
  expect(picker.textContent).toContain("Selected: refs/heads/main");
  expect(model.review.target()?.scope).toBe("unstaged");
});

it("validates bounded authenticated branch choices and reports actionable failures", async () => {
  const request = vi.fn(async () => new Response(JSON.stringify(branches))); vi.stubGlobal("fetch", request);
  const signal = new AbortController().signal;
  expect(await fetchBranches("s", signal, "cap")).toEqual(branches);
  expect(request).toHaveBeenCalledWith("/review/s/branches", expect.objectContaining({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store", body: "{}", headers: { "content-type": "application/json", "x-pi-capability": "cap" } }));
  await fetchBranches("s", signal, "cap", "origin/main");
  expect(request).toHaveBeenLastCalledWith("/review/s/branches", expect.objectContaining({ body: JSON.stringify({ query: "origin/main" }) }));
  await expect(fetchBranches("s", signal, null)).rejects.toThrow("Authentication required");
  for (const malformed of [
    null, { ...branches, truncated: "yes" }, { ...branches, branches: Array(101).fill(branches.branches[0]) },
    { ...branches, branches: [branches.branches[0], branches.branches[0]] },
    ...[
      { ref: "main", name: "main", kind: "local" },
      { ref: "refs/heads/main", name: "main", kind: "remote" },
      { ref: "refs/heads/main", name: "main", kind: "tag" },
      { ref: "refs/heads/a\nb", name: "a\nb", kind: "local" },
      { ref: `refs/heads/${"é".repeat(124)}`, name: "é".repeat(124), kind: "local" },
    ].map(entry => ({ ...branches, branches: [entry] })),
  ]) {
    request.mockImplementationOnce(async () => new Response(JSON.stringify(malformed)));
    await expect(fetchBranches("s", signal, "cap")).rejects.toThrow("Invalid branch list");
  }
  request.mockImplementationOnce(async () => new Response("x".repeat(65537)));
  await expect(fetchBranches("s", signal, "cap")).rejects.toThrow("exceeds its limit");
  for (const [status, message] of [[403, "Authentication required"], [429, "workers are busy"]] as const) {
    request.mockImplementationOnce(async () => new Response("", { status }));
    await expect(fetchBranches("s", signal, "cap")).rejects.toThrow(message);
  }
});

it("keeps the latest search when an older reply arrives and reloads the current query", async () => {
  let reply!: (value: BranchList) => void;
  const load = vi.fn(async (_signal: AbortSignal, _query: string): Promise<BranchList> => branches as BranchList);
  const model = createBranchList(load);
  load.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  const pending = model.refresh("old"); flush();
  expect(model.value()).toBeUndefined();
  await model.refresh("main"); flush();
  reply({ branches: [], truncated: false }); await pending; flush();
  expect(model.value()).toEqual(branches); expect(model.query()).toBe("main");
  expect(load.mock.calls[0][0].aborted).toBe(true);
  await model.refresh();
  expect(load.mock.calls.at(-1)![1]).toBe("main");
  await model.refresh(""); flush();
  expect(model.query()).toBe(""); expect(load.mock.calls.at(-1)![1]).toBe("");
});

it("retains branch choices on failure and ignores cancelled late replies", async () => {
  const load = vi.fn(async (_signal: AbortSignal): Promise<BranchList> => branches as BranchList);
  const model = createBranchList(load);
  await model.refresh(); flush();
  load.mockRejectedValueOnce(new Error("Retry branches")); await model.refresh(); flush();
  expect(model.value()).toEqual(branches); expect(model.error()).toBe("Retry branches");
  let reply!: (value: BranchList) => void;
  load.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  const pending = model.refresh(); model.cancel(); reply({ branches: [], truncated: false }); await pending; flush();
  expect(load.mock.calls.at(-1)![0].aborted).toBe(true); expect(model.value()).toEqual(branches); expect(model.busy()).toBe(false);
});
