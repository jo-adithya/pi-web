import { createSignal } from "solid-js";
import { Select } from "@kobalte/core/select";
import { Icon } from "./Icon";

export interface SelectOption { value: string; label: string; disabled?: boolean }

/** Controlled selection: the caller's confirmed value remains the displayed value. */
export function SelectField(props: { label: string; value: string; options: SelectOption[]; change: (value: string) => void; placeholder?: string; disabled?: boolean; class?: string; title?: string; required?: boolean }) {
  const [open, setOpen] = createSignal(false);
  // Alpha's list navigation inserts option keys into a quoted CSS selector.
  const options = () => props.options.map(option => ({ ...option, key: encodeURIComponent(option.value) }));
  const dismissChoice = (event: KeyboardEvent) => {
    if (event.key === "Escape" && open() && !event.isComposing) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
  };
  return <Select<SelectOption & { key: string }> open={open()} onOpenChange={setOpen} class={props.class} options={options()} optionValue="key" optionTextValue="label" optionDisabled="disabled"
    value={options().find(option => option.value === props.value) ?? null} disabled={props.disabled} required={props.required}
    onChange={option => { if (option && option.value !== props.value) props.change(option.value); }}
    itemComponent={item => <Select.Item class="select-option" item={item.item}><Select.ItemLabel>{item.item.rawValue.label}</Select.ItemLabel><Select.ItemIndicator>✓</Select.ItemIndicator></Select.Item>}>
    <Select.Label class="sr-only">{props.label}</Select.Label>
    <Select.Trigger class="select-trigger" title={props.title} type="button" onKeyDown={dismissChoice}><Select.Value<SelectOption>>{state => state.selectedOption()?.label ?? props.placeholder ?? "Select…"}</Select.Value><Select.Icon class="select-chevron" aria-hidden="true"><Icon name="chevronDown" /></Select.Icon></Select.Trigger>
    <Select.Portal><Select.Content class="select-content" data-kb-top-layer="" onKeyDown={dismissChoice}><Select.Listbox aria-label={props.label} onKeyDown={dismissChoice} /></Select.Content></Select.Portal>
  </Select>;
}
