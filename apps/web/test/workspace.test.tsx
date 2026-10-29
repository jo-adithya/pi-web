import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import App from "../src/App";
import { initialState } from "../src/client-state";
import { createSessionModel } from "../src/session-model";
import { decodeWorkspace } from "../src/workspace-state";
import type { BrowserMessage, CatalogItem, ServerMessage } from "../src/generated/protocol";
const a = "10000000-0000-4000-8000-000000000001", b = "10000000-0000-4000-8000-000000000002";
const epoch = "20000000-0000-4000-8000-000000000001";
const wa = "30000000-0000-4000-8000-000000000001", wb = "30000000-0000-4000-8000-000000000002";
const workspace = (workspaceId = wa, name = "Alpha", path = "/projects/alpha") => ({ workspaceId, name, path });
const item = (sessionId: string, title: string, workspaceId = wa): CatalogItem => ({ sessionId, workspaceId, title, lifecycle: "open", runtime: { epoch, process: "ready", activity: "idle" } });
const catalog = () => ({ v: 2, requestId: null, ok: true, code: "catalog", target: null, selected: a, selectedWorkspace: wa, workspaces: [workspace()], sessions: [item(a, "Conversation 1"), item(b, "Conversation 2")] });
const grouped = () => ({ ...catalog(), workspaces: [workspace(), workspace(wb, "Beta", "/projects/beta")], sessions: [item(a, "Conversation 1"), item(b, "Conversation 2", wb)] });
function frames(sessionId: string): ServerMessage[] { return [
  { v: 1, sessionId, epoch, body: { type: "hello", project: "fixture", process: "ready" } },
  { v: 1, sessionId, epoch, body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } } },
]; }
class Socket {
  static OPEN = 1; static instances: Socket[] = []; readyState = 1;
  onopen?: () => void; onmessage?: (event: { data: string }) => void;
  close = vi.fn(() => { this.readyState = 3; }); send = vi.fn();
  constructor(_url: string) { Socket.instances.push(this); }
  emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); flush(); }
}
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  sessionStorage.setItem("pi-web.capability.v1", "a".repeat(64)); vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true })); });
afterEach(() => { cleanup(); Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close"); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); document.documentElement.classList.remove("dark"); history.replaceState(null, "", "/"); });

it("notifies for an unselected conversation only after explicit opt-in", async () => {
  const shown: { onclick?: () => void; close: () => void }[] = [];
  class NotificationFixture {
    static permission = "granted";
    close = vi.fn(); onclick?: () => void;
    constructor() { shown.push(this); }
  }
  vi.stubGlobal("Notification", NotificationFixture); vi.stubGlobal("isSecureContext", true);
  vi.spyOn(window, "focus").mockImplementation(() => {});
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]; socket.onopen?.(); socket.emit(catalog());
  for (const frame of [...frames(a), ...frames(b)]) socket.emit(frame);
  const done = { v: 1, sessionId: b, epoch, body: { type: "run_completed", runId: "1", outcome: "success" } };
  socket.emit(done); expect(shown).toHaveLength(0);
  fireEvent.click(page.getByLabelText("Session options")); flush();
  fireEvent.click(page.getByRole("button", { name: "Enable notifications" })); flush();
  socket.emit({ ...done, body: { ...done.body, runId: "2" } });
  socket.emit({ ...done, body: { ...done.body, runId: "2" } });
  expect(shown).toHaveLength(1);
  shown[0].onclick?.(); flush();
  expect(page.getByRole("button", { name: /Conversation 2/ }).getAttribute("aria-pressed")).toBe("true");
  expect(shown[0].close).toHaveBeenCalled();
});

it("shows live sidebar activity beside titles without status labels", async () => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]; socket.onopen?.();
  socket.emit({ ...catalog(), sessions: [item(a, "Conversation 1"), { ...item(b, "Conversation 2"), lifecycle: "stopped", runtime: null }] });
  for (const frame of frames(a)) socket.emit(frame);
  const first = page.getByRole("button", { name: /Conversation 1/ });
  const second = page.getByRole("button", { name: /Conversation 2/ });
  expect(first.textContent).toBe("Conversation 1");
  expect(second.textContent).toBe("Conversation 2");
  expect(first.classList.contains("stopped")).toBe(false);
  expect(second.classList.contains("stopped")).toBe(true);
  expect(second.getAttribute("aria-label")).toContain("stopped");
  expect(page.container.querySelector(".workspace-controls .activity")).toBeNull();
  let seq = 0;
  for (const activity of ["running", "retrying", "compacting", "idle", "awaiting_input", "failed"] as const) {
    socket.emit({ v: 1, sessionId: a, epoch, body: { type: "event", seq: ++seq, patches: [], status: { ...initialState().status, process: "ready", activity }, dialogs: [], olderHistory: false } } satisfies ServerMessage);
    expect(Boolean(first.querySelector(".session-title-row .working-dot"))).toBe(["running", "retrying", "compacting"].includes(activity));
    expect(first.getAttribute("aria-label")).toContain(activity.replaceAll("_", " "));
  }
});

