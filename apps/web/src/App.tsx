import { Show, createEffect, createMemo, createSignal, onSettled } from "solid-js";
import { ActionDialog, ConfirmationDialog, dialogReturnFocus } from "./components/ActionDialog";
import { TextField } from "@kobalte/core/text-field";
import { Dialog } from "@kobalte/core/dialog";
import { Button } from "@kobalte/core/button";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { SessionSidebar } from "./components/SessionSidebar";
import { DismissibleAlert } from "./components/DismissibleAlert";
import { Icon } from "./components/Icon";
import { createMediaQuery, createTheme } from "./theme";
import type { BrowserMessage, CatalogItem, WorkspaceAction, WorkspaceCommand, WorkspaceItem } from "./generated/protocol";
import { decodeServer } from "./client-state";
import { decodeWorkspace } from "./workspace-state";
import { createSessionModel, type SessionModel } from "./session-model";
import { SessionView } from "./SessionView";
import { createCompletionNotifications } from "./notifications";
import { createPhonePush } from "./phone-push";
import { listenForSidebarSwipes } from "./sidebar-swipe";
import { isCapability, loadCapability, saveCapability, SOCKET_PROTOCOL } from "./browser-auth";
import "./style.css";

/** The workspace owns one socket; every conversation owns independent bounded UI state. */
export default function App() {
  const theme = createTheme();
  const notifications = createCompletionNotifications(id => {
    const item = catalog().find(item => item.sessionId === id);
    if (item) choose(item);
  });
  const mobile = createMediaQuery("(max-width: 760px)");
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [catalog, setCatalog] = createSignal<CatalogItem[]>([]);
  const [selected, setSelected] = createSignal("");
  const [workspaces, setWorkspaces] = createSignal<WorkspaceItem[]>([]);
  const [addingWorkspace, setAddingWorkspace] = createSignal(false);
  const [connection, setConnection] = createSignal("Connecting");
  const [notice, setNotice] = createSignal(""); const [managementPending, setManagementPending] = createSignal(0);
  const models = new Map<string, SessionModel>(); const subscriptions = new Set<string>(); const blocked = new Set<string>();
  const pending = new Map<string, WorkspaceAction>(); let selectionRequest: string | undefined;
  let capability: string | null = null;
  const phonePush = createPhonePush(() => capability);
  let socket: WebSocket | undefined; let timer: ReturnType<typeof setTimeout> | undefined; let disposed = false; let retry = 250;
  const transport = (message: BrowserMessage) => { if (socket?.readyState !== WebSocket.OPEN) return false; socket.send(JSON.stringify(message)); return true; };
  function modelFor(id: string) {
    let model = models.get(id);
    if (!model) { model = createSessionModel(id, transport, () => connection() === "Connected", notifications.completed, () => capability); models.set(id, model); }
    return model;
  }
  const entry = createMemo(() => catalog().find(item => item.sessionId === selected()));
  const current = createMemo(() => entry() ? modelFor(entry()!.sessionId) : undefined);
  const canShowSidebar = () => mobile() && !current()?.state.dialogs.length;
  onSettled(() => listenForSidebarSwipes(canShowSidebar, sidebarOpen, setSidebarOpen));
  // Close for extension modals or desktop layout; ordinary stream updates preserve the drawer.
  createEffect(canShowSidebar, enabled => { if (!enabled) setSidebarOpen(false); });
  function command(action: WorkspaceAction) {
    if (socket?.readyState !== WebSocket.OPEN || pending.size >= 8) { setNotice("Workspace request unavailable; reconnect or wait for the current operation."); return; }
    const requestId = crypto.randomUUID(); const message: WorkspaceCommand = { v: 2, requestId, action };
    pending.set(requestId, action); setManagementPending(pending.size);
    socket.send(JSON.stringify(message));
    if (["create", "create_in", "open", "add_workspace", "select_workspace", "delete"].includes(action.type)) selectionRequest = requestId;
    return requestId;
  }
  function subscribe(id: string) {
    if (subscriptions.has(id) || blocked.has(id)) return;
    if (command({ type: "subscribe", sessionId: id })) subscriptions.add(id);
  }
  function disconnectModels() {
    for (const model of models.values()) model.disconnected();
    if ([...pending.values()].some(action => ["create", "create_in", "add_workspace", "select_workspace", "open", "stop", "delete", "rename"].includes(action.type))) setNotice("A workspace operation may have completed. Inspect the catalog before retrying; nothing was replayed.");
    pending.clear(); setManagementPending(0); subscriptions.clear(); blocked.clear(); selectionRequest = undefined;
  }
  function connect() {
    if (disposed || capability === null) return;
    setConnection("Connecting"); const currentSocket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`, [SOCKET_PROTOCOL, `pi-web.cap.${capability}`]); socket = currentSocket;
    currentSocket.onopen = () => { if (disposed || socket !== currentSocket) return; setConnection("Connected"); retry = 250; };
    currentSocket.onmessage = event => {
      if (disposed || socket !== currentSocket) return;
      try {
        if (typeof event.data !== "string" || event.data.length > 16 * 1024 * 1024) throw new Error("Invalid frame");
        const envelope = JSON.parse(event.data) as { v?: unknown };
        if (envelope.v === 2) {
          const reply = decodeWorkspace(event.data);
          const action = reply.requestId ? pending.get(reply.requestId) : undefined;
          if (reply.requestId) pending.delete(reply.requestId);
          setManagementPending(pending.size);
          const remaining = new Set(reply.sessions.map(item => item.sessionId));
          for (const [id, model] of models) if (!remaining.has(id)) {
            model.stopped(); model.dispose(); models.delete(id); subscriptions.delete(id); blocked.delete(id); notifications.forget(id);
          }
          for (const item of reply.sessions) {
            const model = modelFor(item.sessionId);
            if (item.lifecycle === "stopped") { model.stopped(); subscriptions.delete(item.sessionId); blocked.delete(item.sessionId); }
          }
          setWorkspaces(reply.workspaces);
          setCatalog(reply.sessions);
          if (reply.ok && action?.type === "add_workspace") { setAddingWorkspace(false); setNotice(""); setSidebarOpen(false); }
          if (reply.ok && action?.type === "delete") setNotice("");
          if (reply.ok && reply.requestId === selectionRequest && reply.target !== null) setSelected(reply.target);
          else if (!selected() || !reply.sessions.some(item => item.sessionId === selected())) setSelected(reply.selected);
          if (!reply.ok) {
            if (action?.type === "subscribe") {
              subscriptions.delete(action.sessionId); blocked.add(action.sessionId);
              modelFor(action.sessionId).setNotice(reply.code === "too_many_clients" ? "This session has reached its connected-device limit. Close another tab, then Reattach here." : `Attachment failed: ${reply.code.replaceAll("_", " ")}.`);
            } else setNotice(reply.code === "catalog_write_failed_after_transcript_deleted"
              ? "The saved transcript was deleted, but the sidebar entry could not be removed. Retry deletion to finish."
              : `Workspace command not completed: ${reply.code.replaceAll("_", " ")}.`);
          }
          for (const item of reply.sessions) if (item.lifecycle === "open") subscribe(item.sessionId);
        } else {
          const message = decodeServer(event.data);
          const model = models.get(message.sessionId);
          // A removed subscription may still have frames buffered on the socket.
          if (!model) return;
          const accepted = model.receive(message);
          if (accepted && message.body.type === "error") { subscriptions.delete(message.sessionId); blocked.add(message.sessionId); }
        }
      } catch { setNotice("The server sent an invalid update. Reconnecting for fresh snapshots."); currentSocket.close(); }
    };
    currentSocket.onclose = () => {
      if (disposed || socket !== currentSocket) return;
      setConnection("Disconnected"); disconnectModels();
      timer = setTimeout(connect, retry); retry = Math.min(retry * 2, 8000);
    };
  }
  onSettled(() => {
    let attempt = 0;
    const start = async () => {
      const currentAttempt = ++attempt;
      const fragment = new URLSearchParams(location.hash.slice(1));
      const candidate = fragment.has("cap") ? fragment.get("cap") : loadCapability();
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
      clearTimeout(timer); const previous = socket; socket = undefined; previous?.close(); capability = null; disconnectModels();
      const denied = () => { setConnection("Authentication required"); setNotice("Open the current URL printed by pi-web in your terminal."); };
      if (!isCapability(candidate)) { denied(); return; }
      setConnection("Authenticating");
      try {
        const response = await fetch("/auth", { method: "POST", credentials: "omit", redirect: "error", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability: candidate }) });
        if (currentAttempt !== attempt || disposed) return;
        if (!response.ok) { saveCapability(null); denied(); return; }
        capability = candidate;
        if (!saveCapability(candidate)) setNotice("Browser storage is unavailable. This tab remains authenticated; reopen the terminal URL after reloading.");
        connect();
      } catch { if (currentAttempt === attempt && !disposed) denied(); }
    };
    const changed = () => { if (new URLSearchParams(location.hash.slice(1)).has("cap")) void start(); };
    window.addEventListener("hashchange", changed); void start();
    return () => { disposed = true; for (const model of models.values()) model.dispose(); notifications.dispose(); window.removeEventListener("hashchange", changed); clearTimeout(timer); socket?.close(); };
  });
  /** Remember the chosen folder without launching a stopped conversation. */
  function choose(item: CatalogItem) {
    selectionRequest = undefined; setSelected(item.sessionId);
    if (item.lifecycle === "open") command({ type: "open", sessionId: item.sessionId });
    else {
      command({ type: "select_workspace", workspaceId: item.workspaceId });
      // Folder selection may target a different remembered conversation; keep this local choice.
      selectionRequest = undefined;
    }
  }
  const [action, setAction] = createSignal<{ kind: "rename" | "delete" | "stop"; item: CatalogItem; returnFocus: Element | null; description: string } | null>(null);
  const [renameValue, setRenameValue] = createSignal("");
  const [renameError, setRenameError] = createSignal("");
  /** Capture the target and runtime; later catalog updates cannot redirect approval. */
  function renameConversation(item: CatalogItem) {
    if (!canManage()) return;
    setRenameValue(item.title); setRenameError("");
    setAction({ kind: "rename", item, returnFocus: dialogReturnFocus(), description: "Rename this conversation without changing its transcript." });
  }
  function deleteConversation(item: CatalogItem) {
    if (!canManage() || !["open", "stopped"].includes(item.lifecycle)) return;
    const last = catalog().filter(other => other.workspaceId === item.workspaceId).length === 1;
    setAction({ kind: "delete", item, returnFocus: dialogReturnFocus(), description: `Delete this conversation? Its saved Pi transcript will be permanently deleted. Its active task will be stopped and its unsent draft discarded. Project files will not be deleted. This cannot be undone.${last ? " A new empty conversation will replace it." : ""}` });
  }
  function stopConversation(item: CatalogItem) {
    if (!canManage() || item.lifecycle !== "open" || !item.runtime) return;
    setAction({ kind: "stop", item, returnFocus: dialogReturnFocus(), description: "Stop this session? Its active task will be cancelled. Saved history is retained; partial output may be lost." });
  }
  const eligible = () => {
    const target = action();
    const live = catalog().find(item => item.sessionId === target?.item.sessionId);
    return canManage() && Boolean(target && live && live.lifecycle === target.item.lifecycle && (live.runtime?.epoch ?? null) === (target.item.runtime?.epoch ?? null));
  };
  /** Revalidate immediately before sending; stale or disabled dialogs never authorize a command. */
  function submitAction() {
    const target = action();
    if (!target || !eligible()) return;
    if (target.kind === "rename") {
      const title = renameValue().trim();
      if (!title || new TextEncoder().encode(title).length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(title)) {
        setRenameError("Use a name of 1–64 UTF-8 bytes without control characters."); return;
      }
      if (title !== target.item.title) { setNotice(""); command({ type: "rename", sessionId: target.item.sessionId, title }); }
    } else {
      setNotice("");
      if (target.kind === "stop" && target.item.runtime) command({ type: "stop", sessionId: target.item.sessionId, epoch: target.item.runtime.epoch, confirmed: true });
      else if (target.kind === "delete") command({ type: "delete", sessionId: target.item.sessionId, epoch: target.item.runtime?.epoch ?? null, confirmed: true });
    }
    setAction(null);
  }
  const canManage = () => connection() === "Connected" && managementPending() === 0;
  const canCreate = () => canManage() && Boolean(entry()) && catalog().filter(item => item.lifecycle !== "stopped").length < 4 && catalog().filter(item => item.workspaceId === entry()?.workspaceId).length < 32;
  const sidebar = () => <SessionSidebar catalog={catalog()} workspaces={workspaces()} selected={selected()} selectedWorkspace={entry()?.workspaceId ?? ""} canCreate={canCreate()}
    rename={renameConversation} remove={deleteConversation}
    canManage={canManage()} adding={addingWorkspace()} setAdding={value => { setNotice(""); setAddingWorkspace(value); }} notice={notice()}
    addWorkspace={path => { setNotice(""); command({ type: "add_workspace", path, confirmed: true }); }}
    selectWorkspace={workspaceId => command({ type: "select_workspace", workspaceId })}
    choose={item => { choose(item); setSidebarOpen(false); }} create={() => { const workspaceId = entry()?.workspaceId; if (workspaceId) command({ type: "create_in", workspaceId }); setSidebarOpen(false); }}
    activity={id => { const model = models.get(id); return model?.online() && model.state.status.process === "ready" ? model.state.status.activity : undefined; }}
    needsInput={id => Boolean(models.get(id)?.state.dialogs.length)} theme={theme.preference()} setTheme={theme.setPreference} />;
  return <Dialog open={canShowSidebar() && sidebarOpen()} onOpenChange={setSidebarOpen}>
    <div class="workspace">
      <Show when={!mobile()}>
        <aside class="sidebar" aria-label="Sessions">
          <div class="sidebar-brand"><span class="brand">π</span><span>Pi<span class="brand-subtitle">Local workspace</span></span></div>
          {sidebar()}
        </aside>
      </Show>
      <main class="chat-panel">
        <div class="workspace-controls">
          <Show when={mobile()}><Dialog.Trigger class="icon-button" aria-label="Open sessions" disabled={!canShowSidebar()}><Icon name="panel" /></Dialog.Trigger></Show>
          <div class="session-controls">
            <div class="statuses" aria-live="polite"><span class={["connection", { connected: connection() === "Connected" }]}>{connection()}</span>
            </div>
            <Show when={entry()}>{item => <DropdownMenu placement="bottom-end" gutter={8} modal={false}>
              <DropdownMenu.Trigger class="icon-button session-options-trigger" aria-label="Session options" title="Session options"><Icon name="more" /></DropdownMenu.Trigger>
              <DropdownMenu.Portal><DropdownMenu.Content class="session-menu session-actions">
                <DropdownMenu.Item class="danger" disabled={!canManage() || !["open", "stopped"].includes(item().lifecycle)} onSelect={() => deleteConversation(item())}>Delete conversation…</DropdownMenu.Item>
                <DropdownMenu.Item disabled={!notifications.supported} title="Notify when an agent finishes while this app is open" onSelect={() => void notifications.toggle()}>{notifications.enabled() ? "Disable notifications" : "Enable notifications"}</DropdownMenu.Item>
                <DropdownMenu.Item disabled={phonePush.busy() || !phonePush.supported} onSelect={() => void phonePush.enable()}>{phonePush.enabled() ? "Renew phone push" : "Enable phone push"}</DropdownMenu.Item>
                <DropdownMenu.Item disabled={phonePush.busy()} onSelect={() => void phonePush.disable()}>Disable phone push</DropdownMenu.Item><Show when={phonePush.enabled()}><DropdownMenu.Item disabled={phonePush.busy()} onSelect={() => void phonePush.test()}>Test phone push</DropdownMenu.Item></Show>
                <span class="phone-push-scope">Phone push: all folders and conversations on this server. This device only; expires after 30 days. Requires HTTPS and Brave/Chromium on Android.</span>
                <Show when={item().lifecycle === "stopped"}><DropdownMenu.Item disabled={connection() !== "Connected" || managementPending() > 0} onSelect={() => command({ type: "open", sessionId: item().sessionId })}>Reopen session</DropdownMenu.Item></Show>
                <Show when={item().lifecycle === "open"}><DropdownMenu.Item disabled={connection() !== "Connected"} onSelect={() => { blocked.delete(item().sessionId); subscriptions.delete(item().sessionId); subscribe(item().sessionId); }}>Reattach</DropdownMenu.Item>
                  <DropdownMenu.Item class="danger" disabled={connection() !== "Connected" || managementPending() > 0} onSelect={() => { stopConversation(item()); }}>Stop session…</DropdownMenu.Item></Show>
              </DropdownMenu.Content></DropdownMenu.Portal>
            </DropdownMenu>}</Show>
          </div>
        </div>
        <DismissibleAlert class="workspace-notice" message={notice()} />
        <DismissibleAlert class="workspace-notice" message={phonePush.message()} />
        <DismissibleAlert class="workspace-notice" message={notifications.message()} />
        <Show when={current()} keyed>{model => <Show when={entry()?.lifecycle === "open"} fallback={<section class="empty workspace-empty"><span class="empty-mark">π</span><h2>{entry()?.lifecycle === "stopped" ? "Session stopped" : "Session cleanup in progress"}</h2><p>Saved history and your unsent draft are retained. Reopen to continue.</p>
          <Show when={entry()?.lifecycle === "stopped"}><Button disabled={connection() !== "Connected" || managementPending() > 0} onClick={() => command({ type: "open", sessionId: model.id })}>Reopen conversation</Button></Show>
          <Show when={model.draft()}><p class="preserve">Unsent draft: {model.draft()}</p></Show></section>}><SessionView model={model} /></Show>}</Show>
        <Show when={!catalog().length}><section class="empty workspace-empty"><span class="empty-mark">π</span><h2>Connecting to your workspace</h2><p>Open the current terminal URL if authentication is required.</p></section></Show>
      </main>
    </div>
    <Show when={action()} keyed>{target => <Show when={target.kind === "rename"} fallback={<ConfirmationDialog returnFocus={target.returnFocus} title={target.kind === "delete" ? "Delete conversation" : "Stop session"} description={target.description} action={target.kind === "delete" ? "Delete conversation" : "Stop session"} disabled={!eligible()} close={() => setAction(null)} confirm={submitAction} />}>
      <ActionDialog returnFocus={target.returnFocus} title="Rename conversation" description={target.description} close={() => setAction(null)}>
        <form onSubmit={event => { event.preventDefault(); submitAction(); }}>
          <TextField value={renameValue()} onChange={setRenameValue}><TextField.Label>Conversation name</TextField.Label><TextField.TextArea rows={1} /></TextField>
          <Show when={renameError()}><p role="alert">{renameError()}</p></Show>
          <div class="dialog-actions"><Button type="button" onClick={() => setAction(null)}>Cancel</Button><Button type="submit" disabled={!eligible()}>Rename</Button></div>
        </form>
      </ActionDialog>
    </Show>}</Show>
    <Dialog.Portal>
      {/* Explicit dismissal also covers Kobalte alpha’s unregistered dismissable layer. */}
      <Dialog.Overlay class="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      <Dialog.Content class="sidebar sidebar-drawer" onKeyDown={event => {
        if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); setSidebarOpen(false); }
      }}>
        <div class="sidebar-brand"><span class="brand">π</span><Dialog.Title>Sessions</Dialog.Title><Dialog.CloseButton class="icon-button" aria-label="Close sessions"><Icon name="close" /></Dialog.CloseButton></div>
        <Dialog.Description class="sr-only">Choose a workspace and conversation, or add a trusted project folder.</Dialog.Description>
        {sidebar()}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog>;
}
