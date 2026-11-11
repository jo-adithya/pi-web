import { Show, createMemo, createSignal, onSettled } from "solid-js";
import { Button } from "@kobalte/core/button";
import type { CodeLocation } from "../code-reference";
import type { SourcePreview } from "../workspace-files";
import type { DiffLine } from "../local-review";
import { ActionDialog } from "./ActionDialog";
import { ReviewCode } from "./ReviewDiffCard";

/** Previews current source when a reference is outside the selected diff. */
export function SourceReferenceDialog(props: { location: CodeLocation; load: (path: string, line: number, signal: AbortSignal) => Promise<SourcePreview>; close: () => void }) {
  const [source, setSource] = createSignal<SourcePreview>();
  const [error, setError] = createSignal("");
  const lines = createMemo((): DiffLine[] => source()?.text.split("\n").map((text, index) => ({ kind: "context", next: source()!.firstLine + index, text: ` ${text}` })) ?? []);
  onSettled(() => {
    const controller = new AbortController();
    void props.load(props.location.path, props.location.line, controller.signal).then(value => {
      if (!controller.signal.aborted) setSource(value);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Source unavailable."); });
    return () => controller.abort();
  });
  return <ActionDialog title={`${props.location.path}:${props.location.line}`} description="Current workspace source, not a historical or captured diff. No content is sent to Pi." close={props.close} class="review-selection-dialog">
    <Show when={source()} fallback={<p role="status">{error() || "Loading source…"}</p>}><ReviewCode path={props.location.path} lines={lines()} highlight={props.location} /></Show>
    <div class="dialog-actions"><Button type="button" onClick={props.close}>Close source</Button></div>
  </ActionDialog>;
}
