import { For, Show, createSignal, onSettled } from "solid-js";
import type { Dialog, DialogAnswer } from "../generated/protocol";

/** Native modal semantics preserve focus and Escape cancellation; no reply is inferred. */
export function ExtensionDialog(props: { dialog: Dialog; answer: (value: DialogAnswer) => void }) {
  let element!: HTMLDialogElement;
  const [value, setValue] = createSignal(props.dialog.initial);
  onSettled(() => { element.showModal(); return () => element.close(); });
  return <dialog ref={element} aria-labelledby="extension-title" onCancel={event => { event.preventDefault(); props.answer({ type: "cancelled" }); }}>
    <h2 id="extension-title">{props.dialog.title}</h2><p class="preserve">{props.dialog.message}</p>
    <form onSubmit={event => { event.preventDefault(); props.answer({ type: "value", value: value() }); }}>
      <Show when={props.dialog.kind === "select"}><label>Choose an option<select value={value()} onChange={e => setValue(e.currentTarget.value)} required><option value="" disabled>Select…</option><For each={props.dialog.options}>{option => <option value={option}>{option}</option>}</For></select></label></Show>
      <Show when={props.dialog.kind === "input" || props.dialog.kind === "editor"}><label>Response<textarea autofocus rows={props.dialog.kind === "editor" ? 8 : 2} value={value()} onInput={e => setValue(e.currentTarget.value)} maxlength={16_384} /></label></Show>
      <div class="dialog-actions"><button type="button" onClick={() => props.answer({ type: "cancelled" })}>Cancel</button>
        <Show when={props.dialog.kind === "confirm"} fallback={<button class="primary" type="submit" disabled={new TextEncoder().encode(value()).length > 16_384}>Send response</button>}>
          <button type="button" onClick={() => props.answer({ type: "confirmed", confirmed: false })}>No</button><button class="primary" type="button" onClick={() => props.answer({ type: "confirmed", confirmed: true })}>Confirm</button>
        </Show>
      </div>
    </form>
  </dialog>;
}
