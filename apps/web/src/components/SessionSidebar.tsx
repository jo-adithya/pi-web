import { SelectField } from "./SelectField";
import { TextField } from "@kobalte/core/text-field";
import { Checkbox } from "@kobalte/core/checkbox";
import { For, Show, createSignal } from "solid-js";
import { Button } from "@kobalte/core/button";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import type { Activity, CatalogItem, WorkspaceItem } from "../generated/protocol";
import { validWorkspacePath } from "../workspace-state";
import type { ThemePreference } from "../theme";
import { Icon } from "./Icon";

interface SessionSidebarProps {
  catalog: CatalogItem[];
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
  choose: (item: CatalogItem) => void;
  rename: (item: CatalogItem) => void;
  remove: (item: CatalogItem) => void;
  create: () => void;
  needsInput: (id: string) => boolean;
  activity: (id: string) => Activity | undefined;
  theme: ThemePreference;
  setTheme: (value: ThemePreference) => void;
}

/** Project navigation shared by the desktop rail and the mobile modal drawer. */
export function SessionSidebar(props: SessionSidebarProps) {
  return <>
    <Button class="new-conversation" disabled={!props.canCreate} onClick={props.create}><Icon name="plus" />New conversation</Button>
    <div class="sidebar-section-label">Workspaces <Button class="icon-button" aria-label="Add workspace" title="Add workspace" disabled={!props.canManage || props.workspaces.length >= 16} onClick={() => props.setAdding(!props.adding)}><Icon name="plus" /></Button></div>
    <nav class="session-list" aria-label="Workspaces and conversations">
      <Show when={props.adding}><WorkspaceForm pending={!props.canManage} notice={props.notice} submit={props.addWorkspace} cancel={() => props.setAdding(false)} /></Show>
      <For each={props.workspaces}>{workspace => <section class="workspace-group" role="group" aria-label={workspace.name}>
        <Button class={["workspace-heading", { selected: props.selectedWorkspace === workspace.workspaceId }]} title={workspace.path}
          aria-label={`Select workspace ${workspace.name}`} aria-pressed={props.selectedWorkspace === workspace.workspaceId ? "true" : "false"} disabled={!props.canManage}
          onClick={() => props.selectWorkspace(workspace.workspaceId)}>
          <Icon name="folder" /><span class="workspace-info"><strong>{workspace.name}</strong><small>{workspace.path}</small></span>
        </Button>
        <For each={props.catalog.filter(item => item.workspaceId === workspace.workspaceId)}>{item => <div class="session-row"><Button class={["session-item", { selected: props.selected === item.sessionId, stopped: item.lifecycle === "stopped" }]}
          aria-label={`${item.title}, ${props.needsInput(item.sessionId) ? "needs input" : (props.activity(item.sessionId) ?? item.lifecycle).replaceAll("_", " ")}`}
          aria-pressed={props.selected === item.sessionId ? "true" : "false"} onClick={() => props.choose(item)}>
          <span class="session-info"><span class="session-title-row"><span class="session-title">{item.title}</span>
            <Show when={item.lifecycle === "open" && !props.needsInput(item.sessionId) && ["submitting", "running", "retrying", "compacting", "reconciling", "cancelling"].includes(props.activity(item.sessionId) ?? "")}><span class="working-dot" aria-hidden="true" /></Show>
          </span><Show when={props.needsInput(item.sessionId)}><small>Needs input</small></Show></span>
        </Button><DropdownMenu placement="bottom-end" gutter={6} modal={false}>
          <DropdownMenu.Trigger class="icon-button sidebar-session-trigger" aria-label={`Options for ${item.title}`} title={`Options for ${item.title}`}><Icon name="more" /></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content class="session-menu sidebar-session-actions">
            <DropdownMenu.Item disabled={!props.canManage} onSelect={() => props.rename(item)}>Rename…</DropdownMenu.Item>
            <DropdownMenu.Item class="danger" disabled={!props.canManage || !["open", "stopped"].includes(item.lifecycle)} onSelect={() => props.remove(item)}>Delete…</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu></div>}</For>
      </section>}</For>
    </nav>
    <footer class="sidebar-footer">
      <p class="shared-project">Separate project folders<br /><span>Conversations in a workspace share its files.</span></p>
      <div class="theme-picker"><span>Color scheme</span><SelectField label="Color scheme" value={props.theme} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} change={value => {
        if (value === "system" || value === "light" || value === "dark") props.setTheme(value);
      }} /></div>
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
