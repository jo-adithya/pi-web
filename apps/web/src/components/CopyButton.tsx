import { createSignal, onSettled } from "solid-js";
import { Button } from "@kobalte/core/button";
import { Icon } from "./Icon";

/** Copies the supplied plain text on demand, with local success or recovery feedback. */
export function CopyButton(props: { label: string; iconOnly?: boolean; text: () => string }) {
  const [message, setMessage] = createSignal("");
  const copied = () => message() === "Copied";
  const [busy, setBusy] = createSignal(false);
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onSettled(() => () => { disposed = true; clearTimeout(timer); });
  async function copy() {
    if (busy()) return;
    clearTimeout(timer); setBusy(true); setMessage("");
    try {
      await navigator.clipboard.writeText(props.text());
      if (!disposed) setMessage("Copied");
    } catch {
      if (!disposed) setMessage("Could not copy; select the text and copy manually.");
    } finally {
      if (!disposed) {
        setBusy(false);
        timer = setTimeout(() => setMessage(""), 4000);
      }
    }
  }
  return <span class="copy-action">
    <Button type="button" class="copy-button" aria-label={props.label} title={props.iconOnly ? (copied() ? "Copied" : props.label) : undefined} disabled={busy()} onClick={copy}>
      {props.iconOnly ? <Icon name={copied() ? "check" : "copy"} /> : copied() ? "Copied" : props.label}
    </Button>
    <span class={copied() ? "sr-only" : "copy-status"} role="status">{message()}</span>
  </span>;
}
