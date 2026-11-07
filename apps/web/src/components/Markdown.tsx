import { For, Show, createMemo } from "solid-js";
import { renderMarkdown, renderMarkdownParts } from "../markdown";
import { HtmlArtifact } from "./HtmlArtifact";

/** Streams plain text; parses/highlights only the authoritative completed block. */
export function Markdown(props: { text: string; complete: boolean; allowArtifacts?: boolean }) {
  const parts = createMemo(() => !props.complete ? [] : props.allowArtifacts
    ? renderMarkdownParts(props.text)
    : [{ kind: "markdown" as const, html: renderMarkdown(props.text) }]);
  return (
    <Show when={props.complete} fallback={<pre class="streaming-text">{props.text}</pre>}>
      <For each={parts()}>{part => part.kind === "artifact"
        ? <HtmlArtifact source={part.source} />
        : <div class="markdown" innerHTML={part.html} />}</For>
    </Show>
  );
}
