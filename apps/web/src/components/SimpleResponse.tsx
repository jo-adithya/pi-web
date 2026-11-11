import { Button } from "@kobalte/core/button";
import { Tooltip } from "@kobalte/core/tooltip";
import { For, Match, Show, Switch, createSignal, createUniqueId, onSettled } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { DisplayMessage, ResponseCard, ResponseCheckStatus, ResponseTimings, SimpleResponse as Response } from "../generated/protocol";
import type { CodeLocation } from "../code-reference";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";
import { CodeSnippet } from "./CodeSnippet";
import { Icon } from "./Icon";
import { ResponseCanvas, RecordedErrors } from "./ResponseCanvas";
import { ResponseGraphic, isGraphic } from "./ResponseGraphics";
import { responseText } from "../response-copy";
import "./simple-response.css";

const CHECK_LABELS: Record<ResponseCheckStatus, string> = { passed: "Passed", failed: "Failed", skipped: "Skipped", unverified: "Unverified" };

/** Renders a completed query as safe Markdown. The original renderer and optional copy text
 * can cover several assistant replies while the presentation stays attached to the final one. */
export function SimpleResponse(props: { message: DisplayMessage; original: () => JSX.Element; originalText?: () => string; loadOriginal?: (signal: AbortSignal) => Promise<string>; retry?: () => void; openCode?: (location: CodeLocation) => void }) {
  const [originalOpen, setOriginalOpen] = createSignal(false);
  const [originalText, setOriginalText] = createSignal<string>();
  const [originalBusy, setOriginalBusy] = createSignal(false);
  const [originalError, setOriginalError] = createSignal("");
  let originalRead: AbortController | undefined;
  onSettled(() => () => { originalRead?.abort(); setOriginalText(undefined); });
  /** Source text lives only in the open Original reader, never in the conversation store. */
  async function toggleOriginal() {
    originalRead?.abort(); setOriginalText(undefined); setOriginalError("");
    const next = !originalOpen(); setOriginalOpen(next); setOriginalBusy(false);
    if (!next || !props.loadOriginal) return;
    const controller = new AbortController(); originalRead = controller; setOriginalBusy(true);
    try {
      const text = await props.loadOriginal(controller.signal);
      if (!controller.signal.aborted) setOriginalText(text);
    } catch (error) { if (!controller.signal.aborted) setOriginalError(error instanceof Error ? error.message : "Original reply is unavailable."); }
    finally { if (!controller.signal.aborted) setOriginalBusy(false); }
  }
  const contentId = createUniqueId();
  const presentation = () => props.message.presentation;
  const response = () => { const value = presentation(); return value?.state === "ready" ? value.response : undefined; };
  const timings = () => { const value = presentation(); return value?.state === "ready" || value?.state === "error" ? value.timings : undefined; };
  const failure = () => { const value = presentation(); return value?.state === "error" ? value.message : ""; };
  const retryable = () => { const value = presentation(); return value?.state === "error" && value.retryable; };
  return <section class="simple-response" aria-label="Pi response" aria-busy={presentation()?.state === "pending" && !originalOpen() ? "true" : "false"}>
    <div id={contentId} class="simple-response-content" role="region" aria-label={originalOpen() ? "Original answer" : "Simple answer"}>
      <Show when={originalOpen()} fallback={<>
        <Show when={presentation()?.state === "pending"}><div class="simple-response-pending" role="status">
          <span class="simple-response-dot" aria-hidden="true" />
          <div><strong>{props.message.complete ? "Preparing your answer…" : "Working…"}</strong><p>{props.message.complete ? "Making Pi’s replies easier to read." : "Your answer will appear when Pi finishes."}</p></div>
        </div></Show>
        <Show when={response()}>{value => <>
          <Show when={value().canvas} fallback={<>
            <div class="simple-response-summary"><Markdown text={value().summary} complete allowArtifacts={false} openCode={props.openCode} /></div>
            <RecordedErrors recorded={value().recorded} />
            <Show when={value().blocks.length}><div class="simple-response-sections"><For each={value().blocks}>{card => <ResponseSection card={card} recorded={value().recorded} openCode={props.openCode} />}</For></div></Show>
          </>}>{plan => <ResponseCanvas response={value()} plan={plan()} openCode={props.openCode} renderBlock={card => <ResponseSection card={card} recorded={value().recorded} openCode={props.openCode} />} />}</Show>
        </>}</Show>
        <Show when={failure()}><div class="simple-response-error" role="alert">
          <Icon name="info" /><div><h3>Simple reply unavailable</h3><p>{failure()}</p><p class="simple-response-help">You can still view Pi’s original reply below.</p></div>
        </div>
          <Show when={retryable() && props.retry && !props.message.truncated}><Button class="simple-response-retry" type="button" aria-label="Retry simple response" onClick={() => props.retry?.()}><Icon name="refresh" />Try again</Button></Show>
        </Show>
        <Show when={props.message.error}><p class="warning">{props.message.error}</p></Show>
        <Show when={props.message.truncated}><p class="truncated">Original preview truncated. The full content remains with Pi.</p></Show>
      </>}>
        <Show when={!props.message.complete && !props.message.error}><p class="warning">This reply stopped before it finished.</p></Show>
        <Show when={!!props.loadOriginal} fallback={props.original()}>
          <Show when={originalBusy()}><p role="status">Loading original reply…</p></Show>
          <Show when={originalError()}><p role="alert">{originalError()}</p></Show>
          <Show when={originalText()}>{text => <Markdown text={text()} complete allowArtifacts={false} openCode={props.openCode} />}</Show>
        </Show>
      </Show>
    </div>
    <Show when={presentation()?.state !== "pending" || props.message.complete}><div class="simple-response-actions">
      <Button class="simple-response-view" type="button" aria-controls={contentId} onClick={() => { void toggleOriginal(); }}>{originalOpen() ? "Back to simple" : "View original"}</Button>
      <Show when={originalOpen() ? originalBusy() || originalError() ? undefined : "Copy original answer" : response() ? "Copy simple answer" : undefined} keyed>{label => <CopyButton label={label} text={() => originalOpen()
        ? originalText() ?? props.originalText?.() ?? props.message.blocks.filter(block => block.kind === "text").map(block => block.text).join("\n\n")
        : responseText(response()!)} />}</Show>
      <Show when={presentation()?.state === "ready" || presentation()?.state === "error"}><ResponseTimingInfo timings={timings()} /></Show>
    </div></Show>
  </section>;
}

