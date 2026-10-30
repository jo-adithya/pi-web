import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import App from "../src/App";
import { initialState } from "../src/client-state";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  close = vi.fn(() => { this.readyState = 3; });
  send = vi.fn();
  constructor(readonly url: string, readonly protocols?: string[]) { Socket.instances.push(this); }
}
const storageKey = "pi-web.capability.v1", first = "a".repeat(64), second = "b".repeat(64);
beforeEach(() => { sessionStorage.setItem(storageKey, first); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); history.replaceState(null, "", "/"); });

it("leaves composer positioning to CSS during viewport changes while preserving pinch-zoom support", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  const workspace = page.container.querySelector<HTMLElement>(".workspace")!;
  await vi.waitFor(() => { flush(); expect(workspace.style.getPropertyValue("--viewport-bottom")).toBe(""); });
  for (const height of [744, 480, 800]) {
    viewport.height = height;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    flush();
    expect(workspace.style.getPropertyValue("--viewport-bottom")).toBe("");
  }
  viewport.scale = 2;
  viewport.dispatchEvent(new Event("resize")); flush();
  expect(workspace.classList.contains("pinch-zoomed")).toBe(true);
  viewport.scale = 1;
  viewport.dispatchEvent(new Event("resize")); flush();
  expect(workspace.classList.contains("pinch-zoomed")).toBe(false);
});

it.each(["terminal URL", "pasted link"])("keeps an unacknowledged draft editable after same-epoch reauthentication via %s", async method => {
  Socket.instances = [];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true })); vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  function attach(socket: Socket) {
    socket.onopen?.();
    const sessionId = "10000000-0000-4000-8000-000000000001", epoch = "20000000-0000-4000-8000-000000000001";
    socket.onmessage?.({ data: JSON.stringify({ v: 2, requestId: null, ok: true, code: "catalog", target: null, selected: sessionId, selectedWorkspace: "30000000-0000-4000-8000-000000000001", workspaces: [{ workspaceId: "30000000-0000-4000-8000-000000000001", name: "fixture", path: "/projects/fixture" }], sessions: [{ sessionId, workspaceId: "30000000-0000-4000-8000-000000000001", title: "Conversation 1", lifecycle: "open", runtime: { epoch, process: "ready", activity: "idle" } }] }) });
    for (const body of [
      { type: "hello", project: "fixture", process: "ready" },
      { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } },
    ]) socket.onmessage?.({ data: JSON.stringify({ v: 1, sessionId, epoch, body }) });
    flush();
  }
  attach(Socket.instances[0]);
  const input = page.getByLabelText("Message Pi");
  fireEvent.input(input, { target: { value: "Keep this uncertain draft" } }); flush();
  fireEvent.click(page.getByRole("button", { name: "Send" })); flush();
  expect(page.getByRole("button", { name: "Sending…" })).toBeDefined();
  if (method === "terminal URL") {
    history.replaceState(null, "", `/#cap=${first}`); window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    Socket.instances[0].onclose?.(); flush();
    fireEvent.click(page.getByRole("button", { name: "Update login link" })); flush();
    const login = page.getByLabelText("Terminal login link");
    fireEvent.input(login, { target: { value: `${location.origin}/#cap=${first}` } });
    fireEvent.submit(login.closest("form")!);
  }
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(2));
  attach(Socket.instances[1]);
  expect((page.getByLabelText("Message Pi") as HTMLTextAreaElement).value).toBe("Keep this uncertain draft");
  expect((page.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  expect(page.getByText(/Prompt delivery is uncertain/)).toBeDefined();
});

it("opens Settings without a conversation or starting AI work", async () => {
  Socket.instances = [];
  const fetcher = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetcher); vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const settings = page.getByRole("button", { name: "Settings" });
  expect(settings.closest(".sidebar-footer")).not.toBeNull();
  expect(settings.closest(".workspace-controls")).toBeNull();
  fireEvent.click(settings); flush();
  expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
  expect(page.getByText("Select a conversation to configure AI review.")).toBeTruthy();
  expect(page.queryByText("Connecting to your workspace")).toBeNull();
  expect(page.queryByLabelText("Grouping model")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(Socket.instances[0].send).not.toHaveBeenCalled();
});

