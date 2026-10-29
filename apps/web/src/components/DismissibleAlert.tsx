import { Show, createSignal } from "solid-js";
import { Button } from "@kobalte/core/button";
import { Icon } from "./Icon";

/** Hides a banner locally until its message changes or clears; leaves the source status intact. */
export function DismissibleAlert(props: { message: string | null | undefined; class: string; role?: "alert" | "status" }) {
  return <Show when={props.message} keyed>{message => {
    const [dismissed, setDismissed] = createSignal(false);
    return <Show when={!dismissed()}>
      <div class={`${props.class} dismissible-alert`}>
        <p role={props.role ?? "status"}>{message}</p>
        <Button type="button" class="icon-button" aria-label="Dismiss warning" title="Dismiss warning" onClick={() => setDismissed(true)}><Icon name="close" /></Button>
      </div>
    </Show>;
  }}</Show>;
}
