import { Button } from "@kobalte/core/button";
import { Tooltip } from "@kobalte/core/tooltip";
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, createUniqueId, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { DisplayMessage, ResponseCard, ResponseCheckStatus, ResponseTimings, SimpleResponse as Response } from "../generated/protocol";
import type { OpenCodeReference } from "../code-reference";
import type { ReplyArrival } from "../client-state";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";
import { CodeSnippet } from "./CodeSnippet";
import { Icon } from "./Icon";
import { ResponseCanvas, RecordedErrors } from "./ResponseCanvas";
import { ResponseGraphic, isGraphic } from "./ResponseGraphics";
import { checkLabels, rankedChecks } from "../response-plan";
import { responseText } from "../response-copy";
import "./simple-response.css";

const checkMarks: Record<ResponseCheckStatus, string> = { passed: "✓", failed: "×", skipped: "–", unverified: "?" };

interface InlineOriginal { render: () => JSX.Element; text: string }
interface SimpleResponseProps {
  message: DisplayMessage;
  arrival?: ReplyArrival;
  heading?: JSX.Element;
  /** Captures the retained source of this exchange when Original opens. */
  original?: () => InlineOriginal;
  loadOriginal?: (signal: AbortSignal) => Promise<string>;
  /** Runs the view change while preserving the toggle's position in the transcript. */
  switchView?: (anchor: HTMLElement, change: () => void) => void;
  retry?: () => void;
  save?: () => void;
  openCode?: OpenCodeReference;
}

