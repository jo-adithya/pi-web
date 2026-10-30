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

it("offers local and stored remote branches on demand and compares only after confirmation", async () => {
  const request = vi.fn(async (url: string, _init: RequestInit) => new Response(JSON.stringify(url.endsWith("/branches") ? branches : snapshot)));
  vi.stubGlobal("fetch", request);
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("article");
  expect(request.mock.calls.some(([url]) => url.endsWith("/branches"))).toBe(false);
  fireEvent.click(page.getByRole("button", { name: "Branch" }));
  const picker = await page.findByRole("button", { name: /^Compare against/ });
  openPicker(page.getByRole("button", { name: /^Compare against/ }));
  await screen.findByRole("option", { name: "origin/main · Remote (stored locally)" });
  expect(page.queryByRole("alert")).toBeNull();
  expect((page.getByRole("button", { name: "Compare" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("option", { name: "origin/main · Remote (stored locally)" })); flush();
  expect(picker.textContent).toContain("origin/main");
  expect(model.review.target()?.scope).toBe("unstaged");
  fireEvent.click(page.getByRole("button", { name: "Compare" }));
  await waitFor(() => { flush(); expect(model.review.target()).toEqual({ scope: "branch", base: "refs/remotes/origin/main" }); expect(model.review.busy()).toBe(false); });
  expect(page.getByText(/Committed changes since divergence; excludes uncommitted edits/)).toBeTruthy();
  expect(page.getByText(/may be stale/)).toBeTruthy();
  openPicker(picker);
  fireEvent.click(screen.getByRole("option", { name: "Enter a branch or tag…" })); flush();
  const manual = page.getByRole("textbox", { name: "Branch, tag, or full ref" }) as HTMLInputElement;
  fireEvent.input(manual, { target: { value: "v1.2" } });
  expect(manual.value).toBe("v1.2"); flush();
  fireEvent.click(page.getByRole("button", { name: "Compare" }));
  await waitFor(() => { flush(); expect(model.review.target()).toEqual({ scope: "branch", base: "v1.2" }); });
});

it("keeps manual comparison available when the branch list fails, and can reload", async () => {
  let failed = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/branches") && failed
    ? new Response(JSON.stringify({ error: "Branches unavailable" }), { status: 422 })
    : new Response(JSON.stringify(url.endsWith("/branches") ? branches : snapshot))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("article"); fireEvent.click(page.getByRole("button", { name: "Branch" }));
  expect((await page.findByRole("alert")).textContent).toContain("Branches unavailable");
  openPicker(page.getByRole("button", { name: /^Compare against/ }));
  fireEvent.click(screen.getByRole("option", { name: "Enter a branch or tag…" })); flush();
  fireEvent.input(page.getByRole("textbox", { name: "Branch, tag, or full ref" }), { target: { value: "main" } });
  failed = false; fireEvent.click(page.getByRole("button", { name: "Reload branches" }));
  openPicker(page.getByRole("button", { name: /^Compare against/ }));
  await screen.findByRole("option", { name: "origin/main · Remote (stored locally)" });
  expect(model.review.base()).toBe("main");
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
  openPicker(await second.findByRole("button", { name: /^Compare against/ }));
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
  expect(screen.getByRole("option", { name: "Enter a branch or tag…" })).toBeTruthy();
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