it("opens Settings from the mobile sidebar footer and closes the drawer", async () => {
  Socket.instances = [];
  const media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  expect(page.queryByRole("button", { name: "Settings" })).toBeNull();
  fireEvent.click(page.getByRole("button", { name: "Open sessions" })); flush();
  const body = within(document.body);
  const settings = await body.findByRole("button", { name: "Settings" });
  expect(settings.closest(".sidebar-footer")).not.toBeNull();
  fireEvent.click(settings); flush();
  await page.findByRole("heading", { name: "Settings", level: 1 });
  await vi.waitFor(() => expect(body.queryByRole("dialog")).toBeNull());
});

it("keeps the chat draft and review preferences when navigating through Settings", async () => {
  Socket.instances = [];
  const fetcher = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetcher); vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0], sessionId = "10000000-0000-4000-8000-000000000001", epoch = "20000000-0000-4000-8000-000000000001";
  socket.onopen?.();
  socket.onmessage?.({ data: JSON.stringify({ v: 2, requestId: null, ok: true, code: "catalog", target: null, selected: sessionId, selectedWorkspace: "30000000-0000-4000-8000-000000000001", workspaces: [{ workspaceId: "30000000-0000-4000-8000-000000000001", name: "fixture", path: "/projects/fixture" }], sessions: [{ sessionId, workspaceId: "30000000-0000-4000-8000-000000000001", title: "My review", lifecycle: "open", runtime: { epoch, process: "ready", activity: "idle" } }] }) });
  for (const body of [
    { type: "hello", project: "fixture", process: "ready" },
    { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } },
  ]) socket.onmessage?.({ data: JSON.stringify({ v: 1, sessionId, epoch, body }) });
  flush();
  fireEvent.input(page.getByLabelText("Message Pi"), { target: { value: "Keep my draft" } }); flush();
  const sends = socket.send.mock.calls.length;
  fireEvent.click(page.getByRole("button", { name: "Settings" })); flush();
  expect(page.getByText("My review", { selector: "strong" })).toBeTruthy();
  fireEvent.change(page.getByLabelText("Maximum AI calls"), { target: { value: "2" } }); flush();
  fireEvent.click(page.getByRole("button", { name: "Conversation" })); flush();
  expect((page.getByLabelText("Message Pi") as HTMLTextAreaElement).value).toBe("Keep my draft");
  fireEvent.click(page.getByRole("button", { name: "Settings" })); flush();
  expect((page.getByLabelText("Maximum AI calls") as HTMLInputElement).value).toBe("2");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(socket.send).toHaveBeenCalledTimes(sends);
});

it.each([true, false])("keeps a grouping run alive across Settings (finish there: %s)", async finishInSettings => {
  Socket.instances = [];
  const file = { path: "src/example.ts", previousPath: null, status: "modified", fingerprint: "one", patch: "@@ -1 +1 @@\n-old\n+new\n" };
  let complete!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/groups")) {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        complete = resolve;
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }
    return new Response(JSON.stringify({ files: [file], truncated: false, note: null }));
  });
  vi.stubGlobal("fetch", fetcher); vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0], sessionId = "10000000-0000-4000-8000-000000000001", epoch = "20000000-0000-4000-8000-000000000001";
  socket.onopen?.();
  socket.onmessage?.({ data: JSON.stringify({ v: 2, requestId: null, ok: true, code: "catalog", target: null, selected: sessionId, selectedWorkspace: "30000000-0000-4000-8000-000000000001", workspaces: [{ workspaceId: "30000000-0000-4000-8000-000000000001", name: "fixture", path: "/projects/fixture" }], sessions: [{ sessionId, workspaceId: "30000000-0000-4000-8000-000000000001", title: "My review", lifecycle: "open", runtime: { epoch, process: "ready", activity: "idle" } }] }) });
  for (const body of [
    { type: "hello", project: "fixture", process: "ready" },
    { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } },
  ]) socket.onmessage?.({ data: JSON.stringify({ v: 1, sessionId, epoch, body }) });
  flush();
  fireEvent.click(page.getByRole("button", { name: "Changes" }));
  await page.findByRole("heading", { name: file.path });
  fireEvent.click(page.getByRole("button", { name: "Group with AI" }));
  await vi.waitFor(() => expect(signal).toBeDefined());
  const requests = fetcher.mock.calls.length;
  fireEvent.click(page.getByRole("button", { name: "Settings" })); flush();
  expect(signal!.aborted).toBe(false);
  expect(page.getByLabelText("Grouping model").closest("fieldset")?.disabled).toBe(true);
  expect(page.queryByRole("region", { name: "Local changes" })).toBeNull();
  if (!finishInSettings) {
    fireEvent.click(page.getByRole("button", { name: "Changes" })); flush();
    expect(signal!.aborted).toBe(false);
  }
  complete(new Response(JSON.stringify({ groups: [{ title: "Keep this result", reason: "", paths: [file.path] }] })));
  if (finishInSettings) {
    await vi.waitFor(() => expect(page.getByLabelText("Grouping model").closest("fieldset")?.disabled).toBe(false));
    fireEvent.click(page.getByRole("button", { name: "Changes" })); flush();
  }
  await page.findByRole("button", { name: "By purpose" });
  expect(fetcher).toHaveBeenCalledTimes(requests);
});

