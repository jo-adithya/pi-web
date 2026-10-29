import { For, Show, createEffect, createSignal } from "solid-js";
import type { DisplayMessage } from "./generated/protocol";
import type { ClientState } from "./client-state";
import { Markdown } from "./components/Markdown";

/** Mounts a recent window; earlier retained messages require an explicit local reveal. */
export function MessageList(props: { state: Pick<ClientState, "epoch" | "order" | "messages"> }) {
  const [count, setCount] = createSignal(100);
  createEffect(() => props.state.epoch, () => { setCount(100); });
  return <><Show when={props.state.order.length > count()}><button class="history-marker" onClick={() => setCount(value => value + 100)}>Show earlier retained messages</button></Show>
    <For each={props.state.order.slice(-count())}>{id => <Message message={props.state.messages[id]} />}</For></>;
}

/** Renders response content and warnings, omitting thinking-only assistant entries. */
function Message(props: { message: DisplayMessage }) {
  const visible = () => props.message.role === "user" || props.message.blocks.some(block => block.kind !== "thinking") || props.message.error || props.message.truncated;
  return <Show when={visible()}><article class={`message ${props.message.role === "user" ? "user" : "assistant"}`}><h2>{props.message.role === "assistant" ? "Pi" : props.message.role}</h2>
    <For each={props.message.blocks}>{block => <Show when={block.kind !== "thinking"}>
      <Show when={block.kind === "text"} fallback={<pre class="block-notice">{block.text}</pre>}><Markdown text={block.text} complete={props.message.complete} /></Show>
    </Show>}</For>
    <Show when={props.message.error}><p class="warning">{props.message.error}</p></Show><Show when={props.message.truncated}><p class="truncated">Preview truncated. The full content remains with Pi.</p></Show>
  </article></Show>;
}

