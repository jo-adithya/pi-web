import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import { Portal } from "@solidjs/web";
import { CopyButton } from "./CopyButton";
import { renderMarkdown, renderMarkdownParts } from "../markdown";
import { HtmlArtifact } from "./HtmlArtifact";
import { codeReference, type CodeLocation } from "../code-reference";

/** Streams plain text; parses/highlights only the authoritative completed block. */
export function Markdown(props: { text: string; complete: boolean; allowArtifacts?: boolean; openCode?: (location: CodeLocation) => void }) {
  const parts = createMemo(() => !props.complete ? [] : props.allowArtifacts
    ? renderMarkdownParts(props.text)
    : [{ kind: "markdown" as const, html: renderMarkdown(props.text) }]);
  return (
    <Show when={props.complete} fallback={<pre class="streaming-text">{props.text}</pre>}>
      <For each={parts()}>{part => part.kind === "artifact"
        ? <HtmlArtifact source={part.source} />
        : <MarkdownContent html={part.html} openCode={props.openCode} />}</For>
    </Show>
  );
}

/** Adds app-owned copy controls to completed Markdown, including nested code fences. */
function MarkdownContent(props: { html: string; openCode?: (location: CodeLocation) => void }) {
  let root!: HTMLDivElement;
  const [blocks, setBlocks] = createSignal<{ mount: HTMLDivElement; text: string }[]>([]);
  onSettled(() => {
    setBlocks([...root.querySelectorAll("pre > code")].map(code => {
      const pre = code.parentElement!, mount = document.createElement("div");
      mount.className = "code-block";
      pre.replaceWith(mount); mount.append(pre);
      return { mount, text: code.textContent ?? "" };
    }));
  });
  return <><div ref={root} class="markdown" innerHTML={props.html} onClick={event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-code-reference]") : null;
    if (!target) return;
    event.preventDefault();
    const location = codeReference(target.dataset.codeReference ?? "");
    if (location) props.openCode?.(location);
  }} /><For each={blocks()}>{block => <Portal mount={block.mount}><CopyButton label="Copy code" text={() => block.text} /></Portal>}</For></>;
}