/** Shows Pi work and formatting durations; cached measurements describe the original run. */
function ResponseTimingInfo(props: { timings?: ResponseTimings }) {
  const [open, setOpen] = createSignal(false);
  const [pinned, setPinned] = createSignal(false);
  const close = () => { setPinned(false); setOpen(false); };
  /** Shows subsecond timings in milliseconds and longer timings in rounded whole seconds and minutes. */
  const duration = (ms: number) => {
    if (ms < 1000) return `${ms} ms`;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds} s`;
    return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
  };
  return <Tooltip open={open() || pinned()} onOpenChange={setOpen} openDelay={200} placement="top" gutter={8}>
    <Tooltip.Trigger type="button" class="simple-response-timing-info" aria-label="About response timing"
      onClick={() => { setPinned(value => !value); setOpen(false); }} onBlur={close}><Icon name="info" /></Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content class="simple-response-timing-tooltip" onEscapeKeyDown={close} onPointerDownOutside={close}>
      <Show when={props.timings} fallback={<p>Timing wasn’t recorded for this reply.</p>}>{value => <>
        <Show when={value().cached}><p>Cached formatting. No new formatter model call. Timings are from the original run.</p></Show>
        <p class="simple-response-timing-model">{value().model}</p>
        <table>
          <caption>Response timing</caption>
          <tbody>
            <tr><th scope="row">{value().cached ? "Original Pi work" : "Pi’s work"}</th><td>{value().workMs !== undefined ? duration(value().workMs!) : "Not recorded"}</td></tr>
            <Show when={value().captureMs !== undefined}><tr><th scope="row">File comparison</th><td>{duration(value().captureMs!)}</td></tr></Show>
            <tr><th scope="row">Queue wait</th><td>{duration(value().queueMs)}</td></tr>
            <Show when={value().startupMs !== null}><tr><th scope="row">Formatter startup</th><td>{duration(value().startupMs!)}</td></tr></Show>
            <Show when={value().modelMs !== null}><tr><th scope="row">Model request</th><td>{duration(value().modelMs!)}</td></tr></Show>
            <Show when={value().firstTextMs !== null}><>
              <tr class="simple-response-timing-detail"><th scope="row">Wait for first text</th><td>{duration(value().firstTextMs!)}</td></tr>
              <tr class="simple-response-timing-detail"><th scope="row">Remaining output</th><td>{duration(value().modelMs! - value().firstTextMs!)}</td></tr>
            </></Show>
            <tr><th scope="row">Cleanup</th><td>{duration(value().cleanupMs)}</td></tr>
            <tr><th scope="row">{value().cached ? "Original formatting" : "Total formatting"}</th><td>{duration(value().totalMs)}</td></tr>
            <tr class="simple-response-timing-total"><th scope="row">{value().cached ? "Original total processing" : "Total processing"}</th><td>{value().workMs !== undefined ? duration(value().workMs! + value().totalMs) : "Not recorded"}</td></tr>
          </tbody>
        </table>
        <p>Pi’s work includes thinking, tools, and waiting before presentation preparation. Total processing adds formatting. Saving and browser delivery are not measured. First-text waiting is part of the formatter’s model request.</p>
      </>}</Show>
    </Tooltip.Content></Tooltip.Portal>
  </Tooltip>;
}

/** Presents one response component using app-owned structure and safe text rendering. */
function ResponseSection(props: { card: ResponseCard; recorded?: Response["recorded"]; openCode?: (location: CodeLocation) => void }) {
  const card = props.card;
  return <Show when={card.type === "details"} fallback={<section class={`simple-response-section${card.type === "warning" ? " simple-response-warning" : ""}`}>
    <h3>{card.type === "warning" ? "Warning: " : ""}{card.title}<Show when={card.type === "checks" || card.type === "facts"}><span class="simple-response-attribution">{" Reported by Pi"}</span></Show></h3>
    <Switch>
      <Match when={isGraphic(card) ? card : undefined}>{graphic => <ResponseGraphic card={graphic()} recorded={props.recorded} openCode={props.openCode} />}</Match>
      <Match when={card.type === "code" ? card : undefined}>{snippet => <CodeSnippet title={snippet().title} language={snippet().language} code={snippet().code} />}</Match>
      <Match when={card.type === "facts" ? card.items : undefined}>{facts => <dl class="simple-response-facts"><For each={facts()}>{fact => <div><dt>{fact.label}</dt><dd>{fact.value}</dd></div>}</For></dl>}</Match>
      <Match when={card.type === "comparison" ? card : undefined}>{comparison => <div class="simple-response-comparison">
        <div><h4>Before</h4><Markdown text={comparison().before} complete allowArtifacts={false} openCode={props.openCode} /></div>
        <div><h4>After</h4><Markdown text={comparison().after} complete allowArtifacts={false} openCode={props.openCode} /></div>
      </div>}</Match>
      <Match when={card.type === "flow" ? card.items : undefined}>{items => <ol class="simple-response-flow" role="list" aria-label={`Process flow: ${card.title}`}><For each={items()}>{(item, index) => <li>
        <div class="simple-response-flow-node"><Markdown text={item} complete allowArtifacts={false} openCode={props.openCode} /></div>
        <Show when={index() < items().length - 1}><span class="simple-response-flow-arrow" aria-hidden="true">→</span></Show>
      </li>}</For></ol>}</Match>
      <Match when={card.type === "table" ? card : undefined}>{table => <div class="simple-response-table-wrap" tabindex={0} role="region" aria-label={`Scrollable table: ${table().title}`}>
        <table class="simple-response-table" aria-label={table().title}>
          <thead><tr><For each={table().columns}>{column => <th scope="col">{column}</th>}</For></tr></thead>
          <tbody><For each={table().rows}>{row => <tr><For each={row}>{cell => <td><Markdown text={cell} complete allowArtifacts={false} openCode={props.openCode} /></td>}</For></tr>}</For></tbody>
        </table>
      </div>}</Match>
      <Match when={"text" in card ? card.text : undefined}>{text => <Markdown text={text()} complete allowArtifacts={false} openCode={props.openCode} />}</Match>
      <Match when={card.type === "checklist" ? card.items : undefined}>{items => <ul><For each={items()}>{item => <li><Markdown text={item} complete allowArtifacts={false} openCode={props.openCode} /></li>}</For></ul>}</Match>
      <Match when={card.type === "steps" ? card.items : undefined}>{items => <ol><For each={items()}>{item => <li><Markdown text={item} complete allowArtifacts={false} openCode={props.openCode} /></li>}</For></ol>}</Match>
      <Match when={card.type === "checks" ? card.items : undefined}>{items => <ul class="simple-response-checks"><For each={items()}>{item => <li><span class="simple-response-check-status" data-outcome={item.status}>{CHECK_LABELS[item.status]}</span><Markdown text={item.text} complete allowArtifacts={false} openCode={props.openCode} /></li>}</For></ul>}</Match>
    </Switch>
  </section>}>
    <details class="simple-response-section simple-response-details"><summary>{card.title}</summary><Markdown text={card.type === "details" ? card.text : ""} complete allowArtifacts={false} openCode={props.openCode} /></details>
  </Show>;
}

