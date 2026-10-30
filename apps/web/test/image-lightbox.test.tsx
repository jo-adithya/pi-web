import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { ImageLightbox } from "../src/components/ImageLightbox";

afterEach(cleanup);

it("closes on clicks outside the displayed image, but keeps image clicks and drags open", () => {
  const close = vi.fn();
  render(() => <ImageLightbox url="blob:test" close={close} />); flush();
  const viewport = screen.getByRole("group", { name: "Zoomable image" });
  const image = screen.getByAltText("Expanded conversation image");
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue({ left: 100, top: 100, right: 300, bottom: 300 } as DOMRect);
  Object.defineProperty(viewport, "setPointerCapture", { value: vi.fn() });

  fireEvent.click(viewport, { clientX: 200, clientY: 200 });
  expect(close).not.toHaveBeenCalled();
  fireEvent.pointerDown(viewport, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 350, clientY: 200 });
  fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 350, clientY: 200 });
  fireEvent.click(viewport, { clientX: 350, clientY: 200 });
  expect(close).not.toHaveBeenCalled();

  fireEvent.pointerDown(viewport, { pointerId: 1, button: 0, clientX: 50, clientY: 50 });
  fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 50, clientY: 50 });
  fireEvent.click(viewport, { clientX: 50, clientY: 50 });
  expect(close).toHaveBeenCalledOnce();
});

it("pinches, pans, bounds zoom and resets when reopened", () => {
  const close = vi.fn();
  const view = render(() => <ImageLightbox url="blob:test" close={close} />); flush();
  const viewport = screen.getByRole("group", { name: "Zoomable image" });
  const image = screen.getByAltText("Expanded conversation image");
  Object.defineProperty(viewport, "setPointerCapture", { value: vi.fn() });
  const pointer = (type: string, id: number, x: number, y: number) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperties(event, { pointerId: { value: id }, clientX: { value: x }, clientY: { value: y }, button: { value: 0 } });
    fireEvent(viewport, event); flush();
  };
  pointer("pointerdown", 1, 0, 0);
  pointer("pointerdown", 2, 100, 0);
  pointer("pointermove", 2, 200, 0);
  expect(image.style.transform).toContain("scale(2)");
  pointer("pointerup", 2, 200, 0);
  const before = image.style.transform;
  pointer("pointermove", 1, 20, 30);
  expect(image.style.transform).not.toBe(before);
  pointer("pointercancel", 1, 20, 30);
  const cancelled = image.style.transform;
  pointer("pointermove", 1, 50, 50);
  expect(image.style.transform).toBe(cancelled);
  fireEvent.wheel(viewport, { deltaY: -10000 }); flush();
  expect(image.style.transform).toContain("scale(8)");
  fireEvent.wheel(viewport, { deltaY: 10000 }); flush();
  expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
  fireEvent.keyDown(viewport, { key: "+" }); flush();
  fireEvent.keyDown(viewport, { key: "0" }); flush();
  expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
  fireEvent.keyDown(viewport, { key: "Escape" }); flush();
  expect(close).toHaveBeenCalled();
  view.unmount();
  render(() => <ImageLightbox url="blob:other" close={close} />); flush();
  expect(screen.getByAltText("Expanded conversation image").style.transform).toBe("translate(0px, 0px) scale(1)");
});
