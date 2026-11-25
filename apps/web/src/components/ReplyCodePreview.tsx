import { Button } from "@kobalte/core/button";
import { Show, createEffect, createSignal, onSettled, type Element } from "solid-js";
import type { CodeLocation } from "../code-reference";
import { diffLines, type DiffLine } from "../local-review";
import type { ReviewCardFile } from "../review-cards";
import type { SourcePreview } from "../workspace-files";
import { ActionDialog } from "./ActionDialog";
import { ReviewCode, type ReviewPreviewLoader } from "./ReviewDiffCard";
import "./reply-code-preview.css";

/** Selects a bounded excerpt around a cited coordinate, or no rows if it is absent. */
function around(rows: readonly DiffLine[], firstLine: number, deleted: boolean): readonly DiffLine[] {
  const found = rows.findIndex(row => (deleted ? row.old : row.next) === firstLine);
  if (found < 0) return [];
  let start = found, end = found + 1;
  while (start > Math.max(0, found - 8) && rows[start - 1].kind !== "header") start--;
  while (end < Math.min(rows.length, found + 16) && rows[end].kind !== "header") end++;
  return rows.slice(start, end);
}

type Preview = { rows: readonly DiffLine[]; caption: string; deleted?: boolean };

/** Shows the captured review excerpt when it matches. Current code is labeled separately;
 * it loads on request unless automatic fallback is enabled and there is no attached capture.
 */
export function ReplyCodePreview(props: {
  location: CodeLocation; trigger: HTMLElement; narrow: boolean; close: () => void; openChanges?: () => void;
  captured?: ReviewCardFile | null; autoLoadCurrent: boolean; loadDiff: ReviewPreviewLoader;
  loadSource: (path: string, line: number, signal: AbortSignal) => Promise<SourcePreview>;
}) {
  const { path, line } = props.location;
  const captured = props.captured?.lines ? around(props.captured.lines, line, props.captured.status === "deleted") : [];
  const [preview, setPreview] = createSignal<Preview | undefined>(captured.length ? { rows: captured, caption: "Captured review excerpt", deleted: props.captured?.status === "deleted" } : undefined);
  const hasCapture = props.captured !== undefined;
  const [request, setRequest] = createSignal<"diff" | "source" | undefined>(!hasCapture && props.autoLoadCurrent ? "diff" : undefined);
  const [notice, setNotice] = createSignal(captured.length ? "" : hasCapture || !props.autoLoadCurrent ? "No captured review excerpt is available for this location." : "");
  createEffect(request, next => {
    if (!next) return;
    const controller = new AbortController();
    setNotice("Loading current code…");
    const load = next === "diff"
      ? props.loadDiff({ scope: "unstaged", path }, controller.signal).then(file => {
        const rows = around(diffLines(file.patch), line, file.status === "deleted");
        if (!rows.length) throw new Error("No matching hunk.");
        return { rows, caption: "Current unstaged changes · not a captured diff", deleted: file.status === "deleted" };
      })
      : props.loadSource(path, line, controller.signal).then(source => ({
        rows: source.text.split("\n").map((text, index): DiffLine => ({ kind: "context", next: source.firstLine + index, text: ` ${text}` })),
        caption: "Current workspace file · not a captured diff",
      }));
    void load.then(value => {
      if (controller.signal.aborted) return;
      setPreview(value); setNotice("");
    }, () => {
      if (!controller.signal.aborted) setNotice(next === "diff" ? "No current diff excerpt is available for this line." : "The current file could not be opened.");
    });
    return () => controller.abort();
  });
  const title = `${path}:${line}${props.location.endLine > line ? `–${props.location.endLine}` : ""}`;
  const body = () => <>
    <Show when={preview()}>{view => <><p class="reply-code-caption">{view().caption}</p>
      <ReviewCode path={path} lines={view().rows} highlight={{ ...props.location, side: view().deleted ? "old" : "next" }} />
    </>}</Show>
    <Show when={notice()}><p class="reply-code-caption" role="status">{notice()}</p></Show>
    <Show when={!request() && !preview()}><Button type="button" onClick={() => setRequest("diff")}>Show current diff</Button></Show>
    <Show when={request() !== "source" && !preview()}><Button type="button" onClick={() => setRequest("source")}>Show current file</Button></Show>
    <Show when={props.openChanges}><Button type="button" onClick={() => props.openChanges?.()}>Open in Changes</Button></Show>
  </>;
  return <Show when={props.narrow} fallback={<DesktopPreview title={title} close={props.close}>{body()}</DesktopPreview>}>
    <ActionDialog title={title} description="Code reference" class="reply-code-sheet" close={props.close} returnFocus={props.trigger}>
      {body()}
      <div class="dialog-actions"><Button type="button" onClick={props.close}>Close preview</Button></div>
    </ActionDialog>
  </Show>;
}

function DesktopPreview(props: { title: string; close: () => void; children: Element }) {
  let close!: HTMLButtonElement;
  onSettled(() => close.focus({ preventScroll: true }));
  return <aside class="reply-code-preview" aria-label="Code reference" onKeyDown={event => {
    if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); props.close(); }
  }}>
    <header><h2>{props.title}</h2><Button ref={close} type="button" onClick={props.close}>Close preview</Button></header>
    {props.children}
  </aside>;
}
