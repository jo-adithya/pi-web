import { ConfirmationDialog } from "./components/ActionDialog";
import { For, Show, createEffect, createSignal, flush, onSettled, untrack } from "solid-js";
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
import { Toast } from "./components/Toast";
import type { WorkPhase } from "./generated/protocol";

const workPhaseLabels: Record<WorkPhase, string> = {
  thinking: "Thinking…", writing: "Writing…", reading: "Reading files…", editing: "Editing files…",
  searching: "Searching…", executing: "Running a command…", researching: "Researching…",
  checking: "Checking code…", delegating: "Delegating work…", tools: "Running tools…",
};

const promptStarters = [
  { icon: "folder", title: "Explore this project", detail: "Find your way around the code.", prompt: "Give me a tour of this project. Explain how it is organized, the main entry points, and where to start." },
  { icon: "spark", title: "Plan a feature", detail: "Turn an idea into a clear next step.", prompt: "Help me plan a new feature. First, ask me what I want to build, then explore the relevant code before proposing a plan." },
  { icon: "code", title: "Find a bug", detail: "Work through what’s going wrong.", prompt: "Help me investigate a bug. Ask me about the expected behavior, what actually happens, and how to reproduce it." },
] as const;

/** Only the selected conversation mounts its transcript and modal dialogs. */
export function SessionView(props: { model: SessionModel; changes?: () => void }) {
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
    if (!online() || !state.synced || state.status.process !== "ready") return "";
    switch (state.status.activity) {
      case "idle": return pending() ? "Sending…" : state.order.some(id => state.messages[id]?.presentation?.state === "pending") ? "Preparing your answer…" : "";
      case "submitting": return "Sending…";
      case "running": return state.status.workPhase ? workPhaseLabels[state.status.workPhase] : "Working…";
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
  const [replyTarget, setReplyTarget] = createSignal<HTMLDivElement>();
  let scroller!: HTMLDivElement; let reading!: HTMLDivElement; let composer!: HTMLFormElement; let imagePicker!: HTMLInputElement;
  /** Prepares an editable prompt, preserving any draft already in the composer. */
  function startPrompt(prompt: string) {
    if (draft()) return;
    setDraft(prompt); flush();
    composer.querySelector("textarea")?.focus();
  }
  const canAttach = () => model.canConfigure() && !!state.settings.model?.images && !model.uploading() && model.attachments().length < 4;
  const scrollRoot = document.documentElement;
  const scrollToLatest = () => { scrollRoot.scrollTop = scrollRoot.scrollHeight; };
  const trackScroll = () => setStick(scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight < 80);
  let disposed = false;
  let scrollFrame: number | undefined;
  /** Coalesces layout changes into one scroll, respecting pauses made before the frame runs. */
  const scheduleScroll = () => {
    if (disposed || !stick() || scrollFrame !== undefined) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined;
      if (!disposed && stick()) scrollToLatest();
    });
  };
  // A tall final canvas opens at its core result, rather than following its footer.
  createEffect(() => state.canvasReadyId, id => {
    if (!id || !untrack(stick)) return;
    const message = Array.from(reading.querySelectorAll<HTMLElement>("[data-message-id]")).find(node => node.dataset.messageId === id);
    const content = message?.querySelector<HTMLElement>(".simple-response-content");
    if (!content || content.getAttribute("aria-label") !== "Simple answer") return;
    const margin = parseFloat(getComputedStyle(content).scrollMarginTop) || 0;
    const available = scrollRoot.clientHeight - composer.getBoundingClientRect().height - margin;
    if (content.getBoundingClientRect().height <= available) return;
    setStick(false);
    scrollRoot.scrollTop = Math.max(0, scrollRoot.scrollTop + content.getBoundingClientRect().top - margin);
  });
  createEffect(() => model.historyPage()?.cursor, cursor => { if (cursor) scrollRoot.scrollTop = 0; });
  // Sending resumes following immediately, even before transcript content grows.
  createEffect(() => pending(), sending => { if (sending) scheduleScroll(); });
  onSettled(() => {
    // The document owns conversation scrolling at every screen size.
    scrollRoot.scrollTop = model.scroll;
    window.addEventListener("scroll", trackScroll, { passive: true });
    window.addEventListener("resize", scheduleScroll);
    const observer = new ResizeObserver(scheduleScroll);
    observer.observe(reading, { box: "border-box" });
    observer.observe(scroller);
    scheduleScroll();
    return () => {
      disposed = true;
      observer.disconnect();
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
      model.scroll = scrollRoot.scrollTop;
      window.removeEventListener("scroll", trackScroll);
      window.removeEventListener("resize", scheduleScroll);
    };
  });
  return <>
    <Toast message={visibleNotice()} dismiss={dismissNotice} />
    <Show when={confirmation()} keyed>{target => <ConfirmationDialog title={target.kind === "terminate" ? "Terminate Pi" : "Restart Pi"} description={target.kind === "terminate" ? "Terminate Pi? This cannot undo file edits and may lose unpersisted output." : "Restart Pi from the persisted session? Partial output may be lost."} action={target.kind === "terminate" ? "Terminate Pi" : "Restart Pi"} disabled={!eligible()} close={() => setConfirmation(null)} confirm={() => {
      if (!eligible()) return;
      send({ type: target.kind, confirmed: true }); setConfirmation(null);
    }} />}</Show>
    <div class="workspace-body">
      <section class="conversation" aria-label="Conversation">
        <div class="transcript-area">
          <div class="transcript" ref={scroller}>
            <div class="reading" ref={reading}>
              <Show when={state.older || model.historyPage()}><nav aria-label="Conversation history" class="history-marker">
                <Button type="button" aria-label="Load older exchanges" disabled={!online() || model.historyBusy() || !model.historyPage() && state.status.activity !== "idle" || !state.older} onClick={() => { void model.navigateHistory("older"); }}>Older</Button>{" · "}
                <Show when={model.historyPage()}><Button type="button" aria-label="Load newer exchanges" disabled={!online() || model.historyBusy()} onClick={() => { void model.navigateHistory("newer"); }}>Newer</Button>{" · "}
                  <Button type="button" onClick={model.latestHistory} disabled={!online()}>Back to latest</Button>{" · "}
                </Show>
                <span>{model.historyBusy() ? "Loading history…" : model.historyPage() ? "Up to 10 exchanges · read-only history" : "Up to 10 exchanges per page"}</span>
                <Show when={model.newReplies()}><span role="status"> · New replies available</span></Show>
              </nav></Show>
              <DismissibleAlert class="warning" message={state.status.historyWarning} />
              <Show when={!state.order.length}><div class="empty conversation-empty">
                <div class="welcome-copy">
                  <div class="welcome-heading"><span class="welcome-signal" aria-hidden="true" /><span>A space for good work</span></div>
                  <h2>Let’s build<br /><em>what’s next.</em></h2>
                  <p>Explore your code, untangle a bug, or turn an idea into something real. Start anywhere.</p>
                  <Show when={props.changes}><Button class="welcome-review" type="button" onClick={() => props.changes?.()}><Icon name="branch" />Review local changes<Icon name="arrowRight" /></Button></Show>
                </div>
                <div class="welcome-start"><h3>A few ways in <Icon name="spark" /></h3>
                <div class="prompt-starters" role="group" aria-label="Start a conversation">
                  <For each={promptStarters}>{starter => <Button class="prompt-starter" type="button" disabled={!!draft()} onClick={() => startPrompt(starter.prompt)}>
                    <span class="starter-icon"><Icon name={starter.icon} /></span>
                    <strong>{starter.title}</strong><span>{starter.detail}</span><Icon name="arrowRight" />
                  </Button>}</For>
                </div></div>
                <div class="welcome-signature" aria-hidden="true"><span>π</span><span>Think it through. Make it happen.</span><Icon name="arrowRight" /></div>
              </div></Show>
              <MessageList state={state} loadOriginal={model.loadOriginal} retryResponse={online() && !model.historyPage() && state.status.process === "ready" ? messageId => { model.send({ type: "retry_response", messageId }); } : undefined} openCode={location => { model.openCode(location); props.changes?.(); }} reviewCards={model.reviewCards.cards()} loadReviewPreview={model.loadReviewPreview} mobileReplyTarget={replyTarget()} loadImage={model.loadImage} onReply={quote => {
                if (!model.quoteReply(quote)) return;
                window.getSelection()?.removeAllRanges(); flush();
                composer.querySelector("textarea")?.focus();
              }} />
              <Show when={state.status.lastOutcome}><p class="outcome">Last run: {state.status.lastOutcome}</p></Show>
            </div>
          </div>
        </div>
        <div class="composer">
          <Show when={!stick()}><Button class="latest" aria-label="Jump to latest" title="Jump to latest" onClick={() => { scrollToLatest(); setStick(true); }}><Icon name="chevronDown" /></Button></Show>
          <div ref={setReplyTarget} class="mobile-reply-slot" />
          <div class="composer-activity">
            <BackgroundTasks tasks={state.backgroundTasks} />
            <Show when={activityLabel()}><div class="working-indicator" role="status" aria-label="Agent activity" aria-atomic="true">
              <span class={state.status.activity === "awaiting_input" ? "working-dot paused" : "working-dot"} aria-hidden="true" />
              <span>{activityLabel()}</span>
            </div></Show>
          </div>
          <DismissibleAlert class="warning" role="alert" message={state.status.error} />
          <Show when={state.status.cancelUnconfirmed}><Button class="danger" onClick={() => { setConfirmation({ kind: "terminate", epoch: state.epoch }); }}>Terminate process…</Button></Show>
          <Show when={state.status.process === "exited" || state.status.process === "failed"}><Button onClick={() => { setConfirmation({ kind: "restart", epoch: state.epoch }); }}>Restart Pi…</Button></Show>
          <Show when={model.attachments().length > 0}>
            <div class="image-attachments"><For each={model.attachments()}>{image => <div class="image-attachment">
              <img src={image.preview} alt={image.name} />
              <Button class="image-remove" type="button" onClick={() => model.removeImage(image.id)} aria-label={`Remove ${image.name}`} title={`Remove ${image.name}`}><Icon name="close" /></Button>
            </div>}</For></div>
          </Show>
          <Show when={model.uploading()}><span class="image-upload-status" role="status">Uploading image…</span></Show>
          <form ref={composer} onSubmit={event => { event.preventDefault(); submit(); }}>
            <div class="composer-heading" aria-hidden="true"><span><Icon name="code" />Your next move</span><span><kbd>/</kbd> commands <span>·</span> <kbd>@</kbd> files</span></div>
            <Show when={model.quote()}>{quote => <section class="reply-quote" aria-label="Quoted message">
              <Icon name="reply" />
              <blockquote>{quote().text}</blockquote>
              <Button class="reply-quote-remove" type="button" aria-label="Remove quote" title="Remove quote" onClick={() => { model.clearQuote(); composer.querySelector("textarea")?.focus({ preventScroll: true }); }}><Icon name="close" /></Button>
            </section>}</Show>
            <PromptInput id={`prompt-${model.id}`} value={draft()} onInput={setDraft} commands={state.commands}
              placeholder={model.canSteer() ? "Guide Pi while it works…" : "What are we working on?"}
              completionEnabled={online() && state.synced && state.status.process === "ready" && state.status.activity === "idle" && !pending()}
              searchFiles={model.searchFiles} onImages={model.addImages} onSubmit={submit} />
            <div class="composer-actions">
              <input ref={imagePicker} type="file" accept="image/png,image/jpeg" multiple hidden aria-label="Choose images" disabled={!canAttach()} onChange={event => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                if (files.length) void model.addImages(files);
              }} />
              <Button class="icon-button attach-images" type="button" aria-label="Attach images" title={!state.settings.model?.images ? "The selected model does not support images" : "Attach PNG or JPEG images (up to four)"} disabled={!canAttach()} onClick={() => imagePicker.click()}><Icon name="image" /></Button>
              <AgentControls model={model} />
              <Show when={state.status.activity !== "idle" && state.status.activity !== "failed"} fallback={
                <Button class="primary send-button" aria-label={pending() ? "Sending…" : "Send"} title="Send message" type="submit" disabled={!canSend()}><span class="send-label">Send</span><Icon name="arrow" /></Button>
              }>
                <Show when={(model.canSteer() || pending()) && !!draft().trim()} fallback={
                  <Button class="send-button" aria-label="Stop" title="Stop response" type="button" disabled={!online() || state.status.activity === "cancelling"} onClick={() => send({ type: "cancel" })}><span class="send-label">Stop</span><Icon name="stop" /></Button>
                }>
                  <Button class="primary send-button steer-button" aria-label={pending() ? "Sending…" : "Steer Pi"} title="Send a correction at Pi’s next tool boundary" type="submit" disabled={!canSend()}><Icon name="arrow" /><span class="send-label">{pending() ? "Sending…" : "Steer Pi"}</span></Button>
                </Show>
              </Show>
            </div>
          </form>
          <p class="composer-footnote"><span class="composer-hint"><kbd>↵</kbd> Send <span>·</span> <kbd>Shift ↵</kbd> New line <span>·</span> <kbd>/</kbd> Commands</span><CodexUsageFooter model={model} /><span class="lsp-status" title="Language server status reported by Pi; — means unavailable">{online() && state.status.process === "ready" ? state.status.lspStatus || "LSP —" : "LSP —"}</span><span class="context-usage" title="Estimated share of the model context window used; — means unavailable">Context {contextPercent()}</span></p>
        </div>
      </section>
    </div>
    <Show when={state.dialogs[0]} keyed>{dialog => <ExtensionDialog dialog={dialog} answer={answer => send({ type: "ui_reply", dialogId: dialog.id, answer })} />}</Show>
  </>;
}
