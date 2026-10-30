import { Show, createSignal, onSettled } from "solid-js";
import { Button } from "@kobalte/core/button";
import { Portal, type JSX } from "@solidjs/web";
import type { ReplyQuote } from "../reply-quote";
import { Icon } from "./Icon";

/** Offers a draft-only reply for a native text selection within one rendered message.
 * Mobile actions dock in mobileReplyTarget when supplied; desktop actions float near the selection.
 * Copying stays native. Selection listeners and viewport tracking live only while mounted.
 */
export function ChatSelectionReply(props: { children: JSX.Element; onReply?: (quote: ReplyQuote) => void; mobileReplyTarget?: HTMLDivElement }) {
  let root!: HTMLDivElement;
  const [mobile, setMobile] = createSignal(window.innerWidth <= 760);
  const docked = () => mobile() && !!props.mobileReplyTarget;
  let dragging = false;
  let dismissed: Range | undefined;
  const [selected, setSelected] = createSignal<{ quote: ReplyQuote; range: Range; left: number; top: number }>();
  const sameRange = (a: Range, b: Range) => a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
  /** Finds the author of selected text, excluding empty boundary nodes after a paragraph. */
  function selectedAuthor(range: Range): ReplyQuote["author"] | undefined {
    let message: HTMLElement | undefined;
    const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    let node: Node | null = range.commonAncestorContainer instanceof Text ? range.commonAncestorContainer : walker.nextNode();
    for (; node; node = walker.nextNode()) {
      const text = node as Text;
      if (range.comparePoint(text, 0) > 0 || range.comparePoint(text, text.length) < 0) continue;
      const selectedText = text.data.slice(text === range.startContainer ? range.startOffset : 0, text === range.endContainer ? range.endOffset : text.length);
      if (!selectedText.trim()) continue;
      const owner = text.parentElement?.closest(".message-text")?.closest<HTMLElement>(".message");
      if (!owner || !root.contains(owner) || (message && message !== owner)) return;
      message = owner;
    }
    const author = message?.dataset.replyAuthor;
    return author === "Pi" || author === "You" ? author : undefined;
  }
  function update() {
    const selection = window.getSelection();
    if (!props.onReply || dragging) { setSelected(undefined); return; }
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) { dismissed = undefined; setSelected(undefined); return; }
    const range = selection.getRangeAt(0);
    const author = selectedAuthor(range);
    if (!author || (dismissed && sameRange(range, dismissed))) { setSelected(undefined); return; }
    const text = selection.toString().trim();
    if (!text) { setSelected(undefined); return; }
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
    const rects = Array.from(range.getClientRects()).filter(rect => rect.height > 0 && rect.bottom > top && rect.top < top + height);
    const backwards = selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset;
    const rect = backwards ? rects[0] : rects.at(-1);
    if (!rect && !docked()) { setSelected(undefined); return; }
    dismissed = undefined;
    setSelected({ quote: { author, text }, range: range.cloneRange(),
      left: Math.max(left + 8, Math.min(rect?.left ?? left, left + width - 136)),
      top: rect ? Math.max(top + 8, Math.min(rect.top - 44 >= top + 8 ? rect.top - 44 : rect.bottom + 8, top + height - 44)) : top,
    });
  }
  function dismiss() {
    const value = selected(); if (value) dismissed = value.range.cloneRange();
    setSelected(undefined);
  }
  onSettled(() => {
    if (!props.onReply) return;
    const down = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".chat-reply-action")) return;
      if (event.pointerType === "mouse" && event.button === 0) { dragging = true; dismissed = undefined; setSelected(undefined); }
    };
    const up = () => { dragging = false; update(); };
    const cancel = () => { dragging = false; setSelected(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && selected()) { event.preventDefault(); dismiss(); } };
    const reposition = () => { if (selected()) update(); };
    const resize = () => { setMobile(window.innerWidth <= 760); reposition(); };
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", resize);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", reposition); viewport?.addEventListener("scroll", reposition);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", resize);
      viewport?.removeEventListener("resize", reposition); viewport?.removeEventListener("scroll", reposition);
    };
  });
  /** Preserve native selection while invoking or dismissing its draft-only action. */
  function Actions() {
    return <Show when={selected()}>{value => <div class={`chat-reply-action${docked() ? " chat-reply-docked" : ""}`} role="group" aria-label="Selected message actions" style={docked() ? undefined : { left: `${value().left}px`, top: `${value().top}px` }} onPointerDown={event => event.preventDefault()}>
      <Button type="button" aria-label="Reply to selection" onClick={() => {
        const current = value();
        if (root.contains(current.range.startContainer) && root.contains(current.range.endContainer)) props.onReply?.(current.quote);
        dismiss();
      }}><Icon name="reply" /><span>Reply</span></Button>
      <Show when={!docked()}><Button type="button" class="chat-reply-dismiss" aria-label="Dismiss reply action" title="Dismiss (Escape)" onClick={dismiss}><Icon name="close" /></Button></Show>
    </div>}</Show>;
  }
  return <div class="chat-messages" ref={root}>{props.children}
    <Show when={docked()} fallback={<Actions />}><Portal mount={props.mobileReplyTarget}><Actions /></Portal></Show>
  </div>;
}
