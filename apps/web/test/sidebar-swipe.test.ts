import { afterEach, expect, it, vi } from "vitest";
import { fireEvent } from "@solidjs/testing-library";
import { listenForSidebarSwipes } from "../src/sidebar-swipe";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });

function setup(open = false) {
  vi.useFakeTimers();
  const main = document.createElement("main"); main.className = open ? "sidebar-drawer" : "chat-panel";
  document.body.append(main);
  let enabled = true;
  const changed = vi.fn((value: boolean) => { open = value; });
  const progress = vi.fn();
  dispose = listenForSidebarSwipes(() => enabled, () => open, changed, progress);
  const point = (x: number, y = 100, identifier = 1) => ({ identifier, clientX: x, clientY: y });
  return {
    main, changed, progress, point,
    disable: () => { enabled = false; },
    start: (x = 10, target = main) => fireEvent.touchStart(target, { touches: [point(x)] }),
    move: (x: number, y = 100, target = main) => fireEvent.touchMove(target, { touches: [point(x, y)] }),
    end: (x = 210, target = main) => fireEvent.touchEnd(target, { touches: [], changedTouches: [point(x)] }),
  };
}

it("tracks intermediate edge progress, claims only horizontal travel and commits on release", () => {
  const s = setup(); s.start();
  expect(s.move(15)).toBe(true);
  expect(s.progress).not.toHaveBeenCalled();
  expect(s.move(165)).toBe(false);
  expect(s.progress).toHaveBeenLastCalledWith({ progress: 0.5, dragging: true });
  expect(s.changed).not.toHaveBeenCalled();
  s.end();
  expect(s.changed).toHaveBeenCalledExactlyOnceWith(true);
  expect(s.progress).toHaveBeenLastCalledWith({ progress: 1, dragging: false });
  vi.runAllTimers(); expect(s.progress).toHaveBeenLastCalledWith(null);
});

it.each([10, 128, 200, 280])("opens from anywhere in the conversation, starting at %ipx", x => {
  const s = setup(); s.start(x); s.move(x + 100); s.end(x + 100);
  expect(s.changed).toHaveBeenCalledExactlyOnceWith(true);
});

it("closes when swiping left on the backdrop", () => {
  const s = setup(true); s.main.className = "sidebar-overlay";
  s.start(380); s.move(220); s.end(220);
  expect(s.changed).toHaveBeenCalledExactlyOnceWith(false);
});

it("rejects opening outside the chat panel and closes from the drawer", () => {
  const s = setup(); s.main.className = "unrelated"; s.start(150); s.move(350); s.end(350);
  expect(s.progress).not.toHaveBeenCalled(); expect(s.changed).not.toHaveBeenCalled();
  dispose?.(); const c = setup(true); c.start(250); c.move(95); c.end(95);
  expect(c.progress).toHaveBeenCalledWith({ progress: 0.5, dragging: true });
  expect(c.changed).toHaveBeenCalledExactlyOnceWith(false);
});

it("snaps short drags back and cancels claimed drags without changing state", () => {
  const s = setup(); s.start(); s.move(40); s.end(40);
  expect(s.changed).not.toHaveBeenCalled();
  expect(s.progress).toHaveBeenLastCalledWith({ progress: 0, dragging: false });
  vi.runAllTimers(); s.start(); s.move(210); fireEvent.touchCancel(s.main);
  expect(s.changed).not.toHaveBeenCalled();
  expect(s.progress).toHaveBeenLastCalledWith({ progress: 0, dragging: false });
});

it("leaves vertical, wrong-direction, diagonal and multitouch movement native", () => {
  const s = setup();
  for (const [x, y] of [[5, 150], [-40, 100], [60, 145]]) {
    s.start(); expect(s.move(x, y)).toBe(true); s.end();
  }
  s.start(); fireEvent.touchMove(s.main, { touches: [s.point(150), s.point(120, 100, 2)] }); s.end();
  expect(s.changed).not.toHaveBeenCalled(); expect(s.progress).not.toHaveBeenCalled();
});

it("preserves editing, horizontal scrolling and other modals", () => {
  const s = setup();
  for (const tag of ["input", "textarea", "select"]) {
    const input = document.createElement(tag); s.main.append(input);
    s.start(10, input); s.move(210, 100, input); s.end(210, input);
  }
  const code = document.createElement("pre"); code.style.overflowX = "auto"; s.main.append(code);
  Object.defineProperties(code, { scrollWidth: { value: 400 }, clientWidth: { value: 200 } });
  s.start(10, code); s.move(210, 100, code); s.end(210, code);
  const modal = document.createElement("div"); modal.setAttribute("role", "dialog"); document.body.append(modal);
  s.start(); s.move(210); s.end();
  expect(s.changed).not.toHaveBeenCalled(); expect(s.progress).not.toHaveBeenCalled();
});

it("cancels when disabled, suppresses drag clicks, and cleans up timers and listeners", () => {
  const s = setup(); s.start(); s.move(210); s.disable(); s.end();
  expect(s.changed).not.toHaveBeenCalled();
  const clicked = vi.fn(); s.main.addEventListener("click", clicked);
  fireEvent.click(s.main, { detail: 1 }); expect(clicked).not.toHaveBeenCalled();
  fireEvent.click(s.main, { detail: 0 }); expect(clicked).toHaveBeenCalledOnce();
  dispose?.(); s.progress.mockClear(); vi.runAllTimers(); s.start(); s.move(210); s.end();
  expect(s.progress).not.toHaveBeenCalled();
  fireEvent.click(s.main, { detail: 1 }); expect(clicked).toHaveBeenCalledTimes(2);
});

it("clamps overshoot, restores an open drawer on cancellation and rejects a different finger", () => {
  const s = setup(true); s.start(250); s.move(-200);
  expect(s.progress).toHaveBeenLastCalledWith({ progress: 0, dragging: true });
  fireEvent.touchEnd(s.main, { touches: [], changedTouches: [s.point(0, 100, 2)] });
  expect(s.changed).not.toHaveBeenCalled();
  expect(s.progress).toHaveBeenLastCalledWith({ progress: 1, dragging: false });
  vi.runAllTimers(); s.start(250); s.move(220); s.end(220);
  expect(s.changed).not.toHaveBeenCalled();
});

it("uses the measured drawer width and clears reduced-motion snaps without a delay", () => {
  const s = setup(true);
  vi.spyOn(s.main, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 800));
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  s.start(180); s.move(80);
  expect(s.progress).toHaveBeenLastCalledWith({ progress: 0.5, dragging: true });
  s.end(80); vi.advanceTimersByTime(0);
  expect(s.progress).toHaveBeenLastCalledWith(null);
  expect(s.changed).toHaveBeenCalledExactlyOnceWith(false);
});

it("cancels on viewport resize and removes its active progress on disposal", () => {
  const s = setup(); s.start(); s.move(165);
  fireEvent(window, new Event("resize"));
  expect(s.progress).toHaveBeenLastCalledWith({ progress: 0, dragging: false });
  vi.runAllTimers(); s.start(); s.move(165); dispose?.();
  expect(s.progress).toHaveBeenLastCalledWith(null);
  expect(s.changed).not.toHaveBeenCalled();
});
