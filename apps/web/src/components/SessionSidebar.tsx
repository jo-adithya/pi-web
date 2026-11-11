import { SelectField } from "./SelectField";
import { TextField } from "@kobalte/core/text-field";
import { Checkbox } from "@kobalte/core/checkbox";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { Popover } from "@kobalte/core/popover";
import { Button } from "@kobalte/core/button";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import type { Activity, CatalogItem, WorkspaceItem } from "../generated/protocol";
import { validWorkspacePath } from "../workspace-state";
import type { ThemePreference } from "../theme";
import { Icon } from "./Icon";

interface SessionSidebarProps {
  catalog: CatalogItem[];
  unread: (id: string) => boolean;
  workspaces: WorkspaceItem[];
  selected: string;
  selectedWorkspace: string;
  canCreate: boolean;
  canManage: boolean;
  adding: boolean;
  setAdding: (value: boolean) => void;
  notice: string;
  addWorkspace: (path: string) => void;
  selectWorkspace: (id: string) => void;
  removeWorkspace: (workspace: WorkspaceItem) => void;
  choose: (item: CatalogItem) => void;
  rename: (item: CatalogItem) => void;
  remove: (item: CatalogItem) => void;
  create: () => void;
  needsInput: (id: string) => boolean;
  activity: (id: string) => Activity | undefined;
  theme: ThemePreference;
  setTheme: (value: ThemePreference) => void;
  settingsOpen: boolean;
  /** Uses modal menus inside the mobile drawer; desktop menus keep the workspace interactive. */
  mobile: boolean;
  openSettings: () => void;
  openPalette: () => void;
}

