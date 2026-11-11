import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { createSessionModel } from "../src/session-model";
import { SessionView } from "../src/SessionView";
import { initialState } from "../src/client-state";
import type { BrowserMessage } from "../src/generated/protocol";

afterEach(cleanup);
it.each(["running", "retrying"] as const)("switches Stop and Steer Pi with the draft during %s", activity => {
  const transport = vi.fn((_message: BrowserMessage) => true);
  const model = createSessionModel("s", transport, () => true);
  model.receive({ v: 1, sessionId: "s", epoch: "e", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: "s", epoch: "e", body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready", activity } } });
  const page = render(() => <SessionView model={model} />); flush();
  const input = page.getByRole("combobox", { name: "Message Pi" });
  expect(page.getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(page.queryByRole("button", { name: "Steer Pi" })).toBeNull();
  fireEvent.input(input, { target: { value: "Keep the existing API" } }); flush();
  const steer = page.getByRole("button", { name: "Steer Pi" }) as HTMLButtonElement;
  expect(steer.type).toBe("submit");
  expect(steer.disabled).toBe(false);
  expect(steer.querySelector(".send-label")?.textContent).toBe("Steer Pi");
  expect(page.queryByRole("button", { name: "Stop" })).toBeNull();
  for (const value of ["", " \n "]) {
    fireEvent.input(input, { target: { value } }); flush();
    expect(page.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(page.queryByRole("button", { name: "Steer Pi" })).toBeNull();
    expect(model.draft()).toBe(value);
  }
  expect(transport).not.toHaveBeenCalled();
  fireEvent.click(page.getByRole("button", { name: "Stop" })); flush();
  expect(transport.mock.calls[0][0].action).toEqual({ type: "cancel" });
});

it("keeps Stop available when Pi cannot accept steering", () => {
  const model = createSessionModel("s", () => true, () => true);
  model.receive({ v: 1, sessionId: "s", epoch: "e", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: "s", epoch: "e", body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready", activity: "compacting" } } });
  model.setDraft("Save this correction");
  const page = render(() => <SessionView model={model} />); flush();
  expect(page.getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(page.queryByRole("button", { name: "Steer Pi" })).toBeNull();
  expect(model.draft()).toBe("Save this correction");
});

it("sends corrections during a run without stopping, clearing only an acknowledged draft", () => {
  const transport = vi.fn((_message: BrowserMessage) => true);
  const model = createSessionModel("s", transport, () => true);
  model.receive({ v: 1, sessionId: "s", epoch: "e", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: "s", epoch: "e", body: { type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready", activity: "running" } } });
  model.setDraft("Keep the existing API");
  const page = render(() => <SessionView model={model} />); flush();
  expect(page.getByRole("button", { name: "Steer Pi" }).textContent).toContain("Steer Pi");
  expect(page.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(page.getByRole("combobox", { name: "Message Pi" }).getAttribute("placeholder")).toBe("Guide Pi while it works…");
  fireEvent.click(page.getByRole("button", { name: "Steer Pi" })); flush();
  expect(transport).toHaveBeenCalledOnce();
  const message = transport.mock.calls[0][0];
  expect(message.action).toEqual({ type: "steer", text: "Keep the existing API", images: [] });
  expect(model.draft()).toBe("Keep the existing API");
  expect((page.getByRole("button", { name: "Sending…" }) as HTMLButtonElement).disabled).toBe(true);
  expect(page.queryByRole("button", { name: "Stop" })).toBeNull();
  model.receive({ v: 1, sessionId: "s", epoch: "e", body: { type: "result", result: { requestId: message.requestId, ok: true, code: "accepted", disposition: "queued", recoveredDraft: null } } }); flush();
  expect(model.draft()).toBe("");
  expect(page.getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(page.queryByRole("button", { name: "Steer Pi" })).toBeNull();
  expect(model.state.status.activity).toBe("running");
  model.setDraft("Another correction"); flush(); model.submit();
  model.disconnected(); flush();
  expect(model.draft()).toBe("Another correction");
  expect(model.visibleNotice()).toContain("uncertain");
});
