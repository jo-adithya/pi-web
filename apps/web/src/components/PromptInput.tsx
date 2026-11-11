import { Show, createEffect, createMemo, createSignal, flush } from "solid-js";
import { Listbox } from "@kobalte/core/listbox";
import { TextField } from "@kobalte/core/text-field";
import type { SlashCommand } from "../generated/protocol";
import type { WorkspaceFiles } from "../workspace-files";

interface PromptInputProps {
  id: string;
  value: string;
  placeholder?: string;
  commands: SlashCommand[];
  completionEnabled: boolean;
  onInput: (value: string) => void;
  onSubmit: () => void;
  onImages?: (files: File[]) => void;
  searchFiles?: (query: string, signal: AbortSignal) => Promise<WorkspaceFiles>;
}

interface Suggestion { name: string; label: string; source: string; description: string | null; file: boolean }

/** Finds the whitespace-delimited @ reference at the caret, including its remaining
 * token suffix. Quoted queries allow spaces and escaped quotes/backslashes;
 * email addresses stay ordinary prose.
 */
function fileReference(value: string, caret: number) {
  const match = /(?:^|\s)@(?:"((?:\\[^\r\n]|[^"\\\r\n])*\\?)|([^\s"@]*))$/u.exec(value.slice(0, caret));
  if (!match) return;
  const start = match.index + (match[0].startsWith("@") ? 0 : 1);
  const quoted = match[1] !== undefined;
  const end = quoted
    ? start + 2 + /^(?:\\[^\r\n]|[^"\\\r\n])*\\?"?/u.exec(value.slice(start + 2))![0].length
    : caret + /^[^\s"]*/u.exec(value.slice(caret))![0].length;
  const query = quoted ? match[1].replace(/\\(["\\])/gu, "$1") : match[2];
  return { start, end, query };
}

/** A multiline prompt editor with slash commands and workspace @ references.
 * Selection preserves surrounding prose; async file lookups are cancelled when
 * the token or eligibility changes. Enter sends; Shift+Enter adds a newline.
 * The editor owns token matching and keyboard navigation; Listbox keeps pointer
 * selection and option semantics while virtual focus stays in the textarea.
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
  const eligible = () => props.completionEnabled && focused() && !dismissed() && !composing() && caret() === selectionEnd();
  const reference = createMemo(() => fileReference(props.value, caret()));
  const fileQuery = createMemo(() => eligible() && props.searchFiles && reference() && new TextEncoder().encode(reference()!.query).length <= 256 ? reference()!.query : undefined);
  const [files, setFiles] = createSignal<WorkspaceFiles | undefined>(undefined);
  const [fileStatus, setFileStatus] = createSignal("");
  createEffect(() => ({ query: fileQuery(), search: props.searchFiles }), ({ query, search }) => {
    setFiles(undefined); setFileStatus("");
    if (query === undefined || !search) return;
    const controller = new AbortController();
    setFileStatus("Searching workspace files…");
    const timer = window.setTimeout(async () => {
      try {
        const result = await search(query, controller.signal);
        if (controller.signal.aborted) return;
        setFiles(result); setIndex(0);
        setFileStatus(result.paths.length ? (result.truncated ? "Results limited. Type more to narrow your search." : "") : (result.truncated ? "Search limited. Try a more specific path." : "No matching workspace files."));
      } catch {
        if (!controller.signal.aborted) setFileStatus("File search unavailable. Your draft was kept.");
      }
    }, 120);
    return () => { window.clearTimeout(timer); controller.abort(); };
  });
  const matches = createMemo<Suggestion[]>(() => {
    if (!eligible()) return [];
    if (fileQuery() !== undefined) return (files()?.paths ?? []).map(name => ({ name, label: `@${name}`, source: "file", description: null, file: true }));
    const first = token();
    if (!first || caret() < 1 || caret() > first.length) return [];
    const prefix = props.value.slice(1, caret()).toLowerCase();
    return props.commands.filter(command => command.name.toLowerCase().startsWith(prefix)).map(command => ({ ...command, label: `/${command.name}`, file: false }));
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
  function choose(command: Suggestion) {
    const target = reference();
    if (command.file && !target) return;
    const start = command.file ? target!.start : 0;
    const end = command.file ? target!.end : token()!.length;
    const inserted = command.file ? `@${/[\s"\\]/u.test(command.name) ? JSON.stringify(command.name) : command.name}` : `/${command.name}`;
    const suffix = props.value.slice(end);
    const separator = suffix ? "" : " ";
    const value = `${props.value.slice(0, start)}${inserted}${separator}${suffix}`;
    if (value.length > 32_768) return;
    props.onInput(value);
    // Set the DOM value before positioning the caret; reactive rendering follows.
    input.value = value;
    input.focus();
    const position = command.file ? start + inserted.length + separator.length : command.name.length + 2;
    input.setSelectionRange(position, position);
    setCaret(input.selectionStart); setSelectionEnd(input.selectionEnd); setDismissed(true);
  }
  function keyDown(event: KeyboardEvent) {
    if (event.isComposing || composing()) return;
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (matches().length && !event.ctrlKey && !event.metaKey) choose(matches()[active()]);
      else if (!(fileQuery() !== undefined && fileStatus() === "Searching workspace files…" && !event.ctrlKey && !event.metaKey)) props.onSubmit();
      return;
    }
    if (event.key === "Escape" && fileQuery() !== undefined) { event.preventDefault(); setDismissed(true); return; }
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
    {/* The hidden grid cell sizes the editor without collapsing its live scroll box.
        A trailing space preserves the height of an empty final line. */}
    <div class="prompt-size" aria-hidden="true">{props.value + " "}</div>
    <TextField.TextArea ref={input} id={props.id} rows={1} maxlength={32_768}
      placeholder={props.placeholder ?? "What would you like to work on?"}
      role="combobox" aria-autocomplete="list" aria-expanded={matches().length > 0 ? "true" : "false"}
      aria-controls={matches().length ? listId : undefined}
      aria-activedescendant={matches().length ? optionId(active()) : undefined}
      aria-describedby={`${props.id}-hint`}
      onInput={() => {
        // Kobalte reads its controlled value again in this same input event.
        // Flush the draft first so that read preserves the native caret.
        props.onInput(input.value); flush();
        setDismissed(false); setIndex(0); selectionChanged();
      }}
      onFocus={() => { setFocused(true); setDismissed(false); selectionChanged(); }}
      onBlur={() => setFocused(false)} onSelect={selectionChanged} onClick={selectionChanged}
      onKeyUp={(event: KeyboardEvent) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) selectionChanged(); }}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => { setComposing(false); selectionChanged(); }}
      onPaste={(event: ClipboardEvent) => { const files = Array.from(event.clipboardData?.files ?? []); if (files.length && props.onImages) { event.preventDefault(); props.onImages(files); } }}
      onDragOver={(event: DragEvent) => { if (props.onImages && event.dataTransfer?.types.includes("Files")) event.preventDefault(); }}
      onDrop={(event: DragEvent) => { if (props.onImages && event.dataTransfer?.files.length) { event.preventDefault(); props.onImages(Array.from(event.dataTransfer.files)); } }}
      onKeyDown={keyDown} />
    <TextField.Description id={`${props.id}-hint`} class="sr-only">Commands begin with /; workspace files begin with @. Use arrow keys to navigate, Tab or Enter to insert, Escape to dismiss. Enter sends; Shift+Enter adds a new line.</TextField.Description>
    <Show when={matches().length > 0 || (fileQuery() !== undefined && fileStatus())}>
      <div class="command-suggestions">
      <Show when={matches().length > 0}>
      <Listbox ref={list} id={listId} class="completion-options" aria-label={fileQuery() !== undefined ? "Workspace files" : "Slash commands"}
        options={matches()} optionValue="name" optionTextValue="name" selectionMode="single"
        value={[matches()[active()].name]} allowDuplicateSelectionEvents disallowEmptySelection shouldUseVirtualFocus
        onChange={keys => { const command = matches().find(command => keys.has(command.name)); if (command) choose(command); }}
        renderItem={item => <Listbox.Item item={item} id={optionId(matches().findIndex(command => command.name === item.rawValue.name))}
          onMouseDown={event => event.preventDefault()}>
          <Listbox.ItemLabel class="command-name">{item.rawValue.label}</Listbox.ItemLabel><small>{item.rawValue.source}</small>
          <Show when={item.rawValue.description}><Listbox.ItemDescription class="command-description">{item.rawValue.description}</Listbox.ItemDescription></Show>
        </Listbox.Item>} />
      </Show>
      <Show when={fileQuery() !== undefined && fileStatus()}><p class="completion-status" role="status">{fileStatus()}</p></Show>
      </div>
    </Show>
  </TextField>;
}
