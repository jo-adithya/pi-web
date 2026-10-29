import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, screen, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { SessionView } from "../src/SessionView";
import { createSessionModel } from "../src/session-model";
import { initialState, decodeServer } from "../src/client-state";
import type { AgentSettings, BrowserMessage, ServerBody, ServerMessage } from "../src/generated/protocol";

const first = { id: "code-1", provider: "openai-codex", name: "Code One", images: true };
const second = { id: 'other"quoted', provider: "other-provider", name: "Other Model", images: false };
const settings: AgentSettings = { models: [first, second], model: first, thinkingLevel: "high", thinkingLevels: ["off", "low", "high", "max"], codexFast: "codex fast (requested)" };
const frame = (body: ServerBody, epoch = "epoch"): ServerMessage => ({ v: 1, sessionId: "session", epoch, body });
function setup() {
  const transport = vi.fn((_message: BrowserMessage) => true); const completed = vi.fn();
  const model = createSessionModel("session", transport, () => true, completed);
  model.receive(frame({ type: "hello", project: "fixture", process: "ready" }));
  model.receive(frame({ type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } }));
  model.receive(frame({ type: "settings", settings })); flush();
  return { model, transport, completed };
}
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);

it("renders confirmed model, advertised thinking levels and requested fast status", async () => {
  const { model, transport } = setup();
  const view = render(() => <SessionView model={model} />); flush();
  const picker = view.getByRole("button", { name: /^Model / }) as HTMLButtonElement;
  expect(picker.textContent).toContain("Code One");
  fireEvent.keyDown(picker, { key: "Enter" }); flush();
  expect(screen.getAllByRole("option").map(option => option.textContent?.replace("✓", ""))).toEqual(["Code One", "Other Model · other-provider"]);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" }); flush();
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  const thinking = view.getByRole("button", { name: /^Thinking level / }) as HTMLButtonElement;
  expect(thinking.textContent).toContain("high");
  fireEvent.keyDown(thinking, { key: "Enter" }); flush();
  expect(screen.getAllByRole("option").map(option => option.textContent?.replace("✓", ""))).toEqual(["off", "low", "high", "max"]);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" }); flush();
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  const fast = view.getByLabelText("Codex fast status");
  expect(fast.textContent).toBe("fast");
  const composer = view.getByLabelText("Message Pi").closest("form")!;
  expect(composer.contains(picker)).toBe(true);
  expect(composer.contains(thinking)).toBe(true);
  expect(composer.contains(fast)).toBe(true);
  expect(view.queryByText(/Type.*for commands/)).toBeNull();
  expect(view.queryByText("Enter to send")).toBeNull();
  await chooseOption(picker, "Other Model · other-provider");
  expect(picker.textContent).toContain("Code One");
  expect(transport.mock.calls.at(-1)?.[0].action).toEqual({ type: "set_model", provider: second.provider, modelId: second.id });
  expect(picker.disabled).toBe(true); expect(thinking.disabled).toBe(true);
  expect(model.state.settings.model).toEqual(first);
  model.setDraft("wait"); flush(); expect(model.canSend()).toBe(false);
  const request = transport.mock.calls.at(-1)![0];
  model.receive(frame({ type: "settings", settings: { ...settings, model: second, thinkingLevel: "off", thinkingLevels: ["off"], codexFast: null } }));
  model.receive(frame({ type: "result", result: { requestId: request.requestId, ok: true, code: "updated", disposition: null, recoveredDraft: null } })); flush();
  expect(picker.textContent).toContain("Other Model");
  expect(thinking.textContent).toContain("off");
  fireEvent.keyDown(thinking, { key: "Enter" }); flush(); expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" }); flush();
  expect(view.queryByLabelText("Codex fast status")).toBeNull(); expect(model.canSend()).toBe(true);
});

it("changes thinking only while idle and preserves confirmed controls on rejection", async () => {
  const { model, transport } = setup();
  const view = render(() => <SessionView model={model} />); flush();
  const thinking = view.getByRole("button", { name: /^Thinking level / }) as HTMLButtonElement;
  await chooseOption(thinking, "max");
  const request = transport.mock.calls.at(-1)![0];
  expect(request.action).toEqual({ type: "set_thinking_level", level: "max" });
  model.receive(frame({ type: "result", result: { requestId: request.requestId, ok: false, code: "settings_rejected", disposition: null, recoveredDraft: null } })); flush();
  expect(thinking.textContent).toContain("high");
  model.receive(frame({ type: "event", seq: 1, patches: [], dialogs: [], olderHistory: false, status: { ...model.state.status, activity: "running" } })); flush();
  expect(thinking.disabled).toBe(true);
  const before = transport.mock.calls.length; model.setThinkingLevel("low"); expect(transport.mock.calls).toHaveLength(before);
  model.disconnected(); flush(); expect(thinking.disabled).toBe(true);
});

it("validates bounded settings and completion frames, clears settings on hello", () => {
  const { model } = setup();
  expect(decodeServer(JSON.stringify(frame({ type: "settings", settings })))).toBeTruthy();
  for (const invalid of [
    { ...settings, models: Array(513).fill(first) },
    { ...settings, model: { ...first, id: "é".repeat(129) } },
    { ...settings, models: [{ ...first, provider: "bad\nprovider" }] },
    { ...settings, thinkingLevels: ["off", "off"] },
    { ...settings, thinkingLevel: "super" },
    { ...settings, thinkingLevel: ["high"] },
    { ...settings, thinkingLevels: [["high"]] },
    { ...settings, codexFast: "a".repeat(513) },
  ]) expect(() => decodeServer(JSON.stringify({ ...frame({ type: "settings", settings }), body: { type: "settings", settings: invalid } }))).toThrow();
  for (const runId of ["", "-1", "1.5", "1".repeat(21)]) expect(() => decodeServer(JSON.stringify({ ...frame({ type: "run_completed", runId: "1", outcome: "success" }), body: { type: "run_completed", runId, outcome: "success" } }))).toThrow();
  expect(() => decodeServer(JSON.stringify({ ...frame({ type: "run_completed", runId: "1", outcome: "aborted" }), body: { type: "run_completed", runId: "1", outcome: ["aborted"] } }))).toThrow();
  model.receive(frame({ type: "hello", project: "fixture", process: "ready" }, "new")); flush();
  expect(model.state.settings.models).toEqual([]); expect(model.state.settings.codexFast).toBeNull();
});

it("notifies once for live completion, never for snapshots, stale epochs or disconnected updates", () => {
  const { model, completed } = setup();
  const done = frame({ type: "run_completed", runId: "1", outcome: "success" });
  model.receive(done); model.receive(done); flush();
  expect(completed).toHaveBeenCalledExactlyOnceWith("session", "success");
  model.receive(frame({ type: "run_completed", runId: "2", outcome: "success" }, "old"));
  model.disconnected(); flush(); model.receive(frame({ type: "run_completed", runId: "2", outcome: "success" }));
  model.receive(frame({ type: "hello", project: "fixture", process: "ready" }));
  model.receive(frame({ type: "snapshot", throughSeq: 20, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready", lastOutcome: "success" } })); flush();
  model.receive(done); expect(completed).toHaveBeenCalledTimes(1);
  model.receive(frame({ type: "run_completed", runId: "3", outcome: "error" }));
  expect(completed).toHaveBeenLastCalledWith("session", "error");
});

async function chooseOption(trigger: HTMLElement, name: string) {
  fireEvent.keyDown(trigger, { key: "Enter" }); flush();
  fireEvent.keyDown(screen.getByRole("option", { name }), { key: "Enter" }); flush();
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}
