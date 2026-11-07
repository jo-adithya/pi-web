import { Tooltip } from "@kobalte/core/tooltip";
import { createSignal } from "solid-js";
import type { ReviewLineStats } from "../local-review";
import { Icon } from "./Icon";

/** Keeps filtered totals stable while exposing the scope-wide breakdown on hover, focus, or tap. */
export function ReviewLineTotals(props: { stats: ReviewLineStats }) {
  const [open, setOpen] = createSignal(false);
  const [pinned, setPinned] = createSignal(false);
  const close = () => { setPinned(false); setOpen(false); };
  return <span class="review-line-stats" role="group" aria-label="Line changes">
    <span class="review-added">+{props.stats.added.toLocaleString()} added</span>
    <span class="review-removed">−{props.stats.removed.toLocaleString()} deleted</span>
    <Tooltip open={open() || pinned()} onOpenChange={setOpen} openDelay={200} placement="bottom" gutter={8}>
      <Tooltip.Trigger type="button" class="review-totals-info" aria-label="About line totals"
        onClick={() => { setPinned(value => !value); setOpen(false); }} onBlur={close}>
        <Icon name="info" />
      </Tooltip.Trigger>
      <Tooltip.Portal><Tooltip.Content class="review-totals-tooltip" onEscapeKeyDown={close} onPointerDownOutside={close}>
        <table>
          <caption>Line changes</caption>
          <thead><tr><th scope="col">Lines</th><th scope="col">Shown</th><th scope="col">Excluded</th><th scope="col">Total</th></tr></thead>
          <tbody>
            <tr><th scope="row" class="review-added">Added</th><td>{props.stats.added.toLocaleString()}</td><td>{(props.stats.totalAdded - props.stats.added).toLocaleString()}</td><td>{props.stats.totalAdded.toLocaleString()}</td></tr>
            <tr><th scope="row" class="review-removed">Deleted</th><td>{props.stats.removed.toLocaleString()}</td><td>{(props.stats.totalRemoved - props.stats.removed).toLocaleString()}</td><td>{props.stats.totalRemoved.toLocaleString()}</td></tr>
          </tbody>
        </table>
        <p>Shown counts exclude tests, generated files, lockfiles, and .md files. Totals include files omitted by display limits.</p>
      </Tooltip.Content></Tooltip.Portal>
    </Tooltip>
  </span>;
}