/** Presents the simple answer and opens the full reply only on request or on failure. */
export function SimpleResponse(props: SimpleResponseProps) {
  const presentation = () => props.message.presentation;
  const phase = () => presentation()?.state;
  const [originalOpen, setOriginalOpen] = createSignal(phase() === "error");
  const [retrying, setRetrying] = createSignal(false);
  createEffect(phase, (next, previous) => {
    if (next === "error") setOriginalOpen(true);
    setRetrying(next === "pending" && previous === "error");
  });
  // Keep an open Original mounted even when saving releases its inline source.
  const inline = createMemo(() => originalOpen() ? untrack(() => props.original?.()) : undefined);
  const load = createMemo(() => originalOpen() && !inline() ? untrack(() => props.loadOriginal) : undefined);
  const [originalText, setOriginalText] = createSignal<string>();
  const [originalError, setOriginalError] = createSignal("");
  const [reload, setReload] = createSignal(0);
  createEffect(() => [load(), reload()] as const, ([read]) => {
    setOriginalText(undefined); setOriginalError("");
    if (!read) return;
    const controller = new AbortController();
    void read(controller.signal).then(text => {
      if (!controller.signal.aborted) setOriginalText(text);
    }, error => {
      if (!controller.signal.aborted) setOriginalError(error instanceof Error ? error.message : "Original reply is unavailable.");
    });
    return () => controller.abort();
  });
  const contentId = createUniqueId();
  const canSwitch = () => phase() !== "error" && props.message.complete && (originalOpen() || !!props.original || !!props.loadOriginal);
  function toggleOriginal(anchor: HTMLElement) {
    const change = () => setOriginalOpen(!originalOpen());
    if (props.switchView) props.switchView(anchor, change);
    else change();
  }
  const response = () => { const value = presentation(); return value?.state === "ready" || value?.state === "unsaved" ? value.response : undefined; };
  const timings = () => { const value = presentation(); return value?.state === "ready" || value?.state === "unsaved" || value?.state === "error" ? value.timings : undefined; };
  const [renderMs, setRenderMs] = createSignal<number>();
  createEffect(() => props.arrival?.renderStart, clock => {
    const started = clock?.();
    setRenderMs(started === undefined || originalOpen() || !response() ? undefined : Math.round(performance.now() - started));
  });
  const failure = () => {
    const value = presentation();
    if (value?.state !== "error") return "";
    return value.message.replace(
      /^Model returned an invalid simple response: trailing characters at line (\d+) column (\d+)$/,
      "Pi Web expected one JSON object for the simplified reply. The formatter added extra content after it (line $1, column $2).",
    );
  };
  const retryable = () => { const value = presentation(); return value?.state === "error" && value.retryable; };
  const copyLabel = () => originalOpen()
    ? inline() || originalText() !== undefined ? "Copy original answer" : undefined
    : response() ? "Copy simple answer" : undefined;
  const copyText = () => originalOpen() ? inline()?.text ?? originalText() ?? "" : responseText(response()!);
  const showTiming = () => !!response() || phase() === "error";
  const viewLabel = () => originalOpen() ? "Back to simple" : "View original";
  return <section class="simple-response" aria-label="Pi response">
    <header class="message-heading">{props.heading}</header>
    <div id={contentId} class="message-content simple-response-content" role="region" aria-label={originalOpen() ? "Original answer" : "Simple answer"}>
      <Show when={presentation()?.state === "unsaved"}><aside class="simple-response-error" role="status"><div>
        <strong>Summary ready · not saved.</strong> Copy it before leaving this conversation, or retry saving without another model call.{" "}
        <Show when={props.save}><Button type="button" class="simple-response-view" onClick={() => props.save?.()}>Retry saving</Button></Show>
      </div></aside></Show>
      <Show when={failure()}><aside class="simple-response-error" role="alert"><Icon name="info" /><div>
        <strong>Couldn’t simplify this reply.</strong> <Show when={retryable() && props.retry && !props.message.truncated}><Button type="button" class="simple-response-view" aria-label="Retry simple response" onClick={() => props.retry?.()}>Retry</Button></Show>
        <details><summary>Reason</summary><p>{failure()}</p></details>
      </div></aside></Show>
      <Show when={phase() === "pending" && (!originalOpen() || retrying())}>
        <p class="simple-response-pending" role="status">{retrying() ? "Simplifying…" : props.message.complete ? "Pi finished. Simplifying…" : "Working…"}</p>
      </Show>
      <Show when={!originalOpen()}>
        <Show when={response()}>{value => <>
          <Show when={value().canvas} fallback={<>
            <div class="simple-response-summary"><Markdown text={value().summary} complete allowArtifacts={false} openCode={props.openCode} /></div>
            <RecordedErrors recorded={value().recorded} />
            <Show when={value().blocks.length}><div class="simple-response-sections"><For each={value().blocks}>{card => <ResponseSection card={card} recorded={value().recorded} openCode={props.openCode} />}</For></div></Show>
          </>}>{plan => <ResponseCanvas response={value()} plan={plan()} openCode={props.openCode} renderBlock={card => <ResponseSection card={card} recorded={value().recorded} openCode={props.openCode} />} />}</Show>
        </>}</Show>
        <Show when={props.message.error}><p class="warning">{props.message.error}</p></Show>
        <Show when={props.message.truncated}><p class="truncated">Original preview truncated. The full content remains with Pi.</p></Show>
      </Show>
      <Show when={originalOpen()}>
        <Show when={!props.message.complete && !props.message.error}><p class="warning">This reply stopped before it finished.</p></Show>
        <Show when={inline()}>{source => source().render()}</Show>
        <Show when={load()}>
          <Show when={originalText() === undefined && !originalError()}><p role="status">Loading original reply…</p></Show>
          <Show when={originalError()}><p role="alert">{originalError()} <button type="button" class="simple-response-view" onClick={() => setReload(value => value + 1)}>Reload original</button></p></Show>
          <Show when={originalText()}>{text => <Markdown text={text()} complete allowArtifacts={false} openCode={props.openCode} />}</Show>
        </Show>
        <Show when={!inline() && !load()}><p>Original reply is unavailable.</p></Show>
      </Show>
    </div>
    <Show when={canSwitch() || !!copyLabel() || showTiming()}>
      <footer class="simple-response-actions">
        <Show when={canSwitch()}><Button type="button" aria-label={viewLabel()} title={viewLabel()} aria-controls={contentId} onClick={event => toggleOriginal(event.currentTarget)}>
          <Icon name={originalOpen() ? "shortText" : "document"} />
        </Button></Show>
        <Show when={copyLabel()} keyed>{label => <CopyButton label={label} iconOnly text={copyText} />}</Show>
        <Show when={showTiming()}><ResponseTimingInfo timings={timings()} arrival={props.arrival} renderMs={renderMs()} /></Show>
      </footer>
    </Show>
  </section>;
}

