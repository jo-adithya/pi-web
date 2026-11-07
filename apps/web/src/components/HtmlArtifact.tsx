import { Button } from "@kobalte/core/button";
import { Show, createMemo, createSignal, onSettled } from "solid-js";
import { sanitizeArtifact } from "../html-artifact";
import { ActionDialog } from "./ActionDialog";

/** Delivers sanitized markup and live theme colors to one opaque-origin viewer. */
function ArtifactFrame(props: { html: string }) {
  let frame!: HTMLIFrameElement;
  const sendTheme = () => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const names = "background foreground card card-foreground muted muted-foreground primary primary-foreground border accent accent-foreground secondary secondary-foreground".split(" ");
    const colors = Object.fromEntries(names.map(name => [name, style.getPropertyValue(`--${name}`).trim()]));
    frame.contentWindow?.postMessage({ type: "pi-web-artifact-theme", dark: root.classList.contains("dark"), colors }, "*");
  };
  onSettled(() => {
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  });
  return <iframe ref={frame} title="HTML artifact preview" src="/artifact-preview" sandbox="allow-scripts" referrerpolicy="no-referrer" onLoad={() => {
    // An opaque origin requires '*'; the target is this specific frame, never a broadcast.
    frame.contentWindow?.postMessage({ type: "pi-web-artifact", html: props.html }, "*");
    sendTheme();
  }} />;
}

/** A completed static visual with an accessible full-screen view, isolated from application credentials. */
export function HtmlArtifact(props: { source: string }) {
  const [sourceVisible, setSourceVisible] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const html = createMemo(() => sanitizeArtifact(props.source));
  let trigger: HTMLButtonElement | undefined;
  const content = (fullscreen: boolean) => <>
    <div class="artifact-toolbar"><span>HTML preview</span><div>
      <Button type="button" aria-pressed={sourceVisible() ? "false" : "true"} onClick={() => setSourceVisible(false)}>Preview</Button>
      <Button type="button" aria-pressed={sourceVisible() ? "true" : "false"} onClick={() => setSourceVisible(true)}>Source</Button>
      <Button type="button" ref={element => { if (!fullscreen) trigger = element; }} aria-label={fullscreen ? "Close full screen" : undefined} aria-expanded={expanded() ? "true" : "false"} onClick={() => setExpanded(!fullscreen)}>{fullscreen ? "Close" : "Expand"}</Button>
    </div></div>
    <Show when={!sourceVisible()} fallback={<pre class="artifact-source"><code>{props.source}</code></pre>}>
      <ArtifactFrame html={html()} />
    </Show>
  </>;
  return <>
    <section class="html-artifact" aria-label="HTML preview">{content(false)}</section>
    <Show when={expanded()}>
      <ActionDialog title="HTML preview" description="Full-screen static visual. Switch between Preview and Source, or close to return to the conversation." hideHeading class="html-artifact artifact-fullscreen" returnFocus={trigger} close={() => setExpanded(false)}>
        {content(true)}
      </ActionDialog>
    </Show>
  </>;
}
