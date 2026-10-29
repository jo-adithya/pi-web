import { Show, createEffect, onSettled } from "solid-js";
import type { SessionModel } from "./session-model";
import { MessageList } from "./Conversation";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { PromptInput } from "./components/PromptInput";
import { Button } from "@kobalte/core/button";
import { Icon } from "./components/Icon";
import { AgentControls } from "./components/AgentControls";

/** Only the selected conversation mounts its transcript and modal dialogs. */
export function SessionView(props: { model: SessionModel }) {
  const model = props.model;
  const { state, draft, setDraft, visibleNotice, dismissNotice, pending, stick, setStick, online, canSend, send, submit } = model;
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
  let scroller!: HTMLDivElement; let disposed = false;
  onSettled(() => {
    scroller.scrollTop = model.scroll;
    return () => { disposed = true; model.scroll = scroller.scrollTop; };
  });
  createEffect(() => ({ seq: state.seq, stick: stick() }), ({ stick }) => {
    if (stick) requestAnimationFrame(() => { if (!disposed && scroller) scroller.scrollTop = scroller.scrollHeight; });
  });
  return <>
    <div class="workspace-body">
      <section class="conversation" aria-label="Conversation">
        <div class="transcript-area">
          <div class="transcript" ref={scroller} onScroll={() => setStick(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80)}>
            <div class="reading">
              <Show when={state.older}><p class="history-marker">Earlier history is not displayed. Pi still owns the full session.</p></Show>
              <Show when={state.status.historyWarning}><p class="warning">{state.status.historyWarning}</p></Show>
              <Show when={!state.order.length}><div class="empty conversation-empty"><span class="empty-mark">π</span><h2>What are we working on?</h2><p>Explore your code, work through an idea, or build something new.</p></div></Show>
              <MessageList state={state} />
              <Show when={state.status.lastOutcome}><p class="outcome">Last run: {state.status.lastOutcome}</p></Show>
            </div>
          </div>
          <Show when={!stick()}><button class="latest" onClick={() => { scroller.scrollTop = scroller.scrollHeight; setStick(true); }}>Jump to latest</button></Show>
        </div>
        <div class="composer">
          <Show when={activityLabel()}><div class="working-indicator" role="status" aria-label="Agent activity" aria-atomic="true">
            <span class={state.status.activity === "awaiting_input" ? "working-dot paused" : "working-dot"} aria-hidden="true" />
            <span>{activityLabel()}</span>
          </div></Show>
          <Show when={state.status.error}><p class="warning" role="alert">{state.status.error}</p></Show>
          <Show when={visibleNotice()}><div class="notice"><p role="status">{visibleNotice()}</p><Button class="icon-button" aria-label="Dismiss notice" title="Dismiss notice" onClick={dismissNotice}><Icon name="close" /></Button></div></Show>
          <Show when={state.status.cancelUnconfirmed}><button class="danger" onClick={() => { if (confirm("Terminate Pi? This cannot undo file edits and may lose unpersisted output.")) send({ type: "terminate", confirmed: true }); }}>Terminate process…</button></Show>
          <Show when={state.status.process === "exited" || state.status.process === "failed"}><button onClick={() => { if (confirm("Restart Pi from the persisted session? Partial output may be lost.")) send({ type: "restart", confirmed: true }); }}>Restart Pi…</button></Show>
          <form onSubmit={event => { event.preventDefault(); submit(); }}>
            <PromptInput id={`prompt-${model.id}`} value={draft()} onInput={setDraft} commands={state.commands}
              completionEnabled={online() && state.synced && state.status.process === "ready" && state.status.activity === "idle" && !pending()}
              onSubmit={submit} />
            <div class="composer-actions">
              <AgentControls model={model} />
              <Show when={state.status.activity !== "idle" && state.status.activity !== "failed"}><Button class="icon-button" aria-label="Stop" title="Stop response" type="button" disabled={!online() || state.status.activity === "cancelling"} onClick={() => send({ type: "cancel" })}><Icon name="stop" /></Button></Show>
              <Button class="primary send-button" aria-label={pending() ? "Sending…" : "Send"} title="Send message" type="submit" disabled={!canSend()}><Icon name="arrow" /></Button>
            </div>
          </form>
          <p class="composer-footnote">{state.status.persistence ? "Saved by Pi" : "Local session"}<span class="context-usage" title="Estimated share of the model context window used; — means unavailable">Context {contextPercent()}</span><span class="persistence-hint">Closing this tab won’t stop an active task.</span></p>
        </div>
      </section>
    </div>
    <Show when={state.dialogs[0]} keyed>{dialog => <ExtensionDialog dialog={dialog} answer={answer => send({ type: "ui_reply", dialogId: dialog.id, answer })} />}</Show>
  </>;
}