it("groups conversations by workspace and creates in the chosen folder", async () => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]; socket.onopen?.(); socket.emit(grouped());
  for (const [wire] of [...socket.send.mock.calls]) socket.emit({ ...grouped(), requestId: JSON.parse(wire).requestId });
  expect(within(page.getByRole("group", { name: "Alpha" })).getByRole("button", { name: /Conversation 1/ })).toBeTruthy();
  const beta = within(page.getByRole("group", { name: "Beta" }));
  expect(beta.queryByRole("button", { name: /Conversation 1/ })).toBeNull();
  expect(beta.getByRole("button", { name: /Conversation 2/ })).toBeTruthy();
  fireEvent.click(beta.getByRole("button", { name: "Select workspace Beta" })); flush();
  const select = JSON.parse(socket.send.mock.calls.at(-1)![0]);
  expect(select.action).toEqual({ type: "select_workspace", workspaceId: wb });
  // The immutable target wins even when another controller moved global selection.
  socket.emit({ ...grouped(), requestId: select.requestId, code: "workspace_selected", target: b });
  expect(within(page.getByRole("group", { name: "Beta" })).getByRole("button", { name: /Conversation 2/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(page.getByRole("button", { name: "New conversation" })); flush();
  expect(JSON.parse(socket.send.mock.calls.at(-1)![0]).action).toEqual({ type: "create_in", workspaceId: wb });
});

it.each(["open", "stopped"] as const)("deletes a %s conversation only after confirmation and selects its replacement", async lifecycle => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]; socket.onopen?.();
  const value = { ...catalog(), sessions: [{ ...item(a, "Conversation 1"), lifecycle, runtime: lifecycle === "open" ? item(a, "Conversation 1").runtime : null }, item(b, "Conversation 2")] };
  socket.emit(value);
  for (const id of [a, b]) for (const frame of frames(id)) socket.emit(frame);
  for (const [wire] of [...socket.send.mock.calls]) socket.emit({ ...value, requestId: JSON.parse(wire).requestId });
  fireEvent.click(page.getByLabelText("Session options")); flush();
  const remove = page.getByRole("button", { name: "Delete conversation…" }) as HTMLButtonElement;
  const before = socket.send.mock.calls.length;
  fireEvent.click(remove); flush();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("permanently deleted"));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Project files will not be deleted"));
  expect(socket.send.mock.calls).toHaveLength(before);
  confirm.mockReturnValue(true); fireEvent.click(remove); flush();
  const request = JSON.parse(socket.send.mock.calls.at(-1)![0]);
  expect(request.action).toEqual({ type: "delete", sessionId: a, epoch: lifecycle === "open" ? epoch : null, confirmed: true });
  expect(remove.disabled).toBe(true);
  // A failed deletion keeps the selected conversation available for retry.
  socket.emit({ ...value, requestId: request.requestId, ok: false, code: "catalog_write_failed" });
  expect(page.getByRole("button", { name: /Conversation 1/ })).toBeTruthy();
  expect(page.getByText(/catalog write failed/)).toBeTruthy();
  fireEvent.click(remove); flush();
  const partial = JSON.parse(socket.send.mock.calls.at(-1)![0]);
  socket.emit({ ...value, requestId: partial.requestId, ok: false, code: "catalog_write_failed_after_transcript_deleted" }); flush();
  expect(page.getByText(/saved transcript was deleted.*Retry/i)).toBeTruthy();
  fireEvent.click(remove); flush();
  const retry = JSON.parse(socket.send.mock.calls.at(-1)![0]);
  socket.emit({ ...value, sessions: [item(b, "Conversation 2")], selected: b, target: b, requestId: retry.requestId, code: "deleted" });
  expect(page.queryByRole("button", { name: /Conversation 1/ })).toBeNull();
  expect(page.getByRole("button", { name: /Conversation 2/ }).getAttribute("aria-pressed")).toBe("true");
  // Buffered updates from the removed subscription cannot resurrect it or force reconnect.
  socket.emit({ v: 1, sessionId: a, epoch, body: { type: "run_completed", runId: "1", outcome: "success" } });
  expect(socket.close).not.toHaveBeenCalled();
});