it("uses accessible icon-only view buttons on mobile and text on desktop", async () => {
  Socket.instances = [];
  const media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  Socket.instances[0].onopen?.();
  const sessionId = "10000000-0000-4000-8000-000000000001";
  Socket.instances[0].onmessage?.({ data: JSON.stringify({ v: 2, requestId: null, ok: true, code: "catalog", target: null, selected: sessionId, selectedWorkspace: "30000000-0000-4000-8000-000000000001", workspaces: [{ workspaceId: "30000000-0000-4000-8000-000000000001", name: "fixture", path: "/projects/fixture" }], sessions: [{ sessionId, workspaceId: "30000000-0000-4000-8000-000000000001", title: "Conversation 1", lifecycle: "stopped", runtime: null }] }) });
  flush();
  for (const name of ["Conversation", "Changes"]) {
    const button = page.getByRole("button", { name });
    expect(button.textContent).toBe("");
    expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  }
  fireEvent.click(page.getByRole("button", { name: "Changes" })); flush();
  expect(page.getByRole("button", { name: "Changes" }).getAttribute("aria-pressed")).toBe("true");
  media.matches = false;
  media.dispatchEvent(new Event("change")); flush();
  for (const name of ["Conversation", "Changes"]) {
    expect(page.getByRole("button", { name }).textContent).toBe(name);
  }
});

it("consumes a new bootstrap capability after a same-document terminal URL navigation", async () => {
  Socket.instances = [];
  const fetcher = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetcher); vi.stubGlobal("WebSocket", Socket);
  history.replaceState(null, "", `/#cap=${first}`); render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  expect(location.hash).toBe("");
  history.replaceState(null, "", `/#cap=${second}`); window.dispatchEvent(new HashChangeEvent("hashchange"));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(location.hash).toBe(""); expect(Socket.instances).toHaveLength(2);
  expect(Socket.instances[0].close).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ capability: second });
});

it("uses explicit socket proof from origin-scoped storage across reload", async () => {
  Socket.instances = [];
  const fetcher = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetcher); vi.stubGlobal("WebSocket", Socket);
  render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  expect(Socket.instances[0].protocols).toEqual(["pi-web.v1", `pi-web.cap.${first}`]);
  expect(Socket.instances[0].url).not.toContain(first);
  expect(fetcher.mock.calls[0][1].credentials).toBe("omit");
  cleanup(); render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(2));
  expect(Socket.instances[1].protocols).toEqual(Socket.instances[0].protocols);
});

it.each([null, "malformed"])("requires a valid origin-scoped capability instead of ambient cookies (%s)", async (stored) => {
  Socket.instances = []; sessionStorage.removeItem(storageKey);
  if (stored !== null) sessionStorage.setItem(storageKey, stored);
  vi.stubGlobal("WebSocket", Socket); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(page.getByText("Authentication required")).toBeDefined());
  expect(Socket.instances).toHaveLength(0); expect(fetcher).not.toHaveBeenCalled();
});

