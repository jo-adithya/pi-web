import { For, Show, createMemo, createSignal } from "solid-js";
import { TextField } from "@kobalte/core/text-field";
import type { SlashCommand } from "../generated/protocol";

interface PromptInputProps {
  id: string;
  value: string;
  commands: SlashCommand[];
  completionEnabled: boolean;
  onInput: (value: string) => void;
  onSubmit: () => void;
}

/** A multiline prompt editor with first-token slash completion. Selection inserts
 * a command while preserving arguments. Enter sends; Shift+Enter adds a newline.
 */
export function PromptInput(props: PromptInputProps) {
  let input!: HTMLTextAreaElement;
  let list!: HTMLUListElement;
  const [focused, setFocused] = createSignal(false);
  const [caret, setCaret] = createSignal(0);
  const [selectionEnd, setSelectionEnd] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);
  const [composing, setComposing] = createSignal(false);
  const [index, setIndex] = createSignal(0);
  const token = createMemo(() => /^\/[^\s]*/u.exec(props.value)?.[0]);
  const matches = createMemo(() => {
    const first = token();
    if (!props.completionEnabled || !focused() || dismissed() || composing() || !first || caret() < 1 || caret() > first.length || caret() !== selectionEnd()) return [];
    const prefix = props.value.slice(1, caret()).toLowerCase();
    return props.commands.filter(command => command.name.toLowerCase().startsWith(prefix));
  });
  const active = () => Math.min(index(), Math.max(0, matches().length - 1));
  const listId = `${props.id}-commands`;
  const optionId = (i: number) => `${listId}-${i}`;
  function selectionChanged() {
    if (caret() !== input.selectionStart || selectionEnd() !== input.selectionEnd) {
      setDismissed(false); setIndex(0);
    }
    setCaret(input.selectionStart); setSelectionEnd(input.selectionEnd);
  }
  function choose(command: SlashCommand) {
    const suffix = props.value.slice(token()!.length);
    const value = `/${command.name}${suffix || " "}`;
    if (value.length > 32_768) return;
    props.onInput(value);
    // Set the DOM value before positioning the caret; reactive rendering follows.
    input.value = value;
    input.focus();
    input.setSelectionRange(command.name.length + 2, command.name.length + 2);
    setCaret(input.selectionStart); setSelectionEnd(input.selectionEnd); setDismissed(true);
  }
  function keyDown(event: KeyboardEvent) {
    if (event.isComposing || composing()) return;
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (matches().length && !event.ctrlKey && !event.metaKey) choose(matches()[active()]);
      else props.onSubmit();
      return;
    }
    if (!matches().length || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.key === "Escape") { event.preventDefault(); setDismissed(true); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = (active() + (event.key === "ArrowDown" ? 1 : -1) + matches().length) % matches().length;
      setIndex(next);
      list.children[next]?.scrollIntoView?.({ block: "nearest" });
    } else if (event.key === "Tab") { event.preventDefault(); choose(matches()[active()]); }
  }
  return <TextField class="prompt-input" value={props.value} onChange={props.onInput}>
    <TextField.Label class="sr-only" for={props.id}>Message Pi</TextField.Label>
    <TextField.TextArea ref={input} id={props.id} rows={1} autoResize maxlength={32_768}
      placeholder="What would you like to work on?"
      role="combobox" aria-autocomplete="list" aria-expanded={matches().length > 0 ? "true" : "false"}
      aria-controls={matches().length ? listId : undefined}
      aria-activedescendant={matches().length ? optionId(active()) : undefined}
      aria-describedby={`${props.id}-hint`}
      onInput={() => { setDismissed(false); setIndex(0); selectionChanged(); }}
      onFocus={() => { setFocused(true); setDismissed(false); selectionChanged(); }}
      onBlur={() => setFocused(false)} onSelect={selectionChanged} onClick={selectionChanged}
      onKeyUp={(event: KeyboardEvent) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) selectionChanged(); }}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => { setComposing(false); selectionChanged(); }}
      onKeyDown={keyDown} />
    <TextField.Description id={`${props.id}-hint`} class="sr-only">Commands begin with /. Use arrow keys to navigate, Tab or Enter to insert, Escape to dismiss. Enter sends; Shift+Enter adds a new line.</TextField.Description>
    <Show when={matches().length > 0}>
      <ul ref={list} id={listId} class="command-suggestions" role="listbox" aria-label="Slash commands">
        <For each={matches()}>{(command, i) => <li id={optionId(i())} role="option" aria-selected={active() === i() ? "true" : "false"}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(command)}>
          <span class="command-name">/{command.name}</span><small>{command.source}</small>
          <Show when={command.description}><span class="command-description">{command.description}</span></Show>
        </li>}</For>
      </ul>
    </Show>
  </TextField>;
}
