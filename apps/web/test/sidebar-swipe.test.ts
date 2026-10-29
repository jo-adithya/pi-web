import { afterEach, expect, it, vi } from "vitest";
import { fireEvent } from "@solidjs/testing-library";
import { listenForSidebarSwipes } from "../src/sidebar-swipe";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.restoreAllMocks(); });

function setup() {
  const main = document.createElement("main"); main.className = "chat-panel";
  document.body.append(main);
  let enabled = true, open = false;
  const changed = vi.fn((value: boolean) => { open = value; });
  dispose = listenForSidebarSwipes(() => enabled, () => open, changed);
  const point = (x: number, y = 100, identifier = 1) => ({ identifier, clientX: x, clientY: y });
  return {
    main, changed, point,
    disable: () => { enabled = false; },
    start: (target = main) => fireEvent.touchStart(target, { touches: [point(100)] }),
    end: (x = 220, y = 100, target = main) => fireEvent.touchEnd(target, { touches: [], changedTouches: [point(x, y)] }),
  };
}

it("ignores short, wrong-direction, diagonal and vertical gestures", () => {
  const s = setup();
  for (const [x, y] of [[140, 100], [20, 100], [180, 190], [100, 240]]) {
    s.start(); s.end(x, y);
  }
  expect(s.changed).not.toHaveBeenCalled();
  s.start(); s.end(164);
  expect(s.changed).toHaveBeenCalledExactlyOnceWith(true);
});

it("abandons scrolling, multi-touch and canceled gestures", () => {
  const s = setup();
  s.start(); fireEvent.touchMove(s.main, { touches: [s.point(105, 140)] }); s.end();
  s.start(); fireEvent.touchStart(s.main, { touches: [s.point(100), s.point(120, 100, 2)] }); s.end();
  s.start(); fireEvent.touchCancel(s.main); s.end();
  expect(s.changed).not.toHaveBeenCalled();
});

it("preserves editing and horizontally scrollable content", () => {
  const s = setup();
  for (const tag of ["input", "textarea", "select"]) {
    const input = document.createElement(tag); s.main.append(input);
    s.start(input); s.end(220, 100, input);
  }
  const code = document.createElement("pre"); code.style.overflowX = "auto"; s.main.append(code);
  Object.defineProperties(code, { scrollWidth: { value: 400 }, clientWidth: { value: 200 } });
  s.start(code); s.end(220, 100, code);
  expect(s.changed).not.toHaveBeenCalled();
});

it("respects disabled state at both ends and removes listeners on cleanup", () => {
  const s = setup();
  s.start(); s.disable(); s.end();
  s.start(); s.end();
  expect(s.changed).not.toHaveBeenCalled();
  dispose?.();
  const next = setup(); dispose?.(); next.start(); next.end();
  expect(next.changed).not.toHaveBeenCalled();
});

it("keeps a gesture from toggling twice and rejects a different finger", () => {
  const s = setup();
  s.start(); fireEvent.touchEnd(s.main, { touches: [], changedTouches: [s.point(220, 100, 2)] });
  expect(s.changed).not.toHaveBeenCalled();
  s.start(); s.end(); s.end(20);
  expect(s.changed).toHaveBeenCalledExactlyOnceWith(true);
});