it("renames and deletes an unselected conversation from its sidebar menu", async () => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]; socket.onopen?.(); socket.emit(grouped());
  for (const [wire] of [...socket.send.mock.calls]) socket.emit({ ...grouped(), requestId: JSON.parse(wire).requestId });
  const menu = () => page.getByLabelText("Options for Conversation 2").closest("details")!;
  const open = () => { fireEvent.click(page.getByLabelText("Options for Conversation 2")); flush(); };
  open();
  const before = socket.send.mock.calls.length;
  fireEvent.click(within(menu()).getByRole("button", { name: "Rename…" })); flush();
  expect(socket.send.mock.calls).toHaveLength(before);
  for (const invalid of ["   ", "é".repeat(33), "bad\nname"]) {
    prompt.mockReturnValue(invalid); open();
    fireEvent.click(within(menu()).getByRole("button", { name: "Rename…" })); flush();
    expect(socket.send.mock.calls).toHaveLength(before);
  }
  expect(page.getByText(/1–64 UTF-8 bytes/)).toBeTruthy();
  prompt.mockReturnValue("  Project notes  "); open();
  fireEvent.click(within(menu()).getByRole("button", { name: "Rename…" })); flush();
  let rename = JSON.parse(socket.send.mock.calls.at(-1)![0]);
  expect(rename.action).toEqual({ type: "rename", sessionId: b, title: "Project notes" });
  expect(page.getByRole("button", { name: /Conversation 1/ }).getAttribute("aria-pressed")).toBe("true");
  open();
  expect((within(menu()).getByRole("button", { name: "Rename…" }) as HTMLButtonElement).disabled).toBe(true);
  socket.emit({ ...grouped(), requestId: rename.requestId, ok: false, code: "catalog_write_failed" });
  expect(page.getByRole("button", { name: /Conversation 2/ })).toBeTruthy();
  fireEvent.click(within(menu()).getByRole("button", { name: "Rename…" })); flush();
  rename = JSON.parse(socket.send.mock.calls.at(-1)![0]);
  socket.emit({ ...grouped(), requestId: rename.requestId, code: "renamed", sessions: [item(a, "Conversation 1"), item(b, "Project notes", wb)] });
  const renamedMenu = page.getByLabelText("Options for Project notes").closest("details")!;
  fireEvent.click(page.getByLabelText("Options for Project notes")); flush();
  fireEvent.click(within(renamedMenu).getByRole("button", { name: "Delete…" })); flush();
  expect(socket.send.mock.calls.at(-1)![0]).toBe(JSON.stringify(rename));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("permanently deleted"));
  confirm.mockReturnValue(true);
  fireEvent.click(page.getByLabelText("Options for Project notes")); flush();
  fireEvent.click(within(renamedMenu).getByRole("button", { name: "Delete…" })); flush();
  expect(JSON.parse(socket.send.mock.calls.at(-1)![0]).action).toEqual({ type: "delete", sessionId: b, epoch, confirmed: true });
});

