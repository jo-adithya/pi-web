import { Show, createSignal } from "solid-js";
import { Button } from "@kobalte/core/button";
import { TextField } from "@kobalte/core/text-field";
import { ActionDialog } from "./ActionDialog";
import { SelectField } from "./SelectField";
import type { Dialog, DialogAnswer } from "../generated/protocol";

/** Extension replies distinguish dismissal from an explicit negative confirmation. */
export function ExtensionDialog(props: { dialog: Dialog; answer: (value: DialogAnswer) => void }) {
  const [value, setValue] = createSignal(props.dialog.initial);
  const valid = () => new TextEncoder().encode(value()).length <= 16_384 && (props.dialog.kind !== "select" || Boolean(value() && props.dialog.options.includes(value())));
  const cancel = () => props.answer({ type: "cancelled" });
  return <ActionDialog title={props.dialog.title} description={props.dialog.message} close={cancel}>
    <form onSubmit={event => { event.preventDefault(); if (props.dialog.kind !== "confirm" && valid()) props.answer({ type: "value", value: value() }); }}>
      <Show when={props.dialog.kind === "select"}><SelectField label="Choose an option" value={value()} change={setValue} required options={props.dialog.options.map(option => ({ value: option, label: option }))} /></Show>
      <Show when={props.dialog.kind === "input" || props.dialog.kind === "editor"}><TextField value={value()} onChange={setValue}><TextField.Label>Response</TextField.Label><TextField.TextArea rows={props.dialog.kind === "editor" ? 8 : 2} maxlength={16_384} /></TextField></Show>
      <div class="dialog-actions"><Button type="button" onClick={cancel}>Cancel</Button>
        <Show when={props.dialog.kind === "confirm"} fallback={<Button class="primary" type="submit" disabled={!valid()}>Send response</Button>}>
          <Button type="button" onClick={() => props.answer({ type: "confirmed", confirmed: false })}>No</Button><Button class="primary" type="button" onClick={() => props.answer({ type: "confirmed", confirmed: true })}>Confirm</Button>
        </Show>
      </div>
    </form>
  </ActionDialog>;
}