/** A flat conversation inbox with project switching and local, non-destructive filters. */
export function SessionSidebar(props: SessionSidebarProps) {
  const [query, setQuery] = createSignal("");
  const [projectOnly, setProjectOnly] = createSignal(false);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [pickerContent, setPickerContent] = createSignal<HTMLElement>();
  let pickerTrigger!: HTMLButtonElement;
  const current = createMemo(() => props.workspaces.find(workspace => workspace.workspaceId === props.selectedWorkspace));
  const workspaceName = (id: string) => props.workspaces.find(workspace => workspace.workspaceId === id)?.name ?? "Workspace";
  const filtered = createMemo(() => {
    const words = query().trim().toLowerCase().split(/\s+/);
    return props.catalog.filter(item => (!projectOnly() || item.workspaceId === props.selectedWorkspace) &&
      words.every(word => `${item.title} ${workspaceName(item.workspaceId)}`.toLowerCase().includes(word)));
  });
  createEffect(() => pickerOpen() ? pickerContent() : undefined, element => element?.focus({ preventScroll: true }));
  return <>
    <div class="workspace-switcher-row">
      <Popover open={pickerOpen()} onOpenChange={open => {
        if (!open && pickerContent()?.contains(document.activeElement)) pickerTrigger.focus({ preventScroll: true });
        setPickerOpen(open);
      }} placement="bottom-start" gutter={6}>
        <Popover.Trigger ref={pickerTrigger} class="workspace-switcher" aria-label="Switch workspace" disabled={!props.workspaces.length}>
          <span class="workspace-switcher-icon"><Icon name="folder" /></span><span class="workspace-info"><strong>{current()?.name ?? "Choose workspace"}</strong><small>{current()?.path ?? "Your project folders"}</small></span><Icon name="chevronDown" />
        </Popover.Trigger>
        <Popover.Portal><Popover.Content ref={setPickerContent} class="workspace-picker" data-kb-top-layer="" onKeyDown={(event: KeyboardEvent) => {
          if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
          if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); setPickerOpen(false); pickerTrigger.focus({ preventScroll: true }); }
        }}>
          <div class="workspace-picker-heading"><Popover.Title>Workspaces</Popover.Title><Popover.CloseButton class="icon-button" aria-label="Close workspace switcher"><Icon name="close" /></Popover.CloseButton></div>
          <For each={props.workspaces}>{workspace => <section role="group" aria-label={workspace.name} class="workspace-heading-row">
            <Button class={["workspace-heading", { selected: props.selectedWorkspace === workspace.workspaceId }]} title={workspace.path}
              aria-label={`Select workspace ${workspace.name}`} aria-pressed={props.selectedWorkspace === workspace.workspaceId ? "true" : "false"} disabled={!props.canManage}
              onClick={() => { setPickerOpen(false); pickerTrigger.focus({ preventScroll: true }); props.selectWorkspace(workspace.workspaceId); }}>
              <Icon name="folder" /><span class="workspace-info"><strong>{workspace.name}<Show when={props.catalog.some(item => item.workspaceId === workspace.workspaceId && props.unread(item.sessionId))}><span class="unread-dot" role="img" aria-label="Unread response" /></Show></strong><small>{workspace.path}</small></span>
            </Button>
            <DropdownMenu placement="bottom-end" gutter={6} modal={props.mobile}>
              <DropdownMenu.Trigger class="icon-button sidebar-workspace-trigger" aria-label={`Workspace options for ${workspace.name}`} title={`Workspace options for ${workspace.name}`}><Icon name="more" /></DropdownMenu.Trigger>
              <DropdownMenu.Portal><DropdownMenu.Content class="session-menu sidebar-workspace-actions" data-kb-top-layer="">
                <DropdownMenu.Item class="danger" disabled={!props.canManage || props.workspaces.length <= 1 || props.catalog.some(item => item.workspaceId === workspace.workspaceId && !["open", "stopped"].includes(item.lifecycle))} onSelect={() => props.removeWorkspace(workspace)}>Delete workspace…</DropdownMenu.Item>
                <Show when={props.workspaces.length <= 1}><span class="workspace-menu-hint">Keep at least one workspace. Add another before deleting this one.</span></Show>
              </DropdownMenu.Content></DropdownMenu.Portal>
            </DropdownMenu>
          </section>}</For>
        </Popover.Content></Popover.Portal>
      </Popover>
      <Button class="icon-button" aria-label="Add workspace" title="Add workspace" disabled={!props.canManage || props.workspaces.length >= 16} onClick={() => props.setAdding(!props.adding)}><Icon name="plus" /></Button>
    </div>
    <Button class="new-conversation" disabled={!props.canCreate} onClick={props.create}><Icon name="plus" />New conversation</Button>
    <div class="sidebar-section-label"><span>Conversations</span><span class="workspace-count">{filtered().length}</span><Button class="icon-button" aria-label="Search conversations and commands" title="Search commands (Ctrl/⌘ K)" onClick={props.openPalette}><Icon name="search" /></Button></div>
    <TextField class="conversation-filter" value={query()} onChange={setQuery}>
      <TextField.Label class="sr-only">Filter conversations</TextField.Label><Icon name="search" /><TextField.Input type="search" placeholder="Find a conversation…" autocomplete="off" spellcheck={false} />
      <Show when={query()}><Button class="icon-button" type="button" aria-label="Clear conversation filter" onClick={() => setQuery("")}><Icon name="close" /></Button></Show>
    </TextField>
    <div class="conversation-scopes" role="group" aria-label="Conversation filter">
      <Button type="button" aria-pressed={!projectOnly() ? "true" : "false"} onClick={() => setProjectOnly(false)}>All projects</Button>
      <Button type="button" aria-pressed={projectOnly() ? "true" : "false"} onClick={() => setProjectOnly(true)}>This project</Button>
    </div>
    <nav class="session-list" aria-label="Workspaces and conversations">
      <Show when={props.adding}><WorkspaceForm pending={!props.canManage} notice={props.notice} submit={props.addWorkspace} cancel={() => props.setAdding(false)} /></Show>
      <For each={filtered()}>{item => <div class="session-row"><Button class={["session-item", { selected: props.selected === item.sessionId, stopped: item.lifecycle === "stopped" }]}
        aria-label={`${item.title}, ${props.needsInput(item.sessionId) ? "needs input" : (props.activity(item.sessionId) ?? item.lifecycle).replaceAll("_", " ")}${props.unread(item.sessionId) ? ", unread response" : ""}`}
        aria-pressed={props.selected === item.sessionId ? "true" : "false"} onClick={() => props.choose(item)}>
        <Icon name="chat" /><span class="session-info"><span class="session-title-row"><span class="session-title">{item.title}</span><Show when={props.unread(item.sessionId)}><span class="unread-dot" aria-hidden="true" /></Show>
          <Show when={item.lifecycle === "open" && !props.needsInput(item.sessionId) && ["submitting", "running", "retrying", "compacting", "reconciling", "cancelling"].includes(props.activity(item.sessionId) ?? "")}><span class="working-dot" aria-hidden="true" /></Show>
        </span><small class="session-metadata"><span>{workspaceName(item.workspaceId)}</span><Show when={props.needsInput(item.sessionId)}><span class="session-needs-input">Needs input</span></Show><Show when={item.lifecycle === "stopped"}><span>Stopped</span></Show></small></span>
      </Button><DropdownMenu placement="bottom-end" gutter={6} modal={props.mobile}>
        <DropdownMenu.Trigger class="icon-button sidebar-session-trigger" aria-label={`Options for ${item.title}`} title={`Options for ${item.title}`}><Icon name="more" /></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content class="session-menu sidebar-session-actions" data-kb-top-layer="">
          <DropdownMenu.Item disabled={!props.canManage} onSelect={() => props.rename(item)}>Rename…</DropdownMenu.Item>
          <DropdownMenu.Item class="danger" disabled={!props.canManage || !["open", "stopped"].includes(item.lifecycle)} onSelect={() => props.remove(item)}>Delete…</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu></div>}</For>
      <Show when={!filtered().length}><p class="conversation-filter-empty">{props.catalog.length ? "No matching conversations." : "No conversations yet."}</p></Show>
    </nav>
    <footer class="sidebar-footer">
      <Show when={props.mobile}><Button class="sidebar-preferences" aria-label="Settings" aria-pressed={props.settingsOpen ? "true" : "false"} onClick={props.openSettings}><Icon name="settings" /><span>Settings</span><Icon name="arrowRight" /></Button></Show>
      <div class="theme-picker"><Icon name="sun" /><SelectField label="Color scheme" value={props.theme} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} change={value => {
        if (value === "system" || value === "light" || value === "dark") props.setTheme(value);
      }} /><span class="local-indicator" title="Project files stay on the server" aria-hidden="true" /></div>
    </footer>
  </>;
}