it("requires an absolute folder and trust confirmation before adding a workspace", async () => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]; socket.onopen?.(); socket.emit(catalog());
  for (const [wire] of [...socket.send.mock.calls]) socket.emit({ ...catalog(), requestId: JSON.parse(wire).requestId });
  fireEvent.click(page.getByRole("button", { name: "Add workspace" })); flush();
  const path = page.getByLabelText("Project folder");
  const add = page.getByRole("button", { name: "Add trusted folder" }) as HTMLButtonElement;
  fireEvent.input(path, { target: { value: "relative/folder" } }); flush();
  expect(add.disabled).toBe(true);
  fireEvent.click(page.getByRole("checkbox", { name: /I trust/ })); flush();
  expect(add.disabled).toBe(true);
  fireEvent.input(path, { target: { value: "/projects/beta" } }); flush();
  expect(add.disabled).toBe(false);
  fireEvent.click(add); flush();
  const request = JSON.parse(socket.send.mock.calls.at(-1)![0]);
  expect(request.action).toEqual({ type: "add_workspace", path: "/projects/beta", confirmed: true });
  socket.emit({ ...catalog(), requestId: request.requestId, ok: false, code: "invalid_workspace_path" });
  expect((page.getByLabelText("Project folder") as HTMLInputElement).value).toBe("/projects/beta");
  expect(page.getByRole("alert").textContent).toContain("invalid workspace path");
  fireEvent.click(add); flush();
  const retry = JSON.parse(socket.send.mock.calls.at(-1)![0]);
  socket.emit({ ...grouped(), requestId: retry.requestId, code: "workspace_added", target: b, selected: b, selectedWorkspace: wb });
  expect(page.queryByLabelText("Project folder")).toBeNull();
  expect(page.getByRole("button", { name: /Conversation 2/ }).getAttribute("aria-pressed")).toBe("true");
});

