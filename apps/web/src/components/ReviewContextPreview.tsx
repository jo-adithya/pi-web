import { Button } from "@kobalte/core/button";
import { Show, createMemo, createSignal } from "solid-js";
import type { DiffLine } from "../local-review";
import { Icon } from "./Icon";
import { ReviewCode } from "./ReviewDiffCard";

/** Keeps original diff coordinates visible while folding pre-hunk Git metadata. Non-hunk notices stay visible. */
export function ReviewContextPreview(props: { path: string; lines: readonly DiffLine[]; label: string }) {
  const [expanded, setExpanded] = createSignal(false);
  const parts = createMemo(() => {
    const firstHunk = props.lines.findIndex(line => line.kind === "header" && line.text.startsWith("@@ "));
    return firstHunk > 0 ? { metadata: props.lines.slice(0, firstHunk), code: props.lines.slice(firstHunk) } : { metadata: [], code: props.lines };
  });
  return <div class="review-selection-preview" aria-label={props.label}>
    <Show when={parts().metadata.length}>
      <Button type="button" class="review-metadata-toggle" aria-expanded={expanded() ? "true" : "false"} onClick={() => setExpanded(value => !value)}>{expanded() ? "Hide Git metadata" : "Show Git metadata"}<Icon name="chevronDown" /></Button>
      <Show when={expanded()}><ReviewCode path={props.path} lines={parts().metadata} /></Show>
    </Show>
    <ReviewCode path={props.path} lines={parts().code} />
  </div>;
}
