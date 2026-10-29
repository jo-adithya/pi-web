/**
 * Observes single-finger horizontal swipes in the workspace and portaled drawer.
 * Passive listeners preserve native scrolling; only a completed swipe of at least
 * 64 CSS pixels (and 1.5× its vertical travel) changes state. Returns cleanup.
 */
export function listenForSidebarSwipes(
  enabled: () => boolean,
  isOpen: () => boolean,
  setOpen: (open: boolean) => void,
) {
  let start: { id: number; x: number; y: number; time: number; open: boolean } | undefined;
  const reset = () => { start = undefined; };
  const begin = (event: TouchEvent) => {
    reset();
    if (!enabled() || event.touches.length !== 1 || !(event.target instanceof Element)) return;
    const target = event.target;
    if (!target.closest(".chat-panel, .sidebar-drawer, .sidebar-overlay")
      || target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='slider'], dialog, [role='dialog']:not(.sidebar-drawer)")) return;
    // Leave horizontal scrolling (code blocks, tables, etc.) to its owner.
    for (let element: Element | null = target; element; element = element.parentElement) {
      if (element.scrollWidth > element.clientWidth
        && /^(auto|scroll)$/.test(getComputedStyle(element).overflowX)) return;
    }
    const touch = event.touches[0];
    start = { id: touch.identifier, x: touch.clientX, y: touch.clientY, time: event.timeStamp, open: isOpen() };
  };
  const move = (event: TouchEvent) => {
    if (!start) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch.identifier !== start.id
      || (Math.abs(touch.clientY - start.y) > 10 && Math.abs(touch.clientY - start.y) > Math.abs(touch.clientX - start.x))) reset();
  };
  const end = (event: TouchEvent) => {
    const gesture = start; reset();
    if (!gesture || !enabled() || event.touches.length || isOpen() !== gesture.open
      || event.timeStamp - gesture.time > 1000) return;
    const touch = Array.from(event.changedTouches).find(touch => touch.identifier === gesture.id);
    if (!touch) return;
    const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
    if (Math.abs(dx) >= 64 && Math.abs(dx) >= Math.abs(dy) * 1.5
      && (gesture.open ? dx < 0 : dx > 0)) setOpen(!gesture.open);
  };
  document.addEventListener("touchstart", begin, { passive: true });
  document.addEventListener("touchmove", move, { passive: true });
  document.addEventListener("touchend", end, { passive: true });
  document.addEventListener("touchcancel", reset, { passive: true });
  return () => {
    reset();
    document.removeEventListener("touchstart", begin);
    document.removeEventListener("touchmove", move);
    document.removeEventListener("touchend", end);
    document.removeEventListener("touchcancel", reset);
  };
}
