import { Button } from "@kobalte/core/button";
import { ActionDialog } from "./components/ActionDialog";
import { For, Show, createSignal, onSettled } from "solid-js";
import type { DisplayMessage } from "./generated/protocol";
import type { ClientState } from "./client-state";
import { Markdown } from "./components/Markdown";
import { Icon } from "./components/Icon";

/** Starts with the latest 100 messages; explicitly revealed history stays expanded while mounted. */
export function MessageList(props: { state: Pick<ClientState, "order" | "messages">; loadImage?: (id: string) => Promise<Blob> }) {
  const [count, setCount] = createSignal(100);
  return <><Show when={props.state.order.length > count()}><Button class="history-marker" onClick={() => setCount(value => value + 100)}>Show earlier retained messages</Button></Show>
    <For each={props.state.order.slice(-count())}>{id => <Message message={props.state.messages[id]} loadImage={props.loadImage} />}</For></>;
}

/** Renders response content and warnings, omitting thinking-only assistant entries. */
function Message(props: { message: DisplayMessage; loadImage?: (id: string) => Promise<Blob> }) {
  const visible = () => props.message.role === "user" || props.message.blocks.some(block => block.kind !== "thinking") || props.message.error || props.message.truncated;
  return <Show when={visible()}><article class={`message ${props.message.role === "user" ? "user" : "assistant"}`}><h2>{props.message.role === "assistant" ? "Pi" : props.message.role}</h2>
    <For each={props.message.blocks}>{block => <Show when={block.kind !== "thinking"}>
      <Show when={block.kind === "text"} fallback={<Show when={block.kind === "image"} fallback={<pre class="block-notice">{block.text}</pre>}><ImagePreview id={block.text} load={props.loadImage} /></Show>}><Markdown text={block.text} complete={props.message.complete} /></Show>
    </Show>}</For>
    <Show when={props.message.error}><p class="warning">{props.message.error}</p></Show><Show when={props.message.truncated}><p class="truncated">Preview truncated. The full content remains with Pi.</p></Show>
  </article></Show>;
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

/** Focus-contained preview reuses the already loaded image and restores its trigger. */
function ImageLightbox(props: { url: string; close: () => void }) {
  return <ActionDialog title="Image preview" description="Expanded conversation image" close={props.close} class="image-lightbox">
    <Button class="image-lightbox-close" type="button" aria-label="Close image preview" onClick={props.close}><Icon name="close" /></Button>
    <img src={props.url} alt="Expanded conversation image" />
  </ActionDialog>;
}
