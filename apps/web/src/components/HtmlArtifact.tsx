import { Button } from "@kobalte/core/button";
import { Show, createMemo, createSignal, onSettled } from "solid-js";
import { artifactChartJs } from "../artifact-library";
import { sanitizeArtifact } from "../html-artifact";
import { ActionDialog } from "./ActionDialog";

type ArtifactTheme = { type: "pi-web-artifact-theme"; dark: boolean; colors: Record<string, string> };
const themeNames = "background foreground card card-foreground muted muted-foreground primary primary-foreground primary-muted primary-border error error-foreground error-muted error-border success success-foreground success-muted success-border warning warning-foreground warning-muted warning-border info info-foreground info-muted info-border cyan cyan-foreground cyan-muted cyan-border orange orange-foreground orange-muted orange-border pink pink-foreground pink-muted pink-border border accent accent-foreground secondary secondary-foreground radius".split(" ");
const themeSubscribers = new Set<(theme: ArtifactTheme) => void>();
let themeObserver: MutationObserver | undefined;

/** Derives the preview palette, reversing canvas/card surfaces only inside visuals. */
function artifactTheme(): ArtifactTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const colors = Object.fromEntries(themeNames.map(name => [name, style.getPropertyValue(`--${name}`).trim()]));
  const dark = root.classList.contains("dark");
  [colors.background, colors.card] = [colors.card, colors.background];
  return { type: "pi-web-artifact-theme", dark, colors };
}

/** Shares one observer and palette read per change; the final unsubscribe releases it. */
function subscribeTheme(send: (theme: ArtifactTheme) => void): () => void {
  themeSubscribers.add(send);
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      const theme = artifactTheme();
      for (const subscriber of themeSubscribers) subscriber(theme);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  }
  return () => {
    themeSubscribers.delete(send);
    if (!themeSubscribers.size) {
      themeObserver?.disconnect();
      themeObserver = undefined;
    }
  };
}

/** Delivers sanitized markup and live theme colors to one opaque-origin viewer. */
function ArtifactFrame(props: { html: string; height?: number; onHeight?: (height: number) => void }) {
  let frame!: HTMLIFrameElement;
  const [error, setError] = createSignal("");
  let disposed = false;
  let loads = 0;
  const sendTheme = (theme: ArtifactTheme) => {
    if (!disposed && loads === 1) frame.contentWindow?.postMessage(theme, "*");
  };
  onSettled(() => {
    const unsubscribe = subscribeTheme(sendTheme);
    // Opaque-origin messages are authenticated by window identity, not origin.
    const resize = (event: MessageEvent) => {
      const data = event.data;
      if (disposed || loads !== 1 || event.source !== frame.contentWindow || data?.type !== "pi-web-artifact-size") return;
      if (typeof data.height !== "number" || !Number.isFinite(data.height) || data.height < 80 || data.height > 20000) return;
      props.onHeight?.(Math.ceil(data.height));
    };
    window.addEventListener("message", resize);
    return () => { disposed = true; unsubscribe(); window.removeEventListener("message", resize); };
  });
  const load = async () => {
    if (++loads !== 1) return;
    try {
      const chartJs = await artifactChartJs(props.html);
      if (disposed || loads !== 1) return;
      // An opaque origin requires '*'; delivery is limited to the initial document.
      frame.contentWindow?.postMessage({ type: "pi-web-artifact", html: props.html, theme: artifactTheme(), ...(chartJs === undefined ? {} : { chartJs }) }, "*");
    } catch {
      if (!disposed && loads === 1) setError("Unable to load Chart.js. Reload the page to retry, or open Source to inspect the preview.");
    }
  };
  return <>
    <Show when={error()}><p role="alert">{error()}</p></Show>
    <iframe ref={frame} style={{ height: props.height === undefined ? undefined : `${props.height}px` }} title="HTML artifact preview" src="/artifact-preview" sandbox="allow-scripts" referrerpolicy="no-referrer" onLoad={load} />
  </>;
}

/** An interactive visual whose viewer runs near the viewport or in the accessible full-screen dialog. */
export function HtmlArtifact(props: { source: string }) {
  const [sourceVisible, setSourceVisible] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [height, setHeight] = createSignal(160);
  const [collapsed, setCollapsed] = createSignal(false);
  const [visible, setVisible] = createSignal(typeof IntersectionObserver === "undefined");
  const html = createMemo(() => sanitizeArtifact(props.source));
  let container!: HTMLElement;
  let trigger: HTMLButtonElement | undefined;
  onSettled(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "200px" });
    observer.observe(container);
    return () => observer.disconnect();
  });
  const content = (fullscreen: boolean) => <>
    <div class="artifact-toolbar" role="group" aria-label="Preview controls"><div>
      <Button type="button" aria-pressed={!sourceVisible() && (fullscreen || !collapsed()) ? "true" : "false"} onClick={() => { setSourceVisible(false); if (!fullscreen) setCollapsed(false); }}>Preview</Button>
      <Button type="button" aria-pressed={sourceVisible() && (fullscreen || !collapsed()) ? "true" : "false"} onClick={() => { setSourceVisible(true); if (!fullscreen) setCollapsed(false); }}>Source</Button>
      <Show when={!fullscreen}>
        <Button type="button" aria-expanded={collapsed() ? "false" : "true"} onClick={() => setCollapsed(!collapsed())}>{collapsed() ? "Show" : "Collapse"}</Button>
      </Show>
      <Button type="button" ref={element => { if (!fullscreen) trigger = element; }} aria-label={fullscreen ? "Close full screen" : undefined} aria-expanded={expanded() ? "true" : "false"} onClick={() => setExpanded(!fullscreen)}>{fullscreen ? "Close" : "Expand"}</Button>
    </div></div>
    <Show when={fullscreen || !collapsed()}>
      <Show when={!sourceVisible()} fallback={<pre class="artifact-source"><code>{props.source}</code></pre>}>
        <Show when={fullscreen || (!expanded() && visible())} fallback={<div class="artifact-placeholder" style={{ height: `${height()}px` }} aria-hidden="true" />}>
          <ArtifactFrame html={html()} height={fullscreen ? undefined : height()} onHeight={fullscreen ? undefined : setHeight} />
        </Show>
      </Show>
    </Show>
  </>;
  return <>
    <section ref={container} class="html-artifact" data-collapsed={collapsed()} data-source={sourceVisible()} aria-label="HTML preview">{content(false)}</section>
    <Show when={expanded()}>
      <ActionDialog title="HTML preview" description="Full-screen interactive visual. Switch between Preview and Source, or close to return to the conversation." hideHeading class="html-artifact artifact-fullscreen" returnFocus={trigger} close={() => setExpanded(false)}>
        {content(true)}
      </ActionDialog>
    </Show>
  </>;
}
