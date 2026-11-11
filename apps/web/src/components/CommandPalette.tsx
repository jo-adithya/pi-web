import { For, Show, createMemo, createSignal, createUniqueId } from "solid-js";
import { Button } from "@kobalte/core/button";
import { ActionDialog } from "./ActionDialog";
import "./command-palette.css";

/** An existing navigation action with its current availability and search context. */
export interface PaletteCommand {
  id: string;
  label: string;
  detail: string;
  disabled?: boolean;
  run: () => void;
}

/** Search existing actions; returnFocus can anchor dismissal when the launching drawer unmounts. */
export function CommandPalette(props: { commands: PaletteCommand[]; close: () => void; returnFocus?: Element }) {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const id = createUniqueId();
  const matches = createMemo(() => {
    const words = query().toLowerCase().trim().split(/\s+/);
    return props.commands.filter(command => words.every(word => `${command.label} ${command.detail}`.toLowerCase().includes(word)));
  });
  const active = () => Math.min(selected(), matches().length - 1);
  function activate(command: PaletteCommand | undefined) {
    if (!command || command.disabled) return;
    props.close();
    command.run();
  }
  return <ActionDialog returnFocus={props.returnFocus} title="Command palette" description="Find conversations, workspaces, and actions. Use arrow keys and Enter to choose." close={props.close} class="command-palette" hideHeading>
    <input class="palette-search" role="combobox" aria-label="Search commands and conversations" aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-results`} aria-activedescendant={active() >= 0 ? `${id}-${active()}` : undefined}
      placeholder="Search commands and conversations…" autocomplete="off" spellcheck={false} value={query()}
      onInput={event => { setQuery(event.currentTarget.value); setSelected(0); }}
      onKeyDown={event => {
        if (event.isComposing) return;
        if (event.key === "Enter") { event.preventDefault(); activate(matches()[active()]); }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && matches().length) {
          // Home/End retain native text editing when a query is present.
          if ((event.key === "Home" || event.key === "End") && query()) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? matches().length - 1 : (active() + (event.key === "ArrowDown" ? 1 : -1) + matches().length) % matches().length;
          setSelected(next);
          document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: "nearest" });
        }
      }} />
    <div id={`${id}-results`} class="palette-results" role="listbox" aria-label="Commands and conversations">
      <For each={matches()}>{(command, index) => <div id={`${id}-${index()}`} role="option" aria-label={`${command.label} ${command.detail}`} aria-selected={active() === index() ? "true" : "false"} aria-disabled={command.disabled ? "true" : undefined}
        class="palette-option" onClick={() => activate(command)} onPointerMove={() => setSelected(index())}>
        <span>{command.label}</span><small>{command.detail}</small>
      </div>}</For>
    </div>
    <Show when={!matches().length}><p class="palette-empty" role="status">No matching commands or conversations.</p></Show>
    <footer class="palette-footer"><span>↑↓ navigate · Enter select</span><Button type="button" onClick={props.close}>Close <kbd>Esc</kbd></Button></footer>
  </ActionDialog>;
}
