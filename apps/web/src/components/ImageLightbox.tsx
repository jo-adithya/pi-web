import { Button } from "@kobalte/core/button";
import { createSignal, onSettled } from "solid-js";
import { ActionDialog } from "./ActionDialog";
import { Icon } from "./Icon";

/** Focus-contained image preview with 1–8× zoom, pointer panning and trigger focus restoration. */
export function ImageLightbox(props: { url: string; close: () => void }) {
  const [view, setView] = createSignal({ scale: 1, x: 0, y: 0 });
  const pointers = new Map<number, { x: number; y: number }>();
  let viewport!: HTMLDivElement;
  let image!: HTMLImageElement;
  let clickStart = { x: 0, y: 0 };
  let suppressClick = false;
  const reset = () => setView({ scale: 1, x: 0, y: 0 });
  // Coordinates are relative to the fitted image's center, in CSS pixels.
  function zoom(scale: number, x = 0, y = 0) {
    const previous = view();
    const next = Math.min(8, Math.max(1, scale));
    if (next === 1) { reset(); return; }
    const ratio = next / previous.scale;
    setView({ scale: next, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio });
  }
  function gesture() {
    const points = [...pointers.values()];
    const first = points[0]; const second = points[1] ?? first;
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2,
      distance: Math.hypot(second.x - first.x, second.y - first.y) };
  }
  function move(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return;
    const before = gesture();
    if (Math.hypot(event.clientX - clickStart.x, event.clientY - clickStart.y) > 5) suppressClick = true;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const after = gesture();
    if (pointers.size > 1 && before.distance > 0) {
      const bounds = viewport.getBoundingClientRect();
      zoom(view().scale * after.distance / before.distance, before.x - bounds.left - bounds.width / 2, before.y - bounds.top - bounds.height / 2);
    }
    if (view().scale > 1) setView(value => ({ ...value, x: value.x + after.x - before.x, y: value.y + after.y - before.y }));
  }
  onSettled(() => {
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      zoom(view().scale * 2 ** (-delta / 500), event.clientX - bounds.left - bounds.width / 2, event.clientY - bounds.top - bounds.height / 2);
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  });
  return <ActionDialog title="Image preview" description="Pinch or scroll to zoom; drag to pan. Use + and − to zoom, arrow keys to pan, and 0 or double-click to reset." hideHeading close={props.close} class="image-lightbox">
    <div class="image-viewport" ref={viewport} onDblClick={reset}
      onClick={event => {
        if (suppressClick) return;
        // Hit-test the transformed image: pointer capture targets the viewport even over the image.
        const bounds = image.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) props.close();
      }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        if (pointers.size === 0) {
          clickStart = { x: event.clientX, y: event.clientY };
          suppressClick = false;
        } else suppressClick = true;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={move} onPointerUp={event => pointers.delete(event.pointerId)}
      onPointerCancel={event => pointers.delete(event.pointerId)} onLostPointerCapture={event => pointers.delete(event.pointerId)}
      onKeyDown={event => {
        if (["+", "=", "-", "0", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          if (event.key === "0") reset();
          else if (event.key === "+" || event.key === "=") zoom(view().scale * 1.5);
          else if (event.key === "-") zoom(view().scale / 1.5);
          else if (view().scale > 1) setView(value => ({ ...value,
            x: value.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0),
            y: value.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0) }));
        }
      }} tabindex={0} role="group" aria-label="Zoomable image">
      <img ref={image} src={props.url} alt="Expanded conversation image" draggable={false}
        style={{ transform: `translate(${view().x}px, ${view().y}px) scale(${view().scale})` }} />
    </div>
    <Button class="image-lightbox-close" type="button" aria-label="Close image preview" onClick={props.close}><Icon name="close" /></Button>
  </ActionDialog>;
}