/** Separates historical Pi/formatter work from delivery of the current reply. */
function ResponseTimingInfo(props: { timings?: ResponseTimings; arrival?: ReplyArrival; renderMs?: number }) {
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
  const delivery = () => props.timings?.saveMs !== undefined || props.arrival?.queueMs !== undefined || props.renderMs !== undefined;
  return <Tooltip open={open() || pinned()} onOpenChange={setOpen} openDelay={200} placement="top" gutter={8}>
    <Tooltip.Trigger type="button" aria-label="About response timing"
      onClick={() => { setPinned(value => !value); setOpen(false); }} onBlur={close}><Icon name="info" /></Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content class="simple-response-timing-tooltip" onEscapeKeyDown={close} onPointerDownOutside={close}>
      <Show when={props.timings} fallback={<p>{delivery() ? "Work and formatting times weren’t recorded." : "Timing wasn’t recorded for this reply."}</p>}>{value => <>
        <Show when={value().cached}><p>Cached formatting. No new formatter model call. Work and formatting times are from the original run.</p></Show>
        <p class="simple-response-timing-model">{value().model === "direct" ? "Short reply · original text, no formatter model call" : value().model}</p>
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
        <p>Total processing adds Pi’s work and formatting. First-text waiting is part of the model request.</p>
      </>}</Show>
      <Show when={delivery()}><table>
        <caption>This delivery</caption>
        <tbody>
          <Show when={props.timings?.saveMs !== undefined}><tr><th scope="row">Save attempt</th><td>{duration(props.timings!.saveMs!)}</td></tr></Show>
          <Show when={props.arrival?.queueMs !== undefined}><tr><th scope="row">WebSocket queue</th><td>{duration(props.arrival!.queueMs!)}</td></tr></Show>
          <Show when={props.arrival?.sendMs !== undefined}><tr><th scope="row">WebSocket write</th><td>{duration(props.arrival!.sendMs!)}</td></tr></Show>
          <Show when={props.renderMs !== undefined}><tr><th scope="row">Browser receipt to render</th><td>{duration(props.renderMs!)}</td></tr></Show>
        </tbody>
      </table><p>WebSocket write ends on the server. Browser render ends when the reply is placed in the page, before paint. Network transit is not measured.</p></Show>
    </Tooltip.Content></Tooltip.Portal>
  </Tooltip>;
}

/** Titles indicate intent only for saved comparisons that predate the mode field. */
function comparisonMode(card: Extract<ResponseCard, { type: "comparison" }>) {
  return card.mode ?? (card.left.title === "Before" && card.right.title === "After" ? "change" : "alternatives");
}

