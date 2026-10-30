import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { SessionView } from "../src/SessionView";
import { createSessionModel } from "../src/session-model";
import { initialState } from "../src/client-state";

class Observer implements ResizeObserver {
  static instances: Observer[] = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(private callback: ResizeObserverCallback) { Observer.instances.push(this); }
  resize() { this.callback([], this); }
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
beforeEach(() => {
  Observer.instances = [];
  frames = new Map(); nextFrame = 0;
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback); return nextFrame;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => { frames.delete(id); }));
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  Reflect.deleteProperty(document.documentElement, "scrollHeight");
  Reflect.deleteProperty(document.documentElement, "clientHeight");
  document.documentElement.scrollTop = 0;
});

function runFrame() {
  const pending = [...frames.values()]; frames.clear();
  for (const callback of pending) callback(0);
}

function setup(stick = true, transport = () => true) {
  const model = createSessionModel("session", transport, () => true);
  model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "snapshot", throughSeq: 0,
    messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } } });
  model.setStick(stick); model.scroll = 120;
  const view = render(() => <SessionView model={model} />); flush();
  const scroller = document.documentElement;
  let height = 1000;
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, value: 200 },
  });
  return { model, view, scroller, grow: (value: number) => { height = value; } };
}

it.each([false, true])("uses page scrolling with mobile=%s, including pause, jump and saved position", mobile => {
  vi.mocked(matchMedia).mockImplementation(query => ({
    matches: mobile, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }) as unknown as MediaQueryList);
  const root = document.documentElement;
  const { model, view, grow } = setup();
  grow(2000);
  const transcript = view.container.querySelector<HTMLDivElement>(".transcript")!;
  runFrame();
  expect(root.scrollTop).toBe(2000);
  expect(transcript.scrollTop).toBe(0);
  expect(view.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  root.scrollTop = 300; fireEvent.scroll(window); flush();
  expect(model.stick()).toBe(false);
  fireEvent.click(view.getByRole("button", { name: "Jump to latest" })); flush();
  expect(root.scrollTop).toBe(2000);
  expect(model.stick()).toBe(true);
  expect(view.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  root.scrollTop = 450;
  view.unmount();
  expect(model.scroll).toBe(450);
  Reflect.deleteProperty(root, "scrollHeight");
  Reflect.deleteProperty(root, "clientHeight");
});

it("observes content and viewport size, coalescing growth into one scroll per frame", () => {
  const { view, scroller, grow } = setup();
  runFrame(); expect(scroller.scrollTop).toBe(1000);
  expect(Observer.instances).toHaveLength(1);
  const observer = Observer.instances[0];
  expect(observer.observe.mock.calls.map(([element]) => element)).toEqual(expect.arrayContaining([
    view.container.querySelector(".transcript"), view.container.querySelector(".reading"),
  ]));
  vi.mocked(requestAnimationFrame).mockClear();
  grow(1400); observer.resize();
  grow(1800); observer.resize(); observer.resize();
  expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  expect(scroller.scrollTop).toBe(1000);
  runFrame(); expect(scroller.scrollTop).toBe(1800);
  grow(2100); observer.resize(); runFrame();
  expect(scroller.scrollTop).toBe(2100);
});

it("does not schedule scrolling for sequence updates without a resize", () => {
  const { model } = setup(); runFrame();
  vi.mocked(requestAnimationFrame).mockClear();
  model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "event", seq: 1,
    patches: [], dialogs: [], olderHistory: false, status: model.state.status } }); flush();
  expect(requestAnimationFrame).not.toHaveBeenCalled();
});

it("pauses after scrolling up, including pending frames, and resumes at the bottom", () => {
  const { model, scroller, grow } = setup(); runFrame();
  const observer = Observer.instances[0];
  grow(1400); observer.resize();
  scroller.scrollTop = 100; fireEvent.scroll(window); flush();
  expect(model.stick()).toBe(false);
  runFrame(); expect(scroller.scrollTop).toBe(100);
  vi.mocked(requestAnimationFrame).mockClear();
  grow(1800); observer.resize();
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  scroller.scrollTop = 1600; fireEvent.scroll(window); flush();
  expect(model.stick()).toBe(true);
  grow(2100); observer.resize(); runFrame();
  expect(scroller.scrollTop).toBe(2100);
});

it("does not snap small upward scrolls back to the bottom without content growth", () => {
  const { scroller } = setup(); runFrame();
  vi.mocked(requestAnimationFrame).mockClear();
  scroller.scrollTop = 770; fireEvent.scroll(window); flush();
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  runFrame(); expect(scroller.scrollTop).toBe(770);
});

it("restores a paused position and jump-to-latest resumes following growth", () => {
  const { model, view, scroller, grow } = setup(false);
  runFrame(); expect(scroller.scrollTop).toBe(120);
  const observer = Observer.instances[0];
  grow(1400); observer.resize(); runFrame();
  expect(scroller.scrollTop).toBe(120);
  fireEvent.click(view.getByRole("button", { name: "Jump to latest" })); flush();
  expect(model.stick()).toBe(true);
  expect(scroller.scrollTop).toBe(1400);
  grow(1800); observer.resize(); runFrame();
  expect(scroller.scrollTop).toBe(1800);
});

it.each(["Enter", "Send"])("scrolls to the bottom when %s sends from a paused transcript without a resize", action => {
  const { model, view, scroller } = setup(false);
  runFrame(); expect(scroller.scrollTop).toBe(120);
  model.setDraft("Hello"); flush();
  if (action === "Enter") fireEvent.keyDown(view.getByLabelText("Message Pi"), { key: "Enter" });
  else fireEvent.click(view.getByRole("button", { name: "Send" }));
  flush();
  expect(model.pending()).toBe(true);
  expect(model.stick()).toBe(true);
  runFrame();
  expect(scroller.scrollTop).toBe(1000);
  expect(view.queryByRole("button", { name: "Jump to latest" })).toBeNull();
});

it("scrolls on send even when following is already enabled near the bottom", () => {
  const { model, view, scroller } = setup(); runFrame();
  scroller.scrollTop = 750; fireEvent.scroll(scroller); flush();
  expect(model.stick()).toBe(true);
  model.setDraft("Hello"); flush();
  fireEvent.keyDown(view.getByLabelText("Message Pi"), { key: "Enter" }); flush();
  runFrame(); expect(scroller.scrollTop).toBe(1000);
});

it.each(["empty", "disconnected", "rejected transport"])("keeps the reading position when a prompt is not sent: %s", reason => {
  const { model, view, scroller } = setup(false, () => reason !== "rejected transport"); runFrame();
  if (reason !== "empty") model.setDraft("Hello");
  if (reason === "disconnected") model.disconnected();
  flush();
  fireEvent.keyDown(view.getByLabelText("Message Pi"), { key: "Enter" }); flush();
  expect(model.pending()).toBe(false);
  expect(model.stick()).toBe(false);
  runFrame(); expect(scroller.scrollTop).toBe(120);
});

it("disconnects the observer, cancels pending scrolling, and saves position on unmount", () => {
  const { model, view, scroller } = setup(); runFrame();
  const observer = Observer.instances[0];
  scroller.scrollTop = 345; observer.resize();
  const frame = nextFrame;
  const pending = frames.get(frame)!;
  view.unmount();
  expect(observer.disconnect).toHaveBeenCalledOnce();
  expect(cancelAnimationFrame).toHaveBeenCalledWith(frame);
  expect(model.scroll).toBe(345);
  pending(0); observer.resize();
  expect(scroller.scrollTop).toBe(345);
  expect(frames.size).toBe(0);
});
