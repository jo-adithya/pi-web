import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import { Button } from "@kobalte/core/button";
import type { ReviewCard, ReviewCardFile } from "../review-cards";
import { diffLines, reviewScopeLabel, type DiffLine, type ReviewFile, type ReviewLoadRequest } from "../local-review";
import { highlightDiff } from "../review-highlight";
import { Icon } from "./Icon";
import "./review-diff-card.css";

export type ReviewPreviewLoader = (request: ReviewLoadRequest & { path: string }, signal: AbortSignal) => Promise<ReviewFile>;

/** Discloses browser-only review snapshots separately from the references sent to Pi. */
export function ReviewDiffCard(props: { card: ReviewCard; load?: ReviewPreviewLoader }) {
  const [open, setOpen] = createSignal(false);
  return <details class="chat-review-card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Icon name="code" /><span class="chat-review-title"><strong>{props.card.files.length === 1 ? props.card.files[0].path : `${props.card.files.length} changed files`}</strong><span>{reviewScopeLabel(props.card.target)} · {props.card.selection ? props.card.ambiguous ? "Selected lines" : `${props.card.files[0]?.lines?.length ?? 0} selected lines` : "Changes"}</span></span><span class="chat-review-badge">References only</span><Icon name="chevronDown" /></summary>
    <Show when={open()}><div class="chat-review-content">
      <p>Pi received file and line references, not this code. Captured previews stay in this browser tab.</p>
      <For each={props.card.files}>{file => <ReviewCardFileView file={file} card={props.card} load={props.load} single={props.card.files.length === 1} />}</For>
      <details class="chat-review-references"><summary>View references sent to Pi</summary><pre>{props.card.reference}</pre></details>
    </div></Show>
  </details>;
}

/** Missing snapshots can be inspected explicitly as current diffs, never mistaken for captured code. */
function ReviewCardFileView(props: { file: ReviewCardFile; card: ReviewCard; single: boolean; load?: ReviewPreviewLoader }) {
  const [open, setOpen] = createSignal(props.single);
  const [current, setCurrent] = createSignal<DiffLine[]>();
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  const controller = new AbortController();
  onSettled(() => () => controller.abort());
  async function load() {
    if (!props.load || busy()) return;
    setBusy(true); setError("");
    try {
      const file = await props.load({ ...props.card.target, path: props.file.path }, controller.signal);
      if (!controller.signal.aborted) setCurrent(diffLines(file.patch));
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Diff unavailable."); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <details class="chat-review-file" open={props.single} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><strong>{props.file.path}</strong><span>{props.file.status}</span></summary>
    <Show when={open()}>
      <Show when={props.file.previousPath}><p>Previously {props.file.previousPath}</p></Show>
      <Show when={props.file.lines ?? current()} fallback={<div class="chat-review-missing"><p>{props.card.ambiguous ? "These references were reused for different code; the original preview is unavailable." : "No diff was captured for this file."}</p><Button type="button" disabled={!props.load || busy()} onClick={load}>{busy() ? "Loading…" : "Load current diff"}</Button></div>}>{lines => <>
        <p class="chat-review-caption">{props.file.lines ? "Captured preview" : "Current diff · may differ from the original review"}</p>
        <ReviewCode path={props.file.path} lines={lines()} />
      </>}</Show>
      <Show when={error()}><p role="alert">{error()}</p></Show>
    </Show>
  </details>;
}

/** Reuses safe syntax tokens while retaining the excerpt's original old/new coordinates. */
export function ReviewCode(props: { path: string; lines: readonly DiffLine[] }) {
  const rows = createMemo(() => {
    // A synthetic hunk enables highlighting selections without adding it to the visible excerpt.
    const highlighted = highlightDiff(props.path, `@@ -1 +1 @@\n${props.lines.map(line => line.text).join("\n")}`).lines.slice(1);
    return props.lines.map((line, index) => ({ ...line, tokens: highlighted[index]?.tokens }));
  });
  return <div class="chat-review-code" role="region" aria-label={`Diff for ${props.path}`} tabindex={0}>
    <For each={rows()}>{line => <div class={`chat-review-line ${line.kind}`}>
      <span class="chat-review-number" title="Old line">{line.old ?? ""}</span><span class="chat-review-number" title="New line">{line.next ?? ""}</span>
      <code><Show when={line.tokens} fallback={line.text}>{tokens => <>{line.text[0]}<For each={tokens()}>{token => <span class={token.className}>{token.text}</span>}</For></>}</Show></code>
    </div>}</For>
  </div>;
}
