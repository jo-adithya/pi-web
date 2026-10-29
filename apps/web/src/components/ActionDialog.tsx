import { Dialog } from "@kobalte/core/dialog";
import { Button } from "@kobalte/core/button";
import type { Element } from "solid-js";

/** Resolve a dropdown's stable trigger before its transient menu is removed. */
export function dialogReturnFocus() {
  const active = document.activeElement;
  const menu = active?.closest('[role="menu"]');
  const triggerId = menu?.getAttribute("aria-labelledby");
  return (triggerId ? document.getElementById(triggerId) : null) ?? active;
}

/** A task-owned modal. Dismissal cancels; only its explicit action submits. */
export function ActionDialog(props: { title: string; description: string; close: () => void; class?: string; returnFocus?: globalThis.Element | null; children: Element }) {
  const previous = props.returnFocus ?? dialogReturnFocus();
  return <Dialog open onOpenChange={open => { if (!open) props.close(); }}>
    <Dialog.Portal>
      <Dialog.Overlay class="action-overlay" onClick={props.close} />
      <Dialog.Content class={`action-dialog ${props.class ?? ""}`} onCloseAutoFocus={event => {
        event.preventDefault();
        if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      }} onKeyDown={event => {
        if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); props.close(); }
        // Alpha's focus trap counts disabled actions as tab stops; wrap using enabled controls.
        if (event.key === "Tab") {
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, input:not([type="hidden"]), textarea, select, a[href], [tabindex]')]
            .filter(control => control.tabIndex >= 0 && !control.matches(":disabled") && !control.closest("[hidden], [inert]"));
          const first = controls[0]; const last = controls.at(-1);
          if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
            event.preventDefault(); event.stopPropagation();
            (event.shiftKey ? last : first)?.focus();
          }
        }
      }}>
        <Dialog.Title>{props.title}</Dialog.Title><Dialog.Description class="preserve">{props.description}</Dialog.Description>
        {props.children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog>;
}

/** Confirmation has no implicit form submission or positive dismissal path. */
export function ConfirmationDialog(props: { title: string; description: string; action: string; disabled?: boolean; returnFocus?: globalThis.Element | null; close: () => void; confirm: () => void }) {
  return <ActionDialog title={props.title} description={props.description} close={props.close} returnFocus={props.returnFocus}>
    <div class="dialog-actions"><Button type="button" onClick={props.close}>Cancel</Button><Button type="button" class="danger" disabled={props.disabled} onClick={props.confirm}>{props.action}</Button></div>
  </ActionDialog>;
}
