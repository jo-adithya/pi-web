import { Button } from "@kobalte/core/button";
import { CopyButton } from "./components/CopyButton";
import { SimpleResponse } from "./components/SimpleResponse";
import { renderMarkdownParts } from "./markdown";
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
import type { CodeLocation } from "./code-reference";

interface ReviewPresentation { loadOriginal?: (sourceKey: string, signal: AbortSignal) => Promise<string>; retryResponse?: (messageId: string) => void; openCode?: (location: CodeLocation) => void; reviewCards?: readonly ReviewCard[]; loadReviewPreview?: ReviewPreviewLoader }

/** Collects retained assistant replies up to this answer, bounded by a user prompt or an earlier presented answer. */
function replyGroup(state: Pick<ClientState, "order" | "messages">, id: string): DisplayMessage[] {
  const end = state.order.indexOf(id);
  let start = end;
  while (start > 0) {
    const previous = state.messages[state.order[start - 1]];
    if (previous.role === "user" || previous.role === "assistant" && previous.presentation && previous.presentation.state !== "hidden") break;
    start--;
  }
  return state.order.slice(start, end + 1).map(key => state.messages[key]).filter(message => message.role === "assistant");
}

/** Renders the server-owned page; navigation replaces rather than accumulates messages. */
export function MessageList(props: ReviewPresentation & { state: Pick<ClientState, "order" | "messages">; loadImage?: (id: string) => Promise<Blob>; onReply?: (quote: ReplyQuote) => void; mobileReplyTarget?: HTMLDivElement }) {
  return <ChatSelectionReply onReply={props.onReply} mobileReplyTarget={props.mobileReplyTarget}>
    <For each={props.state.order}>{id => <Message message={props.state.messages[id]} replies={replyGroup(props.state, id)} loadOriginal={props.loadOriginal} retryResponse={props.retryResponse} openCode={props.openCode} loadImage={props.loadImage} reviewCards={props.reviewCards} loadReviewPreview={props.loadReviewPreview} />}</For></ChatSelectionReply>;
}

/** Keeps HTML previews original and text replies simplified, with compaction summaries collapsed. */
function Message(props: ReviewPresentation & { message: DisplayMessage; replies?: DisplayMessage[]; loadImage?: (id: string) => Promise<Blob> }) {
  const originalPreview = createMemo(() => props.message.role === "assistant" && props.message.complete && !props.message.truncated && props.message.presentation !== undefined && props.message.presentation.state !== "hidden"
    && (props.replies ?? [props.message]).some(message => !message.truncated && message.blocks.some(block => block.kind === "text" && block.text.includes("html preview") && renderMarkdownParts(block.text).some(part => part.kind === "artifact"))));
  const presentation = () => originalPreview() ? undefined : props.message.presentation;
  const visible = () => props.message.presentation?.state !== "hidden" && (props.message.presentation || props.message.role === "user" || props.message.blocks.some(block => block.kind !== "thinking") || props.message.error || props.message.truncated);
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
  const originals = () => props.message.role === "assistant" ? props.replies ?? [props.message] : [review().message];
  const originalText = () => originals().flatMap(message => message.blocks.filter(block => block.kind === "text").map(block => block.text)).join("\n\n");
  const original = () => <For each={originals()}>{message => <MessageBody message={message} openCode={props.openCode} loadImage={props.loadImage} />}</For>;
  return <Show when={visible()}><Show when={props.message.role === "compactionSummary"} fallback={<>
    <Show when={review().cards.length}><div class="chat-review-attachments" role="group" aria-label="Referenced changes"><For each={review().cards}>{card => <ReviewDiffCard card={card} load={props.loadReviewPreview} />}</For></div></Show>
    <Show when={review().message.blocks.length || props.message.error || props.message.truncated || !review().cards.length}><article class={`message ${props.message.role === "user" ? "user" : "assistant"}`} data-message-id={props.message.id} data-reply-author={props.message.role === "assistant" ? "Pi" : "You"}><header class="message-heading"><h2><span class="message-avatar" aria-hidden="true">{props.message.role === "user" ? "↗" : "π"}</span>{props.message.role === "assistant" ? "Pi" : props.message.role === "user" ? "You" : props.message.role}</h2>
      <Show when={props.message.role === "assistant" && !presentation() && props.message.complete && props.message.blocks.some(block => block.kind === "text" && block.text)}><div class="answer-actions"><CopyButton label="Copy answer" text={originalText} /></div></Show>
      </header><div class="message-content"><Show when={presentation()} fallback={original()}><SimpleResponse message={props.message} openCode={props.openCode} retry={props.retryResponse ? () => props.retryResponse?.(props.message.id) : undefined} loadOriginal={props.message.blocks.length === 0 && props.message.sourceKey && props.loadOriginal ? signal => props.loadOriginal!(props.message.sourceKey!, signal) : undefined} original={original} originalText={originalText} /></Show></div>
    </article></Show>
  </>}><CompactionSummary message={props.message} openCode={props.openCode} loadImage={props.loadImage} /></Show></Show>;
}

/** A quiet history milestone; summary content mounts only when explicitly opened. */
function CompactionSummary(props: ReviewPresentation & { message: DisplayMessage; loadImage?: (id: string) => Promise<Blob> }) {
  const [open, setOpen] = createSignal(false);
  return <details class="context-summary" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span class="context-summary-mark"><Icon name="structure" /></span>
      <span class="context-summary-label"><strong>Context compacted</strong><span>Earlier conversation summarized</span></span>
      <span class="context-summary-action">{open() ? "Hide summary" : "View summary"}</span>
      <span class="context-summary-chevron"><Icon name="chevronDown" /></span>
    </summary>
    <Show when={open()}><div class="context-summary-body"><MessageBody message={props.message} openCode={props.openCode} loadImage={props.loadImage} /></div></Show>
  </details>;
}

/** Shared safe message content, including image loading and preview warnings. */
function MessageBody(props: ReviewPresentation & { message: DisplayMessage; loadImage?: (id: string) => Promise<Blob> }) {
  return <><For each={props.message.blocks}>{block => <Show when={block.kind !== "thinking"}>
      <Show when={block.kind === "text"} fallback={<Show when={block.kind === "image"} fallback={<pre class="block-notice">{block.text}</pre>}><ImagePreview id={block.text} load={props.loadImage} /></Show>}><div class="message-text"><Markdown text={block.text} openCode={props.openCode} complete={props.message.complete} allowArtifacts={props.message.role === "assistant" && !props.message.truncated} /></div></Show>
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