it("rejects unknown workspace membership and bounds conversations per workspace", () => {
  expect(decodeWorkspace(JSON.stringify(grouped())).sessions).toHaveLength(2);
  for (const value of [
    { ...grouped(), selectedWorkspace: wb },
    { ...grouped(), workspaces: [workspace(), workspace()] },
    { ...grouped(), sessions: [item(a, "A", "40000000-0000-4000-8000-000000000001")] },
    { ...grouped(), workspaces: [{ ...workspace(), path: "relative" }] },
    { ...grouped(), workspaces: [{ ...workspace(), path: "/" + "é".repeat(512) }] },
    { ...grouped(), requestId: "selection", code: "workspace_selected" },
  ]) expect(() => decodeWorkspace(JSON.stringify(value))).toThrow();
  const stopped = (count: number, group: string, prefix: number) => Array.from({ length: count }, (_, i) => ({ ...item(`${prefix}0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, "Saved", group), lifecycle: "stopped", runtime: null }));
  const sessions = [...stopped(32, wa, 5), ...stopped(32, wb, 6)];
  expect(decodeWorkspace(JSON.stringify({ ...grouped(), selected: sessions[0].sessionId, sessions })).sessions).toHaveLength(64);
  expect(() => decodeWorkspace(JSON.stringify({ ...catalog(), selected: sessions[0].sessionId, sessions: stopped(33, wa, 5) }))).toThrow();
});

it("keeps conversations in a sidebar and persists the selected color scheme", async () => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  Socket.instances[0].emit(catalog());
  const sidebar = page.getByRole("complementary", { name: "Sessions" });
  expect(sidebar.contains(page.getByRole("button", { name: /Conversation 2/ }))).toBe(true);
  const theme = page.getByLabelText("Color scheme");
  fireEvent.change(theme, { target: { value: "dark" } }); flush();
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(window.localStorage.getItem("pi-web.theme.v1")).toBe("dark");
  cleanup();
  const next = render(() => <App />); flush();
  expect((next.getByLabelText("Color scheme") as HTMLSelectElement).value).toBe("dark");
  fireEvent.change(next.getByLabelText("Color scheme"), { target: { value: "light" } }); flush();
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

it("dismisses the mobile sessions drawer with Escape or its overlay", async () => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === "(max-width: 760px)", media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  fireEvent.click(page.getByRole("button", { name: "Open sessions" })); flush();
  const body = within(document.body);
  await vi.waitFor(() => expect(body.getByRole("dialog", { name: "Sessions" })).toBeTruthy());
  fireEvent.keyDown(body.getByRole("button", { name: "Close sessions" }), { key: "Escape" }); flush();
  await vi.waitFor(() => expect(body.queryByRole("dialog")).toBeNull());
  fireEvent.click(page.getByRole("button", { name: "Open sessions" })); flush();
  await vi.waitFor(() => expect(body.getByRole("dialog", { name: "Sessions" })).toBeTruthy());
  fireEvent.click(document.querySelector(".sidebar-overlay")!); flush();
  await vi.waitFor(() => expect(body.queryByRole("dialog")).toBeNull());
});

it("gives incoming extension dialogs priority over the mobile sessions drawer", async () => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === "(max-width: 760px)", media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  // jsdom does not implement the native dialog API.
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } },
  });
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]; socket.onopen?.(); socket.emit(catalog());
  for (const frame of frames(a)) socket.emit(frame);
  fireEvent.click(page.getByRole("button", { name: "Open sessions" })); flush();
  const body = within(document.body);
  await vi.waitFor(() => expect(body.getByRole("dialog", { name: "Sessions" })).toBeTruthy());
  socket.emit({ v: 1, sessionId: a, epoch, body: { type: "event", seq: 1, patches: [], olderHistory: false,
    status: { ...initialState().status, process: "ready", activity: "awaiting_input" },
    dialogs: [{ id: "approval", kind: "confirm", title: "Approve fixture", message: "Safe test", options: [], initial: "" }],
  } });
  await vi.waitFor(() => expect(body.queryByRole("dialog", { name: "Sessions" })).toBeNull());
  expect(body.getByRole("dialog", { name: "Approve fixture" })).toBeTruthy();
  expect((page.getByRole("button", { name: "Open sessions" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(body.getByRole("button", { name: "Confirm" })); flush();
  expect(socket.send.mock.calls.map(([wire]) => JSON.parse(wire)).some(message =>
    message.action.type === "ui_reply" && message.action.dialogId === "approval" && message.action.answer.confirmed)).toBe(true);
});

it("still switches color scheme when browser storage is unavailable", () => {
  vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  const page = render(() => <App />);
  fireEvent.change(page.getByLabelText("Color scheme"), { target: { value: "dark" } }); flush();
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

it("shows the conversation and composer without a tool activity sidebar", async () => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]; socket.onopen?.(); socket.emit(catalog());
  for (const frame of frames(a)) socket.emit(frame);
  expect(page.getByRole("region", { name: "Conversation" })).toBeTruthy();
  expect(page.getByLabelText("Message Pi")).toBeTruthy();
  expect(page.queryByRole("complementary", { name: "Tool activity" })).toBeNull();
  expect(page.queryByText(/Tool calls and bounded output/)).toBeNull();
});

it("keeps status and session actions without a conversation title or Session label", async () => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]; socket.onopen?.(); socket.emit(catalog());
  for (const frame of frames(a)) socket.emit(frame);
  const main = within(page.getByRole("main"));
  expect(main.queryByRole("heading", { name: "Conversation 1" })).toBeNull();
  expect(main.queryByText("fixture")).toBeNull();
  expect(main.getByText("Connected")).toBeTruthy();
  expect(main.queryByText("idle")).toBeNull();
  expect(main.queryByText("Session", { exact: true })).toBeNull();
  const options = main.getByLabelText("Session options");
  fireEvent.click(options); flush();
  fireEvent.click(main.getByRole("button", { name: "Reattach" })); flush();
  expect(JSON.parse(socket.send.mock.calls.at(-1)![0]).action).toEqual({ type: "subscribe", sessionId: a });
});

it("keeps drafts, command IDs and uncertainty independent across sessions", () => {
  const sent: BrowserMessage[] = [];
  const first = createSessionModel(a, message => { sent.push(message); return true; }, () => true);
  const second = createSessionModel(b, message => { sent.push(message); return true; }, () => true);
  for (const model of [first, second]) { for (const frame of frames(model.id)) model.receive(frame); }
  flush(); first.setDraft("draft A"); second.setDraft("draft B"); flush(); first.submit(); flush();
  expect(sent).toHaveLength(1); expect(sent[0].sessionId).toBe(a); expect(second.pending()).toBe(false);
  first.disconnected(); flush(); expect(first.draft()).toBe("draft A"); expect(second.draft()).toBe("draft B");
  expect(first.notice()).toContain("uncertain"); expect(second.notice()).toBe("");
  first.stopped(); flush(); expect(first.draft()).toBe("draft A"); expect(first.state.order).toHaveLength(0);
});

it("rejects stale attachment errors before workspace subscription bookkeeping", () => {
  const model = createSessionModel(a, () => true, () => true);
  for (const frame of frames(a)) model.receive(frame); flush();
  const stale: ServerMessage = { v: 1, sessionId: a, epoch: "obsolete", body: { type: "error", code: "subscription_closed" } };
  expect(model.receive(stale)).toBe(false); flush(); expect(model.state.synced).toBe(true);
  expect(model.receive({ ...stale, epoch })).toBe(true); flush(); expect(model.state.synced).toBe(false);
  for (const frame of frames(a)) model.receive(frame); flush();
  expect(model.notice()).toBe(""); expect(model.state.synced).toBe(true);
});

it("validates catalog bounds, IDs, lifecycle and runtime summaries", () => {
  expect(decodeWorkspace(JSON.stringify(catalog())).sessions).toHaveLength(2);
  for (const value of [
    { ...catalog(), selected: b + "x" },
    { ...catalog(), target: "not-an-id" },
    { ...catalog(), target: "10000000-0000-4000-8000-000000000003" },
    { ...catalog(), requestId: "create", code: "created" },
    { ...catalog(), sessions: [item(a, "A"), item(a, "duplicate")] },
    { ...catalog(), sessions: [{ ...item(a, "A"), lifecycle: "stopped" }] },
    { ...catalog(), sessions: [{ ...item(a, "A"), runtime: { epoch, process: "invented", activity: "idle" } }] },
    { ...catalog(), sessions: Array.from({ length: 33 }, () => item(a, "A")) },
  ]) expect(() => decodeWorkspace(JSON.stringify(value))).toThrow();
});

it.each(["create_in", "open"] as const)("selects the %s target even when the catalog selection has moved", async (type) => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]; socket.onopen?.(); socket.emit(catalog());
  for (const id of [a, b]) for (const frame of frames(id)) socket.emit(frame);
  // Complete automatic subscriptions so explicit management commands can be sent.
  for (const [wire] of [...socket.send.mock.calls]) {
    const message = JSON.parse(wire);
    socket.emit({ ...catalog(), requestId: message.requestId });
  }
  fireEvent.click(page.getByRole("button", { name: type === "create_in" ? "New conversation" : /Conversation 2/ })); flush();
  const request = socket.send.mock.calls.map(([wire]) => JSON.parse(wire)).find(message => message.action.type === type);
  expect(request).toBeDefined();
  socket.emit({ ...catalog(), requestId: request.requestId, code: type === "create_in" ? "created" : "opened", target: b });
  expect(page.getByRole("button", { name: /Conversation 2/ }).getAttribute("aria-pressed")).toBe("true");
});

it("remembers a stopped conversation's workspace without opening it or applying older selections", async () => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]; socket.onopen?.();
  const value = { ...grouped(), sessions: [item(a, "Conversation 1"), { ...item(b, "Conversation 2", wb), lifecycle: "stopped", runtime: null }] };
  socket.emit(value); for (const frame of frames(a)) socket.emit(frame);
  fireEvent.click(page.getByRole("button", { name: /Conversation 1/ })); flush();
  const request = socket.send.mock.calls.map(([wire]) => JSON.parse(wire)).find(message => message.action.type === "open");
  fireEvent.click(page.getByRole("button", { name: /Conversation 2/ })); flush();
  const sent = socket.send.mock.calls.map(([wire]) => JSON.parse(wire));
  const selection = sent.find(message => message.action.type === "select_workspace");
  expect(selection?.action.workspaceId).toBe(wb);
  expect(sent.filter(message => message.action.type === "open")).toHaveLength(1);
  socket.emit({ ...value, requestId: request.requestId, code: "opened", target: a });
  expect(page.getByRole("button", { name: /Conversation 2/ }).getAttribute("aria-pressed")).toBe("true");
  socket.emit({ ...value, requestId: selection.requestId, code: "workspace_selected", selectedWorkspace: wb, selected: b, target: b });
  expect(page.getByRole("button", { name: /Conversation 2/ }).getAttribute("aria-pressed")).toBe("true");
});

it("keeps slash catalogs and completion state tied to the selected conversation", async () => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]; socket.onopen?.(); socket.emit(catalog());
  for (const id of [a, b]) {
    for (const frame of frames(id)) socket.emit(frame);
    socket.emit({ v: 1, sessionId: id, epoch, body: { type: "commands", commands: [
      { name: id === a ? "review" : "release", description: null, source: "extension" },
    ] } });
  }
  function openMenu() {
    const input = page.getByLabelText("Message Pi") as HTMLTextAreaElement;
    input.focus(); fireEvent.input(input, { target: { value: "/", selectionStart: 1, selectionEnd: 1 } }); flush();
  }
  openMenu(); expect(within(page.getByRole("listbox")).getByRole("option").textContent).toContain("/review");
  fireEvent.click(page.getByRole("button", { name: /Conversation 2/ })); flush();
  expect(page.queryByRole("listbox")).toBeNull();
  openMenu(); expect(within(page.getByRole("listbox")).getByRole("option").textContent).toContain("/release");
  fireEvent.keyDown(page.getByLabelText("Message Pi"), { key: "Tab" }); flush();
  expect((page.getByLabelText("Message Pi") as HTMLTextAreaElement).value).toBe("/release ");
  fireEvent.click(page.getByRole("button", { name: /Conversation 1/ })); flush();
  expect((page.getByLabelText("Message Pi") as HTMLTextAreaElement).value).toBe("/");
  openMenu(); expect(within(page.getByRole("listbox")).getByRole("option").textContent).toContain("/review");
  expect(socket.send.mock.calls.map(([wire]) => JSON.parse(wire)).some(message => message.action.type === "prompt")).toBe(false);
});

it("switches workspaces without sharing drafts or mounting inactive conversations", async () => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  const page = render(() => <App />);
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]; socket.onopen?.(); socket.emit(catalog());
  socket.emit(grouped());
  for (const id of [a, b]) for (const frame of frames(id)) socket.emit(frame);
  fireEvent.input(page.getByLabelText("Message Pi"), { target: { value: "only A" } }); flush();
  fireEvent.click(page.getByRole("button", { name: /Conversation 2/ })); flush();
  expect((page.getByLabelText("Message Pi") as HTMLTextAreaElement).value).toBe("");
  fireEvent.input(page.getByLabelText("Message Pi"), { target: { value: "only B" } }); flush();
  fireEvent.click(page.getByRole("button", { name: /Conversation 1/ })); flush();
  expect((page.getByLabelText("Message Pi") as HTMLTextAreaElement).value).toBe("only A");
  expect(page.getAllByRole("region", { name: "Conversation" })).toHaveLength(1);
  fireEvent.click(page.getByRole("button", { name: "Send" })); flush();
  const messages = socket.send.mock.calls.map(call => JSON.parse(call[0]));
  expect(messages.filter(message => message.action.type === "prompt")).toMatchObject([{ sessionId: a, action: { text: "only A" } }]);
});
