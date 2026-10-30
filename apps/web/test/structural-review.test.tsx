import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { LocalReview } from "../src/LocalReview";
import { createSessionModel } from "../src/session-model";
import { fetchStructuralReview, createStructuralReview, type StructuralResult } from "../src/structural-review";

const file = { path: "src/main.rs", previousPath: null, status: "modified", fingerprint: "snapshot-a", patch: '@@ -1 +1 @@\n-fn main() { old(); }\n+fn main() { new(); }\n' };
const snapshot = { files: [file, { ...file, path: "src/other.rs", fingerprint: "snapshot-b" }], truncated: false, note: null };
const result = { mode: "structural", engine: "Difftastic 0.72.0", language: "Rust", lines: [
  { kind: "remove", old: 1, segments: [{ text: "fn main() { ", changed: false }, { text: "old", changed: true }, { text: "(); }", changed: false }] },
  { kind: "add", next: 1, segments: [{ text: "fn main() { ", changed: false }, { text: "new", changed: true }, { text: "(); }", changed: false }] },
] };
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); vi.spyOn(window, "scrollTo").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("loads structural comparison only on request and keeps Ask Pi as an unsent text draft", async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/structural") ? result : snapshot)));
  vi.stubGlobal("fetch", fetch);
  const transport = vi.fn(() => true), conversation = vi.fn();
  const model = createSessionModel("s", transport, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={conversation} />);
  await waitFor(() => { flush(); expect(page.getByRole("region", { name: "Unified diff" })).toBeTruthy(); });
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(page.getByRole("button", { name: "Structural" })); flush();
  await waitFor(() => { flush(); expect(page.getByRole("region", { name: "Structural diff" })).toBeTruthy(); });
  expect(fetch).toHaveBeenLastCalledWith("/review/s/structural", expect.objectContaining({
    method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
    headers: { "content-type": "application/json", "x-pi-capability": "cap" },
    body: JSON.stringify({ scope: "unstaged", path: "src/main.rs", fingerprint: "snapshot-a" }),
  }));
  expect(page.container.querySelector(".diff-add .structural-change")?.textContent).toBe("new");
  expect(page.container.querySelector(".diff-add code")?.textContent).toBe("fn main() { new(); }");
  expect(page.getByText(/Difftastic 0.72.0/)).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Ask Pi about file" })); flush();
  expect(model.draft()).toContain(file.patch);
  expect(transport).not.toHaveBeenCalled(); expect(conversation).toHaveBeenCalledOnce();
  fireEvent.click(page.getByRole("button", { name: "Text" })); flush();
  expect(page.getByRole("region", { name: "Unified diff" })).toBeTruthy();
});

it("hides structural diff markers while retaining source operators", async () => {
  const comparison = { ...result, lines: [
    { kind: "remove", old: 1, segments: [{ text: "--count;", changed: true }] },
    { kind: "add", next: 1, segments: [{ text: "++count;", changed: true }] },
    { kind: "context", old: 2, next: 2, segments: [{ text: "  unchanged();", changed: false }] },
  ] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/structural") ? comparison : snapshot))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("region", { name: "Unified diff" });
  fireEvent.click(page.getByRole("button", { name: "Structural" }));
  const region = await page.findByRole("region", { name: "Structural diff" });
  expect([...region.querySelectorAll(".diff-line code")].map(code => code.textContent)).toEqual(["--count;", "++count;", "  unchanged();"]);
});

it.each([
  { mode: "text", reason: "Difftastic 0.72.0 is unavailable." },
  { mode: "text", reason: "Unsupported language; use text diff." },
  { error: "File changed since the snapshot. Refresh local changes." },
])("keeps the text diff visible and explains fallback: %j", async failure => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/structural") ? failure : snapshot), { status: url.endsWith("/structural") && "error" in failure ? 422 : 200 })));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.getByRole("button", { name: "Structural" })).toBeTruthy(); });
  fireEvent.click(page.getByRole("button", { name: "Structural" })); flush();
  await waitFor(() => { flush(); expect(page.getByText(/Showing text diff/)).toBeTruthy(); });
  expect(page.getByRole("region", { name: "Unified diff" })).toBeTruthy();
  expect(page.queryByRole("region", { name: "Structural diff" })).toBeNull();
});

it.each(["Text", "other file", "Refresh", "Staged", "unmount"])("cancels pending comparison and ignores late responses on %s", async action => {
  let reply!: (value: Response) => void, signal!: AbortSignal;
  const fetch = vi.fn((url: string, options: RequestInit) => {
    if (url.endsWith("/structural")) { signal = options.signal!; return new Promise<Response>(resolve => { reply = resolve; }); }
    return Promise.resolve(new Response(JSON.stringify(snapshot)));
  });
  vi.stubGlobal("fetch", fetch);
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.getByRole("button", { name: "Structural" })).toBeTruthy(); });
  fireEvent.click(page.getByRole("button", { name: "Structural" })); flush();
  expect(page.getByText(/Comparing syntax/)).toBeTruthy();
  expect(page.getByRole("region", { name: "Unified diff" })).toBeTruthy();
  if (action === "unmount") page.unmount();
  else fireEvent.click(page.getByRole("button", { name: action === "other file" ? "src/other.rs — modified" : action }));
  flush(); expect(signal.aborted).toBe(true);
  reply(new Response(JSON.stringify(result)));
  await waitFor(() => { flush(); expect(model.review.structural.busy()).toBe(false); });
  expect(model.review.structural.result()).toBeUndefined();
  expect(model.review.structural.mode()).toBe("text");
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/structural"))).toHaveLength(1);
});

