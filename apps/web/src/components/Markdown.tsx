import { Show, createMemo } from "solid-js";
import { renderMarkdown } from "../markdown";

/** Streams plain text; parses/highlights only the authoritative completed block. */
export function Markdown(props: { text: string; complete: boolean }) {
  const html = createMemo(() => props.complete ? renderMarkdown(props.text) : "");
  return (
    <Show when={props.complete} fallback={<pre class="streaming-text">{props.text}</pre>}>
      <div class="markdown" innerHTML={html()} />
    </Show>
  );
}
