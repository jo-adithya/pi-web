import { For, Show, createSignal } from "solid-js";
import { Button } from "@kobalte/core/button";
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
          <Icon name="chat" /><span class="session-info"><span class="session-title-row"><span class="session-title">{item.title}</span>
            <Show when={item.lifecycle === "open" && !props.needsInput(item.sessionId) && ["submitting", "running", "retrying", "compacting", "reconciling", "cancelling"].includes(props.activity(item.sessionId) ?? "")}><span class="working-dot" aria-hidden="true" /></Show>
          </span><Show when={props.needsInput(item.sessionId)}><small>Needs input</small></Show></span>
        </Button><details class="session-options sidebar-session-options" onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
          <summary class="icon-button" aria-label={`Options for ${item.title}`} title={`Options for ${item.title}`}><Icon name="more" /></summary>
          <div class="sidebar-session-actions">
            <Button disabled={!props.canManage} onClick={event => { const menu = event.currentTarget.closest("details")!; menu.open = false; menu.querySelector("summary")?.focus(); props.rename(item); }}>Rename…</Button>
            <Button class="danger" disabled={!props.canManage || !["open", "stopped"].includes(item.lifecycle)} onClick={event => { const menu = event.currentTarget.closest("details")!; menu.open = false; menu.querySelector("summary")?.focus(); props.remove(item); }}>Delete…</Button>
          </div>
        </details></div>}</For>
      </section>}</For>
    </nav>
    <footer class="sidebar-footer">
      <p class="shared-project">Separate project folders<br /><span>Conversations in a workspace share its files.</span></p>
      <label class="theme-picker"><span>Color scheme</span><select value={props.theme} onChange={event => props.setTheme(event.currentTarget.value as ThemePreference)}>
        <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
      </select></label>
    </footer>
  </>;
}

/** Collect explicit trust before registering an existing folder on the server machine. */
function WorkspaceForm(props: { pending: boolean; notice: string; submit: (path: string) => void; cancel: () => void }) {
  const [path, setPath] = createSignal("");
  const [trusted, setTrusted] = createSignal(false);
  const allowed = () => !props.pending && trusted() && validWorkspacePath(path());
  return <form class="workspace-form" onSubmit={event => { event.preventDefault(); if (allowed()) props.submit(path()); }}>
    <label>Project folder<input type="text" aria-label="Project folder" placeholder="/absolute/path/to/project" value={path()} onInput={event => setPath(event.currentTarget.value)} spellcheck={false} autocomplete="off" /></label>
    <p>Use an existing folder on the machine running Pi. Project extensions, skills and prompts may execute code; agents can edit its files.</p>
    <label class="workspace-trust"><input type="checkbox" checked={trusted()} onChange={event => setTrusted(event.currentTarget.checked)} />I trust this folder and its project resources.</label>
    <Show when={props.notice}><p role="alert">{props.notice}</p></Show>
    <div class="workspace-form-actions"><Button type="button" onClick={props.cancel}>Cancel</Button><Button type="submit" disabled={!allowed()}>Add trusted folder</Button></div>
  </form>;
}
