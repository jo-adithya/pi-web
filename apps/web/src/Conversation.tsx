import { Button } from "@kobalte/core/button";
import { ImageLightbox } from "./components/ImageLightbox";
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import type { DisplayMessage } from "./generated/protocol";
import type { ClientState } from "./client-state";
import { Markdown } from "./components/Markdown";
import { Icon } from "./components/Icon";
import { ChatSelectionReply } from "./components/ChatSelectionReply";
import type { ReplyQuote } from "./reply-quote";
import { reviewMessageContent, type ReviewCard } from "./review-cards";
import { ReviewDiffCard, type ReviewPreviewLoader } from "./components/ReviewDiffCard";

interface ReviewPresentation { reviewCards?: readonly ReviewCard[]; loadReviewPreview?: ReviewPreviewLoader }

/** Starts with the latest 100 messages; explicitly revealed history stays expanded while mounted. */
export function MessageList(props: ReviewPresentation & { state: Pick<ClientState, "order" | "messages">; loadImage?: (id: string) => Promise<Blob>; onReply?: (quote: ReplyQuote) => void; mobileReplyTarget?: HTMLDivElement }) {
  const [count, setCount] = createSignal(100);
  return <ChatSelectionReply onReply={props.onReply} mobileReplyTarget={props.mobileReplyTarget}><Show when={props.state.order.length > count()}><Button class="history-marker" onClick={() => setCount(value => value + 100)}>Show earlier retained messages</Button></Show>
    <For each={props.state.order.slice(-count())}>{id => <Message message={props.state.messages[id]} loadImage={props.loadImage} reviewCards={props.reviewCards} loadReviewPreview={props.loadReviewPreview} />}</For></ChatSelectionReply>;
}

/** Renders responses and warnings, with compaction summaries tucked into a disclosure. */
function Message(props: ReviewPresentation & { message: DisplayMessage; loadImage?: (id: string) => Promise<Blob> }) {
  const visible = () => props.message.role === "user" || props.message.blocks.some(block => block.kind !== "thinking") || props.message.error || props.message.truncated;
  const review = createMemo(() => {
    const cards: ReviewCard[] = [];
    if (props.message.role !== "user") return { cards, message: props.message };
    const blocks = props.message.blocks.flatMap(block => {
      if (block.kind !== "text") return [block];
      const content = reviewMessageContent(block.text, props.reviewCards ?? []);
      cards.push(...content.cards);
      return content.text ? [{ ...block, text: content.text }] : [];
    });
    return { cards, message: cards.length ? { ...props.message, blocks } : props.message };
  });
  return <Show when={visible()}><Show when={props.message.role === "compactionSummary"} fallback={<>
    <Show when={review().cards.length}><div class="chat-review-attachments" role="group" aria-label="Referenced changes"><For each={review().cards}>{card => <ReviewDiffCard card={card} load={props.loadReviewPreview} />}</For></div></Show>
    <Show when={review().message.blocks.length || props.message.error || props.message.truncated || !review().cards.length}><article class={`message ${props.message.role === "user" ? "user" : "assistant"}`} data-reply-author={props.message.role === "assistant" ? "Pi" : "You"}><h2>{props.message.role === "assistant" ? "Pi" : props.message.role}</h2>
      <MessageBody message={review().message} loadImage={props.loadImage} />
    </article></Show>
  </>}><CompactionSummary message={props.message} loadImage={props.loadImage} /></Show></Show>;
}

/** A quiet history milestone; summary content mounts only when explicitly opened. */
function CompactionSummary(props: { message: DisplayMessage; loadImage?: (id: string) => Promise<Blob> }) {
  const [open, setOpen] = createSignal(false);
  return <details class="context-summary" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span class="context-summary-mark"><Icon name="structure" /></span>
      <span class="context-summary-label"><strong>Context compacted</strong><span>Earlier conversation summarized</span></span>
      <span class="context-summary-action">{open() ? "Hide summary" : "View summary"}</span>
      <span class="context-summary-chevron"><Icon name="chevronDown" /></span>
    </summary>
    <Show when={open()}><div class="context-summary-body"><MessageBody message={props.message} loadImage={props.loadImage} /></div></Show>
  </details>;
}

/** Shared safe message content, including image loading and preview warnings. */
function MessageBody(props: { message: DisplayMessage; loadImage?: (id: string) => Promise<Blob> }) {
  return <><For each={props.message.blocks}>{block => <Show when={block.kind !== "thinking"}>
      <Show when={block.kind === "text"} fallback={<Show when={block.kind === "image"} fallback={<pre class="block-notice">{block.text}</pre>}><ImagePreview id={block.text} load={props.loadImage} /></Show>}><div class="message-text"><Markdown text={block.text} complete={props.message.complete} allowArtifacts={props.message.role === "assistant" && !props.message.truncated} /></div></Show>
    </Show>}</For>
    <Show when={props.message.error}><p class="warning">{props.message.error}</p></Show><Show when={props.message.truncated}><p class="truncated">Preview truncated. The full content remains with Pi.</p></Show>
  </>;
}


/** Loads a compact thumbnail on request; expansion reuses its blob URL.
 * Hiding or unmounting releases the bytes retained by the browser URL.
 */
function ImagePreview(props: { id: string; load?: (id: string) => Promise<Blob> }) {
  const [url, setUrl] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [error, setError] = createSignal("");
  let disposed = false;
  function hide() { setExpanded(false); if (url()) URL.revokeObjectURL(url()); setUrl(""); }
  onSettled(() => () => { disposed = true; hide(); });
  async function load() {
    if (busy() || !props.load) return;
    setBusy(true); setError("");
    try {
      const blob = await props.load(props.id);
      if (!disposed) setUrl(URL.createObjectURL(blob));
    } catch { if (!disposed) setError("Image unavailable (expired or preview limit). Reattach the original if needed."); }
    finally { if (!disposed) setBusy(false); }
  }
  return <div class="image-preview"><Show when={url()} fallback={<Button class="image-placeholder" type="button" aria-label={busy() ? "Loading image…" : "Load image"} aria-busy={busy() ? "true" : "false"} disabled={busy() || !props.load} onClick={load}>
    <Icon name="image" /><span>{busy() ? "Loading image…" : "Load image"}</span>
  </Button>}>
    <Button class="image-thumbnail" type="button" aria-label="Expand image" aria-haspopup="dialog" onClick={() => setExpanded(true)}>
      <img src={url()} alt="Conversation image" loading="lazy" onError={() => { hide(); setError("Image could not be decoded."); }} />
      <span class="image-expand-hint" aria-hidden="true"><Icon name="expand" /></span>
    </Button>
    <Button class="image-hide" type="button" onClick={hide}>Hide image</Button>
    <Show when={expanded()}><ImageLightbox url={url()} close={() => setExpanded(false)} /></Show>
  </Show><Show when={error()}><p role="status">{error()}</p></Show></div>;
}