it("bounds structural segment rendering and preserves fragmented source text", async () => {
  const lines = Array.from({ length: 600 }, (_, i) => ({ kind: "add", next: i + 1, segments: Array.from({ length: 20 }, (_, j) => ({ text: `s${j}`, changed: j % 2 === 0 })) }));
  lines.push({ kind: "add", next: 601, segments: Array.from({ length: 300 }, () => ({ text: "x", changed: true })) });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/structural") ? { ...result, lines } : snapshot))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await page.findByRole("region", { name: "Unified diff" });
  fireEvent.click(page.getByRole("button", { name: "Structural" }));
  await page.findByRole("region", { name: "Structural diff" });
  expect(page.container.querySelectorAll(".diff-line code span").length).toBeLessThan(4000);
  expect(page.container.textContent).toContain("Very fragmented lines");
  while (!(page.getAllByRole("button", { name: "Next rows" })[0] as HTMLButtonElement).disabled) {
    fireEvent.click(page.getAllByRole("button", { name: "Next rows" })[0]); flush();
  }
  const rows = page.container.querySelectorAll(".diff-line code");
  expect(rows[rows.length - 1].textContent).toBe("x".repeat(300));
  expect(rows[rows.length - 1].querySelectorAll(".structural-change")).toHaveLength(0);
});

it("shows formatting-only results without claiming semantic equivalence", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/structural") ? { ...result, lines: [] } : snapshot))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.getByRole("button", { name: "Structural" })).toBeTruthy(); });
  fireEvent.click(page.getByRole("button", { name: "Structural" })); flush();
  await waitFor(() => { flush(); expect(page.getByText(/No structural changes detected/)).toBeTruthy(); });
  expect(page.getByText(/Check Text mode for formatting or metadata changes/)).toBeTruthy();
});

it("renders Unicode, tabs, carriage returns and source markup as inert text", async () => {
  const text = '\tconst x = "é😀";\r<script>alert(1)</script>';
  const markup = { ...result, lines: [{ kind: "add", next: 5, segments: [{ text, changed: true }] }] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/structural") ? markup : snapshot))));
  const model = createSessionModel("s", () => true, () => true, undefined, () => "cap");
  const page = render(() => <LocalReview model={model} conversation={() => {}} />);
  await waitFor(() => { flush(); expect(page.getByRole("button", { name: "Structural" })).toBeTruthy(); });
  fireEvent.click(page.getByRole("button", { name: "Structural" })); flush();
  await waitFor(() => { flush(); expect(page.getByRole("region", { name: "Structural diff" })).toBeTruthy(); });
  expect(page.container.querySelector(".structural-change")?.textContent).toBe(text);
  expect(page.container.querySelector("script")).toBeNull();
  expect(page.container.querySelector(".diff-add .diff-number:last-of-type")?.textContent).toBe("5");
});

it.each([
  {}, { mode: "text", reason: "" }, { ...result, lines: [{}] },
  { ...result, lines: [{ kind: ["add"], segments: [{ text: "x", changed: true }] }] },
  { ...result, lines: [{ kind: "add", next: -1, segments: [] }] },
  { ...result, lines: [{ kind: "add", segments: [] }] },
  { ...result, lines: [{ kind: "context", old: 1, next: 1, segments: [{ text: "x\ny", changed: true }] }] },
  { ...result, lines: [{ kind: "add", next: 1, segments: [{ text: "x", changed: "yes" }] }] },
  { ...result, lines: [{ kind: "add", next: 1, segments: [{ text: "x".repeat(1024 * 1024), changed: true }] }] },
])("rejects malformed or excessive structural results", async value => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value))));
  await expect(fetchStructuralReview("s", { scope: "unstaged", path: file.path, fingerprint: file.fingerprint }, new AbortController().signal, "cap")).rejects.toThrow("Invalid structural");
});

it("accepts one-sided context rows for syntax-ignored whitespace around changes", async () => {
  const lines = [
    { kind: "context", old: 1, segments: [{ text: " ", changed: false }] },
    { kind: "context", next: 2, segments: [{ text: "", changed: false }] },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...result, lines }))));
  await expect(fetchStructuralReview("s", { scope: "unstaged", path: file.path, fingerprint: file.fingerprint }, new AbortController().signal, "cap"))
    .resolves.toEqual({ ...result, lines });
});

it("checks authentication before fetching and reports admission errors", async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 429 })); vi.stubGlobal("fetch", fetch);
  const request = { scope: "staged" as const, path: file.path, fingerprint: file.fingerprint };
  await expect(fetchStructuralReview("s", request, new AbortController().signal, null)).rejects.toThrow("Authentication required");
  expect(fetch).not.toHaveBeenCalled();
  await expect(fetchStructuralReview("s", request, new AbortController().signal, "cap")).rejects.toThrow("busy");
});

it("ignores an older result when a replacement comparison finishes first", async () => {
  let reply!: (value: StructuralResult) => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise<StructuralResult>(resolve => { reply = resolve; }))
    .mockResolvedValueOnce({ mode: "text", reason: "new request" });
  const state = createStructuralReview(load);
  const request = { scope: "unstaged" as const, path: file.path, fingerprint: file.fingerprint };
  const first = state.show(request); const firstSignal = load.mock.calls[0][1];
  await state.show({ ...request, fingerprint: "changed" }); flush();
  expect(firstSignal.aborted).toBe(true); expect(state.reason()).toBe("new request");
  reply({ mode: "structural", engine: "Difftastic 0.72.0", language: "Rust", lines: [] }); await first; flush();
  expect(state.result()).toBeUndefined(); expect(state.reason()).toBe("new request");
});