/** Presents one response component using app-owned structure and safe text rendering. */
function ResponseSection(props: { card: ResponseCard; recorded?: Response["recorded"]; openCode?: OpenCodeReference }) {
  const card = props.card;
  // Infer purpose from the old reserved headings only for saved tables without metadata.
  const purpose = card.type === "table" ? card.purpose ?? (
    card.columns.length === 2 && card.columns[0].trim().toLowerCase() === "if" && card.columns[1].trim().toLowerCase() === "then" ? "conditional"
      : card.columns.length >= 2 && card.columns.length <= 5 && card.columns[0].trim().toLowerCase() === "option" ? "decision" : "data"
  ) : undefined;
  const decision = purpose === "decision";
  const stacked = purpose === "conditional" || (card.type === "table" && decision && card.columns.length <= 5);
  return <Show when={card.type === "details"} fallback={<section class={`simple-response-section${card.type === "warning" ? " simple-response-warning" : ""}`} data-type={card.type}>
    <h3>{card.type === "warning" ? "Warning: " : ""}{card.title}<Show when={card.type === "path" && card.status}>{status => <span class="response-path-status">{status()}</span>}</Show><Show when={card.type === "checks" || card.type === "facts"}><span class="simple-response-attribution">{" Reported by Pi"}</span></Show></h3>
    <Switch>
      <Match when={isGraphic(card) ? card : undefined}>{graphic => <ResponseGraphic card={graphic()} recorded={props.recorded} openCode={props.openCode} />}</Match>
      <Match when={card.type === "code" ? card : undefined}>{snippet => <CodeSnippet title={snippet().title} language={snippet().language} code={snippet().code} snippetDiff={snippet().snippetDiff} />}</Match>
      <Match when={card.type === "facts" ? card.items : undefined}>{facts => <dl class="simple-response-facts"><For each={facts()}>{fact => <div><dt>{fact.label}</dt><dd><Markdown text={fact.value} complete allowArtifacts={false} openCode={props.openCode} /></dd></div>}</For></dl>}</Match>
      <Match when={card.type === "comparison" ? card : undefined}>{comparison => <div class="simple-response-comparison" data-mode={comparisonMode(comparison())}>
        <div><h4>{comparison().left.title}</h4><Markdown text={comparison().left.text} complete allowArtifacts={false} openCode={props.openCode} /></div>
        <div><h4>{comparison().right.title}</h4><Markdown text={comparison().right.text} complete allowArtifacts={false} openCode={props.openCode} /></div>
      </div>}</Match>
      <Match when={card.type === "flow" ? card.items : undefined}>{items => <ol class="simple-response-flow" role="list" aria-label={`Process flow: ${card.title}`}><For each={items()}>{(item, index) => <li>
        <div class="simple-response-flow-node"><Markdown text={item} complete allowArtifacts={false} openCode={props.openCode} /></div>
        <Show when={index() < items().length - 1}><span class="simple-response-flow-arrow" aria-hidden="true">→</span></Show>
      </li>}</For></ol>}</Match>
      <Match when={card.type === "table" ? card : undefined}>{table => <div class="simple-response-table-wrap" tabindex={0} role="region" aria-label={`Scrollable table: ${table().title}`}>
        <table class="simple-response-table" data-stacked={stacked ? "true" : undefined} role="table" aria-label={table().title}>
          <thead role="rowgroup"><tr role="row"><For each={table().columns}>{column => <th role="columnheader" scope="col">{column}</th>}</For></tr></thead>
          <tbody role="rowgroup"><For each={table().rows}>{row => <tr role="row"><For each={row}>{(cell, index) =>
            <Show when={decision && index() === 0} fallback={<td role="cell">
              <Show when={stacked}><span class="simple-table-label" aria-hidden="true">{table().columns[index()]}</span></Show>
              <Markdown text={cell} complete allowArtifacts={false} openCode={props.openCode} />
            </td>}><th role="rowheader" scope="row"><Markdown text={cell} complete allowArtifacts={false} openCode={props.openCode} /></th></Show>
          }</For></tr>}</For></tbody>
        </table>
      </div>}</Match>
      <Match when={"text" in card ? card.text : undefined}>{text => <Markdown text={text()} complete allowArtifacts={false} openCode={props.openCode} />}</Match>
      <Match when={card.type === "checklist" ? card.items : undefined}>{items => <ul><For each={items()}>{item => <li><Markdown text={item} complete emphasizeLeadIn openCode={props.openCode} /></li>}</For></ul>}</Match>
      <Match when={card.type === "steps" ? card.items : undefined}>{items => <ol><For each={items()}>{item => <li><Markdown text={item} complete emphasizeLeadIn openCode={props.openCode} /></li>}</For></ol>}</Match>
      <Match when={card.type === "checks" ? card.items : undefined}>{items => <ul class="simple-response-checks"><For each={rankedChecks(items())}>{item => <li><span class="simple-response-check-status" data-outcome={item.status}><span aria-hidden="true">{checkMarks[item.status]} </span>{checkLabels[item.status]}</span><div><Markdown text={item.text} complete allowArtifacts={false} openCode={props.openCode} /></div></li>}</For></ul>}</Match>
    </Switch>
  </section>}>
    <details class="simple-response-section simple-response-details"><summary>{card.title}</summary><Markdown text={card.type === "details" ? card.text : ""} complete allowArtifacts={false} openCode={props.openCode} /></details>
  </Show>;
}

