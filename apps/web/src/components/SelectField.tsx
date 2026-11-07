import { createSignal, Show } from "solid-js";
import { Select } from "@kobalte/core/select";
import { Icon } from "./Icon";

export interface SelectOption { value: string; label: string; disabled?: boolean }

/** Controlled selection with optional in-dropdown search; callers supply the filtered options and confirmed value. */
export function SelectField(props: { label: string; value: string; options: SelectOption[]; change: (value: string) => void; placeholder?: string; disabled?: boolean; class?: string; title?: string; required?: boolean; visibleLabel?: boolean; description?: string; describedBy?: string; search?: { value: string; change: (value: string) => void; label: string; placeholder: string; empty?: string } }) {
  const [open, setOpen] = createSignal(false);
  // Alpha needs nonempty keys and inserts them into a quoted CSS selector.
  const options = () => props.options.map(option => ({ ...option, key: `option-${encodeURIComponent(option.value)}` }));
  const dismissChoice = (event: KeyboardEvent) => {
    if (event.key === "Escape" && open() && !event.isComposing) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
  };
  // Filtering reconciles the selected key; duplicate selection events would dismiss the search.
  return <Select<SelectOption & { key: string }> open={open()} onOpenChange={setOpen} allowDuplicateSelectionEvents={props.search ? false : undefined} class={props.class} options={options()} optionValue="key" optionTextValue="label" optionDisabled="disabled"
    value={options().find(option => option.value === props.value) ?? null} placeholder={props.placeholder ?? "Select…"} disabled={props.disabled} required={props.required}
    onChange={option => { if (option && option.value !== props.value) props.change(option.value); }}
    itemComponent={item => <Select.Item class="select-option" item={item.item}><Select.ItemLabel>{item.item.rawValue.label}</Select.ItemLabel><Select.ItemIndicator>✓</Select.ItemIndicator></Select.Item>}>
    <Select.Label class={props.visibleLabel ? "field-label" : "sr-only"}>{props.label}</Select.Label>
    <Select.Trigger class="select-trigger" title={props.title} type="button" aria-describedby={props.describedBy} onKeyDown={dismissChoice}><Select.Value<SelectOption>>{state => state.selectedOption()?.label ?? props.placeholder ?? "Select…"}</Select.Value><Select.Icon class="select-chevron" aria-hidden="true"><Icon name="chevronDown" /></Select.Icon></Select.Trigger>
    <Show when={props.description}><Select.Description class="field-description">{props.description}</Select.Description></Show>
    <Select.Portal><Select.Content class="select-content" data-kb-top-layer="" onKeyDown={dismissChoice}>
      <Show when={props.search}>{search => <div class="select-search">
        <input type="search" aria-label={search().label} placeholder={search().placeholder} value={search().value}
          ref={input => queueMicrotask(() => { if (input.isConnected) input.focus(); })}
          onInput={event => search().change(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === "Escape") { dismissChoice(event); return; }
            if (event.key === "ArrowDown" && !event.isComposing) {
              event.preventDefault();
              event.currentTarget.closest(".select-content")?.querySelector<HTMLElement>('[role="option"]:not([data-disabled])')?.focus();
            }
            if (event.key === "Enter") event.preventDefault();
            event.stopPropagation();
          }} />
        <Show when={search().empty}><p class="select-search-empty" role="status">{search().empty}</p></Show>
      </div>}</Show>
      <Select.Listbox aria-label={props.label} onKeyDown={dismissChoice} autoFocus={props.search ? false : undefined} />
    </Select.Content></Select.Portal>
  </Select>;
}