it("lets an installed app sign in with a pasted same-origin terminal link", async () => {
  sessionStorage.clear(); Socket.instances = [];
  const persistentWrite = vi.fn();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: persistentWrite });
  const fetcher = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetcher); vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  const input = await page.findByLabelText("Terminal login link") as HTMLInputElement;
  expect(input.type).toBe("password");
  fireEvent.input(input, { target: { value: `${location.origin}/#cap=${second}` } });
  fireEvent.submit(input.closest("form")!);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  expect(fetcher).toHaveBeenCalledWith("/auth", expect.objectContaining({ body: JSON.stringify({ capability: second }), credentials: "omit", cache: "no-store" }));
  expect(sessionStorage.getItem(storageKey)).toBe(second);
  expect(persistentWrite).not.toHaveBeenCalled();
  expect(input.value).toBe("");
  expect(location.hash).toBe("");
  expect(page.queryByLabelText("Terminal login link")).toBeNull();
});

it("can replace a stale login from the installed window while reconnecting", async () => {
  Socket.instances = [];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true })); vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  Socket.instances[0].onopen?.(); flush();
  Socket.instances[0].onclose?.(); flush();
  fireEvent.click(page.getByRole("button", { name: "Update login link" })); flush();
  const input = page.getByLabelText("Terminal login link") as HTMLInputElement;
  fireEvent.input(input, { target: { value: `${location.origin}/#cap=${second}` } });
  fireEvent.submit(input.closest("form")!);
  await vi.waitFor(() => expect(Socket.instances.at(-1)?.protocols).toEqual(["pi-web.v1", `pi-web.cap.${second}`]));
  expect(sessionStorage.getItem(storageKey)).toBe(second);
  expect(page.queryByLabelText("Terminal login link")).toBeNull();
});

it.each([
  `https://other.example/#cap=${first}`,
  `${location.origin}/#cap=invalid`,
  `${location.origin}/?cap=${first}`,
  `${location.origin}/#cap=${first}&cap=${second}`,
])("rejects a pasted invalid or foreign login link without sending it (%s)", async link => {
  sessionStorage.clear(); Socket.instances = [];
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  const input = await page.findByLabelText("Terminal login link") as HTMLInputElement;
  fireEvent.input(input, { target: { value: link } }); fireEvent.submit(input.closest("form")!); flush();
  expect(page.getByText(/Paste the complete login link for this server/)).toBeDefined();
  expect(fetcher).not.toHaveBeenCalled(); expect(Socket.instances).toHaveLength(0);
  expect(input.value).toBe("");
});

it("clears a rejected stored capability without opening a socket", async () => {
  Socket.instances = [];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false })); vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(page.getByText("Authentication required")).toBeDefined());
  expect(sessionStorage.getItem(storageKey)).toBeNull();
  expect(Socket.instances).toHaveLength(0);
});

it.each(["accepted", "rejected", "failed"])("keeps the newest successful bootstrap when an older authentication finishes later (%s)", async (outcome) => {
  Socket.instances = [];
  const completions: Array<{ resolve: (response: { ok: boolean }) => void; reject: (reason: Error) => void }> = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<{ ok: boolean }>((resolve, reject) => completions.push({ resolve, reject })))); vi.stubGlobal("WebSocket", Socket);
  history.replaceState(null, "", `/#cap=${first}`); render(() => <App />);
  await vi.waitFor(() => expect(completions).toHaveLength(1));
  history.replaceState(null, "", `/#cap=${second}`); window.dispatchEvent(new HashChangeEvent("hashchange"));
  await vi.waitFor(() => expect(completions).toHaveLength(2));
  completions[1].resolve({ ok: true }); await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  if (outcome === "failed") completions[0].reject(new Error("Network unavailable"));
  else completions[0].resolve({ ok: outcome === "accepted" });
  await Promise.resolve(); flush();
  expect(Socket.instances).toHaveLength(1);
  expect(Socket.instances[0].protocols).toEqual(["pi-web.v1", `pi-web.cap.${second}`]);
  expect(sessionStorage.getItem(storageKey)).toBe(second);
});

it("uses memory-only proof with a visible warning when browser storage is unavailable", async () => {
  Socket.instances = [];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true })); vi.stubGlobal("WebSocket", Socket);
  const setItem = vi.fn(() => { throw new DOMException("Storage disabled", "SecurityError"); });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem, removeItem: vi.fn() });
  history.replaceState(null, "", `/#cap=${second}`); const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  expect(Socket.instances[0].protocols).toEqual(["pi-web.v1", `pi-web.cap.${second}`]);
  expect(setItem).toHaveBeenCalledOnce();
  flush();
  expect(page.getByText(/Browser storage is unavailable/)).toBeDefined();
});

