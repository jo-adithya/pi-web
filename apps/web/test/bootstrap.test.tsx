import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import App from "../src/App";
import { initialState } from "../src/client-state";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  close = vi.fn(() => { this.readyState = 3; });
  send = vi.fn();
  constructor(readonly url: string, readonly protocols?: string[]) { Socket.instances.push(this); }
}
const storageKey = "pi-web.capability.v1", first = "a".repeat(64), second = "b".repeat(64);
beforeEach(() => { sessionStorage.setItem(storageKey, first); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); history.replaceState(null, "", "/"); });

it("keeps an unacknowledged draft editable after same-epoch reauthentication", async () => {
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
  history.replaceState(null, "", `/#cap=${first}`); window.dispatchEvent(new HashChangeEvent("hashchange"));
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(2));
  attach(Socket.instances[1]);
  expect((input as HTMLTextAreaElement).value).toBe("Keep this uncertain draft");
  expect((page.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  expect(page.getByText(/Prompt delivery is uncertain/)).toBeDefined();
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