/** Collect explicit trust before registering an existing folder on the server machine. */
function WorkspaceForm(props: { pending: boolean; notice: string; submit: (path: string) => void; cancel: () => void }) {
  const [path, setPath] = createSignal("");
  const [trusted, setTrusted] = createSignal(false);
  const allowed = () => !props.pending && trusted() && validWorkspacePath(path());
  return <form class="workspace-form" onSubmit={event => { event.preventDefault(); if (allowed()) props.submit(path()); }}>
    <TextField value={path()} onChange={setPath}><TextField.Label>Project folder</TextField.Label><TextField.Input type="text" placeholder="/absolute/path/to/project" spellcheck={false} autocomplete="off" /></TextField>
    <p>Use an existing folder on the machine running Pi. Project extensions, skills and prompts may execute code; agents can edit its files.</p>
    <Checkbox class="workspace-trust" checked={trusted()} onChange={setTrusted}><Checkbox.Input /><Checkbox.Control class="checkbox-control"><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control><Checkbox.Label>I trust this folder and its project resources.</Checkbox.Label></Checkbox>
    <Show when={props.notice}><p role="alert">{props.notice}</p></Show>
    <div class="workspace-form-actions"><Button type="button" onClick={props.cancel}>Cancel</Button><Button type="submit" disabled={!allowed()}>Add trusted folder</Button></div>
  </form>;
}
