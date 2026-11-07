import { Show, onSettled } from "solid-js";
import { Button } from "@kobalte/core/button";
import { Icon } from "./Icon";

/** Shows the current notice for five seconds; hover or keyboard focus pauses dismissal. */
export function Toast(props: { message: string | null | undefined; dismiss: () => void }) {
  return <Show when={props.message} keyed>{message => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hovered = false;
    let focused = false;
    const pause = () => clearTimeout(timer);
    const resume = () => {
      pause();
      if (!hovered && !focused) timer = setTimeout(props.dismiss, 5000);
    };
    onSettled(() => { resume(); return pause; });
    return <div class="toast" onPointerEnter={() => { hovered = true; pause(); }} onPointerLeave={() => { hovered = false; resume(); }}
      onFocusIn={() => { focused = true; pause(); }} onFocusOut={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { focused = false; resume(); }
      }}>
      <Icon name="info" />
      <p role="status" aria-atomic="true">{message}</p>
      <Button type="button" class="icon-button" aria-label="Dismiss notice" title="Dismiss notice" onClick={props.dismiss}><Icon name="close" /></Button>
    </div>;
  }}</Show>;
}
