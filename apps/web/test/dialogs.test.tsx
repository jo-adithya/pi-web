import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, flush, Show } from "solid-js";
import { ExtensionDialog } from "../src/components/ExtensionDialog";
import { ConfirmationDialog } from "../src/components/ActionDialog";
import { SessionView } from "../src/SessionView";
import { createSessionModel } from "../src/session-model";
import { initialState } from "../src/client-state";
import type { BrowserMessage, Dialog, ServerBody } from "../src/generated/protocol";

beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);

function extension(kind: Dialog["kind"], initial = "") {
  const answer = vi.fn();
  const [open, setOpen] = createSignal(true);
  render(() => <Show when={open()}><ExtensionDialog dialog={{ id: "test", kind, title: "Extension request", message: "Please respond", options: ["First", "Second"], initial }} answer={value => { answer(value); setOpen(false); }} /></Show>);
  flush();
  return answer;
}

it.each(["escape", "outside", "cancel", "no", "confirm"])("distinguishes extension %s from a negative answer", method => {
  const answer = extension("confirm");
  expect(answer).not.toHaveBeenCalled();
  if (method === "escape") fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  else if (method === "outside") fireEvent.click(document.querySelector(".action-overlay")!);
  else fireEvent.click(screen.getByRole("button", { name: method === "cancel" ? "Cancel" : method === "no" ? "No" : "Confirm" }));
  flush();
  expect(answer).toHaveBeenCalledExactlyOnceWith(method === "no" || method === "confirm" ? { type: "confirmed", confirmed: method === "confirm" } : { type: "cancelled" });
});

it("requires an advertised nonempty extension choice", async () => {
  const answer = extension("select", "unknown");
  const send = screen.getByRole("button", { name: "Send response" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.submit(send.closest("form")!); flush(); expect(answer).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("button", { name: /^Choose an option/ }), { key: "Enter" }); flush();
  fireEvent.keyDown(screen.getByRole("option", { name: "Second" }), { key: "Enter" }); flush();
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(send.disabled).toBe(false);
  fireEvent.submit(send.closest("form")!); flush();
  expect(answer).toHaveBeenCalledExactlyOnceWith({ type: "value", value: "Second" });
});

it("wraps keyboard focus when the final confirmation action is disabled", async () => {
  render(() => <ConfirmationDialog title="Stale action" description="This action is no longer available." action="Confirm" disabled close={() => {}} confirm={() => {}} />);
  const cancel = screen.getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  expect(fireEvent.keyDown(cancel, { key: "Tab" })).toBe(false);
  expect(document.activeElement).toBe(cancel);
  expect(fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(cancel);
});

it("keeps portaled choices exposed to assistive technology inside a modal", async () => {
  extension("select");
  const trigger = screen.getByRole("button", { name: /^Choose an option/ });
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  fireEvent.keyDown(trigger, { key: "Enter" }); flush();
  await waitFor(() => expect(document.activeElement?.closest('[role="listbox"]')).not.toBeNull());
  const listbox = document.querySelector('[role="listbox"]')!;
  expect(listbox.closest('[aria-hidden="true"]')).toBeNull();
  expect(screen.getByRole("option", { name: "First" })).toBeTruthy();
});

it.each(["input", "editor"] as const)("enforces the UTF-8 extension %s limit even on programmatic submission", kind => {
  const answer = extension(kind);
  const input = screen.getByRole("textbox", { name: "Response" });
  const send = screen.getByRole("button", { name: "Send response" }) as HTMLButtonElement;
  fireEvent.input(input, { target: { value: "é".repeat(8193) } }); flush();
  expect(send.disabled).toBe(true); fireEvent.submit(input.closest("form")!); flush(); expect(answer).not.toHaveBeenCalled();
  fireEvent.input(input, { target: { value: "é".repeat(8192) } }); flush();
  expect(send.disabled).toBe(false); fireEvent.submit(input.closest("form")!); flush();
  expect(answer).toHaveBeenCalledExactlyOnceWith({ type: "value", value: "é".repeat(8192) });
});

it.each(["terminate", "restart"] as const)("revalidates %s eligibility and runtime before explicit approval", async kind => {
  const transport = vi.fn((_message: BrowserMessage) => true);
  const model = createSessionModel("session", transport, () => true);
  const receive = (body: ServerBody, epoch = "first") => { model.receive({ v: 1, sessionId: "session", epoch, body }); flush(); };
  receive({ type: "hello", project: "fixture", process: "ready" });
  const status = { ...initialState().status, process: kind === "restart" ? "exited" as const : "ready" as const, cancelUnconfirmed: kind === "terminate" };
  receive({ type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status });
  render(() => <SessionView model={model} />); flush();
  const open = () => { fireEvent.click(screen.getByRole("button", { name: kind === "terminate" ? "Terminate process…" : "Restart Pi…" })); flush(); };
  open(); expect(transport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); flush();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(transport).not.toHaveBeenCalled(); open();
  receive({ type: "hello", project: "fixture", process: "ready" }, "second");
  receive({ type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status }, "second");
  const confirm = screen.getByRole("button", { name: kind === "terminate" ? "Terminate Pi" : "Restart Pi" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true); fireEvent.click(confirm); flush(); expect(transport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); flush();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); open();
  fireEvent.click(screen.getByRole("button", { name: kind === "terminate" ? "Terminate Pi" : "Restart Pi" })); flush();
  expect(transport.mock.calls.at(-1)?.[0].action).toEqual({ type: kind, confirmed: true });
});

it("dismisses a nested choice before cancelling its parent on the next Escape", async () => {
  const answer = extension("select");
  const trigger = screen.getByRole("button", { name: /^Choose an option/ });
  trigger.focus(); fireEvent.keyDown(trigger, { key: "Enter" }); flush();
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" }); flush();
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(answer).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  fireEvent.keyDown(trigger, { key: "Escape" }); flush();
  expect(answer).toHaveBeenCalledExactlyOnceWith({ type: "cancelled" });
});
