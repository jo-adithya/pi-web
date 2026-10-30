/** Drawer visibility during a gesture or its release animation; progress is clamped to 0–1. */
export interface SidebarDrag { progress: number; dragging: boolean }

/**
 * Tracks opening drags anywhere in the chat panel and closing drags across the drawer and backdrop. Claims horizontal movement
 * after 10 CSS pixels, leaving scrolling/editing alone. Releases commit at 30% of
 * drawer width; cancellation restores the original state. The callback receives
 * null after the 180ms snap (immediately with reduced motion). Returns full cleanup.
 */
export function listenForSidebarSwipes(
  enabled: () => boolean,
  isOpen: () => boolean,
  setOpen: (open: boolean) => void,
  onDrag: (drag: SidebarDrag | null) => void,
) {
  let start: { id: number; x: number; y: number; open: boolean; width: number; claimed: boolean; progress: number } | undefined;
  let settling: ReturnType<typeof setTimeout> | undefined;
  let suppressClickUntil = 0;
  const blocked = () => !enabled() || Boolean(document.querySelector("dialog[open], [role='dialog']:not(.sidebar-drawer), [role='alertdialog']"));
  const finish = (open: boolean) => {
    const gesture = start; start = undefined;
    if (!gesture?.claimed) return;
    suppressClickUntil = Date.now() + 500;
    onDrag({ progress: open ? 1 : 0, dragging: false });
    if (open !== isOpen()) setOpen(open);
    settling = setTimeout(() => { settling = undefined; onDrag(null); }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
  };
  const cancel = () => finish(isOpen());
  const begin = (event: TouchEvent) => {
    suppressClickUntil = 0;
    if (start) cancel();
    if (settling || blocked() || event.touches.length !== 1 || !(event.target instanceof Element)) return;
    const target = event.target, open = isOpen(), touch = event.touches[0];
    if (!(open ? target.closest(".sidebar-drawer, .sidebar-overlay") : target.closest(".chat-panel"))
      || target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='slider'], [role='menu'], [role='listbox']")) return;
    for (let element: Element | null = target; element; element = element.parentElement) {
      if (element.scrollWidth > element.clientWidth
        && /^(auto|scroll)$/.test(getComputedStyle(element).overflowX)) return;
    }
    const drawer = document.querySelector(".sidebar-drawer");
    const width = drawer?.getBoundingClientRect().width || Math.min(310, window.innerWidth - 3 * parseFloat(getComputedStyle(document.documentElement).fontSize || "16"));
    start = { id: touch.identifier, x: touch.clientX, y: touch.clientY, open, width, claimed: false, progress: open ? 1 : 0 };
  };
  const move = (event: TouchEvent) => {
    if (!start) return;
    const touch = event.touches[0];
    if (blocked() || event.touches.length !== 1 || touch.identifier !== start.id || isOpen() !== start.open) { cancel(); return; }
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (!start.claimed) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { cancel(); return; }
      if (Math.abs(dx) < 10) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.5 || (start.open ? dx >= 0 : dx <= 0)) { cancel(); return; }
      start.claimed = true;
    }
    event.preventDefault();
    start.progress = Math.max(0, Math.min(1, (start.open ? 1 : 0) + dx / start.width));
    onDrag({ progress: start.progress, dragging: true });
  };
  const end = (event: TouchEvent) => {
    if (!start) return;
    if (blocked() || event.touches.length || isOpen() !== start.open
      || !Array.from(event.changedTouches).some(touch => touch.identifier === start!.id)) { cancel(); return; }
    const enough = start.open ? start.progress <= 0.7 : start.progress >= 0.3;
    finish(enough ? !start.open : start.open);
  };
  const click = (event: MouseEvent) => {
    if (Date.now() < suppressClickUntil && event.detail !== 0) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  document.addEventListener("touchstart", begin, { passive: true });
  document.addEventListener("touchmove", move, { passive: false });
  document.addEventListener("touchend", end, { passive: true });
  document.addEventListener("touchcancel", cancel, { passive: true });
  document.addEventListener("click", click, true);
  window.addEventListener("resize", cancel);
  window.visualViewport?.addEventListener("resize", cancel);
  return () => {
    start = undefined; clearTimeout(settling); onDrag(null);
    document.removeEventListener("touchstart", begin);
    document.removeEventListener("touchmove", move);
    document.removeEventListener("touchend", end);
    document.removeEventListener("touchcancel", cancel);
    document.removeEventListener("click", click, true);
    window.removeEventListener("resize", cancel);
    window.visualViewport?.removeEventListener("resize", cancel);
  };
}
