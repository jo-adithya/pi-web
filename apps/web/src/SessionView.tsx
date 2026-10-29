import { ConfirmationDialog } from "./components/ActionDialog";
import { For, Show, createSignal, onSettled } from "solid-js";
import type { SessionModel } from "./session-model";
import { MessageList } from "./Conversation";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { PromptInput } from "./components/PromptInput";
import { Button } from "@kobalte/core/button";
import { Icon } from "./components/Icon";
import { CodexUsageFooter } from "./components/CodexUsageFooter";
import { BackgroundTasks } from "./components/BackgroundTasks";
import { DismissibleAlert } from "./components/DismissibleAlert";
import { AgentControls } from "./components/AgentControls";

/** Only the selected conversation mounts its transcript and modal dialogs. */
export function SessionView(props: { model: SessionModel }) {
  const model = props.model;
  const { state, draft, setDraft, visibleNotice, dismissNotice, pending, stick, setStick, online, canSend, send, submit } = model;
  const [confirmation, setConfirmation] = createSignal<{ kind: "terminate" | "restart"; epoch: string | null } | null>(null);
  const eligible = () => {
    const target = confirmation();
    return Boolean(target && online() && state.synced && state.epoch === target.epoch &&
      (target.kind === "terminate" ? state.status.cancelUnconfirmed : state.status.process === "exited" || state.status.process === "failed"));
  };
  /** Describes confirmed live activity, including the pending prompt acknowledgement. */
  const activityLabel = () => {
    if (!online() || state.status.process !== "ready") return "";
    switch (state.status.activity) {
      case "idle": return pending() ? "Sending…" : "";
      case "submitting": return "Sending…";
      case "running": return "Working…";
      case "retrying": return "Retrying…";
      case "compacting": return "Compacting context…";
      case "reconciling": return "Syncing…";
      case "awaiting_input": return "Waiting for your input";
      case "cancelling": return "Stopping…";
      case "failed": return "";
    }
  };
  /** Pi's last context estimate; unknown usage stays distinct from an empty context. */
  const contextPercent = () => {
    const usage = state.contextUsage;
    return usage?.tokens != null ? `${Math.round(usage.tokens / usage.contextWindow * 1000) / 10}%` : "—";
  };
  let scroller!: HTMLDivElement; let reading!: HTMLDivElement;
  let disposed = false;
  let scrollFrame: number | undefined;
  /** Coalesces layout changes into one scroll, respecting pauses made before the frame runs. */
  const scheduleScroll = () => {
    if (disposed || !stick() || scrollFrame !== undefined) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined;
      if (!disposed && stick()) scroller.scrollTop = scroller.scrollHeight;
    });
  };
  onSettled(() => {
    scroller.scrollTop = model.scroll;
    const observer = new ResizeObserver(scheduleScroll);
    observer.observe(reading, { box: "border-box" });
    observer.observe(scroller);
    scheduleScroll();
    return () => {
      disposed = true;
      observer.disconnect();
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
      model.scroll = scroller.scrollTop;
    };
  });
  return <>
    <Show when={confirmation()} keyed>{target => <ConfirmationDialog title={target.kind === "terminate" ? "Terminate Pi" : "Restart Pi"} description={target.kind === "terminate" ? "Terminate Pi? This cannot undo file edits and may lose unpersisted output." : "Restart Pi from the persisted session? Partial output may be lost."} action={target.kind === "terminate" ? "Terminate Pi" : "Restart Pi"} disabled={!eligible()} close={() => setConfirmation(null)} confirm={() => {
      if (!eligible()) return;
      send({ type: target.kind, confirmed: true }); setConfirmation(null);
    }} />}</Show>
    <div class="workspace-body">
      <section class="conversation" aria-label="Conversation">
        <div class="transcript-area">
          <div class="transcript" ref={scroller} onScroll={() => setStick(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80)}>
            <div class="reading" ref={reading}>
              <Show when={state.older}><p class="history-marker">Earlier history is not displayed. Pi still owns the full session.</p></Show>
              <DismissibleAlert class="warning" message={state.status.historyWarning} />
              <Show when={!state.order.length}><div class="empty conversation-empty"><span class="empty-mark">π</span><h2>What are we working on?</h2><p>Explore your code, work through an idea, or build something new.</p></div></Show>
              <MessageList state={state} loadImage={model.loadImage} />
              <Show when={state.status.lastOutcome}><p class="outcome">Last run: {state.status.lastOutcome}</p></Show>
            </div>
          </div>
          <Show when={!stick()}><Button class="latest" onClick={() => { scroller.scrollTop = scroller.scrollHeight; setStick(true); }}>Jump to latest</Button></Show>
        </div>
        <div class="composer">
          <div class="composer-activity">
            <BackgroundTasks tasks={state.backgroundTasks} />
            <Show when={activityLabel()}><div class="working-indicator" role="status" aria-label="Agent activity" aria-atomic="true">
              <span class={state.status.activity === "awaiting_input" ? "working-dot paused" : "working-dot"} aria-hidden="true" />
              <span>{activityLabel()}</span>
            </div></Show>
          </div>
          <DismissibleAlert class="warning" role="alert" message={state.status.error} />
          <Show when={visibleNotice()}><div class="notice"><p role="status">{visibleNotice()}</p><Button class="icon-button" aria-label="Dismiss notice" title="Dismiss notice" onClick={dismissNotice}><Icon name="close" /></Button></div></Show>
          <Show when={state.status.cancelUnconfirmed}><Button class="danger" onClick={() => { setConfirmation({ kind: "terminate", epoch: state.epoch }); }}>Terminate process…</Button></Show>
          <Show when={state.status.process === "exited" || state.status.process === "failed"}><Button onClick={() => { setConfirmation({ kind: "restart", epoch: state.epoch }); }}>Restart Pi…</Button></Show>
          <Show when={model.attachments().length > 0}>
            <div class="image-attachments"><For each={model.attachments()}>{image => <div class="image-attachment">
              <img src={image.preview} alt={image.name} />
              <Button class="image-remove" type="button" onClick={() => model.removeImage(image.id)} aria-label={`Remove ${image.name}`} title={`Remove ${image.name}`}><Icon name="close" /></Button>
            </div>}</For></div>
          </Show>
          <Show when={model.uploading()}><span class="image-upload-status" role="status">Uploading image…</span></Show>
          <form onSubmit={event => { event.preventDefault(); submit(); }}>
            <PromptInput id={`prompt-${model.id}`} value={draft()} onInput={setDraft} commands={state.commands}
              completionEnabled={online() && state.synced && state.status.process === "ready" && state.status.activity === "idle" && !pending()}
              onImages={model.addImages} onSubmit={submit} />
            <div class="composer-actions">
              <AgentControls model={model} />
              <Show when={state.status.activity !== "idle" && state.status.activity !== "failed"} fallback={
                <Button class="primary send-button" aria-label={pending() ? "Sending…" : "Send"} title="Send message" type="submit" disabled={!canSend()}><Icon name="arrow" /></Button>
              }>
                <Button class="primary send-button" aria-label="Stop" title="Stop response" type="button" disabled={!online() || state.status.activity === "cancelling"} onClick={() => send({ type: "cancel" })}><Icon name="stop" /></Button>
              </Show>
            </div>
          </form>
          <p class="composer-footnote"><CodexUsageFooter model={model} /><span class="lsp-status" title="Language server status reported by Pi; — means unavailable">{online() && state.status.process === "ready" ? state.status.lspStatus || "LSP —" : "LSP —"}</span><span class="context-usage" title="Estimated share of the model context window used; — means unavailable">Context {contextPercent()}</span></p>
        </div>
      </section>
    </div>
    <Show when={state.dialogs[0]} keyed>{dialog => <ExtensionDialog dialog={dialog} answer={answer => send({ type: "ui_reply", dialogId: dialog.id, answer })} />}</Show>
  </>;
}
