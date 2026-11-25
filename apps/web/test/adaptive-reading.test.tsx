import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { SessionView } from "../src/SessionView";
import { createSessionModel } from "../src/session-model";
import { initialState } from "../src/client-state";
import type { DisplayMessage } from "../src/generated/protocol";

const id = "10000000-0000-4000-8000-000000000001", epoch = "20000000-0000-4000-8000-000000000001";
const pending: DisplayMessage = { id: "answer", role: "assistant", complete: true, error: null, truncated: false, blocks: [{ kind: "text", text: "Pi’s exact reply." }], presentation: { state: "pending" } };
const ready: DisplayMessage = { ...pending, blocks: [], sourceKey: "a".repeat(64), presentation: { state: "ready", response: { summary: "A short explanation.", canvas: { layout: "explanation", headline: "Core result", focus: null }, blocks: [] } } };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup(message: DisplayMessage) {
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1234);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this.classList.contains("simple-response-content") ? 300 : this.classList.contains("transcript") ? 50 : 0, 300,
      this.classList.contains("simple-response-content") ? 900 : this.classList.contains("composer") ? 180 : 0);
  });
  const model = createSessionModel(id, () => true, () => true); model.scroll = 100;
  model.receive({ v: 1, sessionId: id, epoch, body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: id, epoch, body: { type: "snapshot", throughSeq: 0, messages: [message], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } } });
  const view = render(() => <SessionView model={model} />); flush();
  (view.getByRole("region", { name: "Simple answer" }) as HTMLElement).style.scrollMarginTop = "75px";
  const scroller = view.container.querySelector<HTMLDivElement>(".transcript")!;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 495 });
  scroller.scrollTop = 100;
  const reveal = () => { model.receive({ v: 1, sessionId: id, epoch, body: { type: "event", seq: 1, patches: [{ kind: "message", message: ready }], dialogs: [], olderHistory: false, status: { ...model.state.status } } }); flush(); };
  return { model, reveal, view, scroller };
}
it("starts a newly revealed tall canvas at its core result instead of its footer", () => {
  const { model, reveal, scroller } = setup(pending); reveal();
  expect(scroller.scrollTop).toBe(275);
  expect(document.documentElement.scrollTop).toBe(0);
  expect(model.stick()).toBe(false);
});
it("respects a reader who paused following before the canvas arrived", () => {
  const { model, reveal, scroller } = setup(pending); model.setStick(false); flush(); reveal();
  expect(scroller.scrollTop).toBe(100);
  expect(model.stick()).toBe(false);
});
it("leaves Original in place when formatting finishes in the background", () => {
  const { model, reveal, view, scroller } = setup(pending);
  const toggle = view.getByRole("button", { name: "View original" });
  toggle.focus(); fireEvent.click(toggle); flush();
  const original = view.getByText("Pi’s exact reply.");
  reveal();
  expect(view.getByRole("region", { name: "Original answer" })).toBeTruthy();
  expect(view.getByText("Pi’s exact reply.")).toBe(original);
  expect(document.activeElement).toBe(toggle);
  expect(scroller.scrollTop).toBe(100);
  expect(model.stick()).toBe(false);
});
it("does not jump when mounting an already saved canvas", () => {
  const { model, scroller } = setup(ready);
  expect(scroller.scrollTop).toBe(100);
  expect(model.stick()).toBe(true);
});
