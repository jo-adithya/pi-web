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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function runFrame() {
  const pending = [...frames.values()]; frames.clear();
  for (const callback of pending) callback(0);
}

function setup(stick = true) {
  const model = createSessionModel("session", () => true, () => true);
  model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "snapshot", throughSeq: 0,
    messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } } });
  model.setStick(stick); model.scroll = 120;
  const view = render(() => <SessionView model={model} />); flush();
  const scroller = view.container.querySelector<HTMLDivElement>(".transcript")!;
  let height = 1000;
  Object.defineProperties(scroller, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 200 },
  });
  return { model, view, scroller, grow: (value: number) => { height = value; } };
}

it("observes content and viewport size, coalescing growth into one scroll per frame", () => {
  const { view, scroller, grow } = setup();
  runFrame(); expect(scroller.scrollTop).toBe(1000);
  expect(Observer.instances).toHaveLength(1);
  const observer = Observer.instances[0];
  expect(observer.observe.mock.calls.map(([element]) => element)).toEqual(expect.arrayContaining([
    scroller, view.container.querySelector(".reading"),
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
  scroller.scrollTop = 100; fireEvent.scroll(scroller); flush();
  expect(model.stick()).toBe(false);
  runFrame(); expect(scroller.scrollTop).toBe(100);
  vi.mocked(requestAnimationFrame).mockClear();
  grow(1800); observer.resize();
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  scroller.scrollTop = 1600; fireEvent.scroll(scroller); flush();
  expect(model.stick()).toBe(true);
  grow(2100); observer.resize(); runFrame();
  expect(scroller.scrollTop).toBe(2100);
});

it("does not snap small upward scrolls back to the bottom without content growth", () => {
  const { scroller } = setup(); runFrame();
  vi.mocked(requestAnimationFrame).mockClear();
  scroller.scrollTop = 770; fireEvent.scroll(scroller); flush();
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
