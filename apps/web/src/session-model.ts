import { createSignal, createStore } from "solid-js";
import type { BrowserAction, BrowserMessage, ServerMessage, ThinkingLevel, RunOutcome } from "./generated/protocol";
import { applyServer, initialState } from "./client-state";

/** Session-local presentation and unsent draft. Connection loss never replays a command. */
export function createSessionModel(id: string, transport: (message: BrowserMessage) => boolean, connected: () => boolean, completed?: (sessionId: string, outcome: RunOutcome) => void) {
  const [state, setState] = createStore(initialState());
  const [draft, setDraft] = createSignal(""); const [notice, setNotice] = createSignal("");
  const [settingsPending, setSettingsPending] = createSignal(false);
  let settingsRequest: string | undefined; let completedRun = 0n;
  const [pending, setPending] = createSignal(false); const [stick, setStick] = createSignal(true);
  const [noticeDismissed, setNoticeDismissed] = createSignal(false);
  const visibleNotice = () => notice() || (noticeDismissed() ? null : state.status.notice);
  /** Dismisses the displayed notice locally; fresh status text is shown again. */
  function dismissNotice() {
    if (notice()) setNotice("");
    else setNoticeDismissed(true);
  }
  let prompt: { id: string; text: string } | undefined; let epoch = ""; let attachmentNotice = false;
  function send(action: BrowserAction): string | undefined {
    if (!connected() || !epoch || (!state.synced && action.type !== "attach")) return;
    const requestId = crypto.randomUUID();
    if (transport({ v: 1, sessionId: id, epoch, requestId, action })) return requestId;
  }
  const online = () => connected() && state.synced;
  const canConfigure = () => online() && state.status.process === "ready" && state.status.activity === "idle" && !pending() && !settingsPending();
  /** Sends a validated idle-only selection; display stays on confirmed server settings. */
  function configure(action: BrowserAction) {
    if (!canConfigure() || settingsRequest) return;
    settingsRequest = send(action);
    if (settingsRequest) { setSettingsPending(true); setNotice(""); }
  }
  function setModel(provider: string, modelId: string) {
    if (state.settings.models.some(model => model.provider === provider && model.id === modelId)) configure({ type: "set_model", provider, modelId });
  }
  function setThinkingLevel(level: ThinkingLevel) {
    if (state.settings.thinkingLevels.includes(level)) configure({ type: "set_thinking_level", level });
  }
  const canSend = () => canConfigure() && !settingsRequest && !!draft().trim() && new TextEncoder().encode(draft()).length <= 32_768;
  function submit() {
    if (!canSend()) return;
    const text = draft(); const requestId = send({ type: "prompt", text });
    if (requestId) { prompt = { id: requestId, text }; setPending(true); setNotice(""); setStick(true); }
  }
  function disconnected() {
    setState(value => { value.synced = false; value.dialogs = []; });
    if (prompt) { setNotice("Prompt delivery is uncertain. Inspect the transcript before sending your preserved draft again."); }
    prompt = undefined; setPending(false);
    settingsRequest = undefined; setSettingsPending(false);
  }
  function stopped() {
    disconnected(); epoch = ""; setNoticeDismissed(false);
    // Stopped catalog records retain drafts, not four active-runtime budgets of transcript each.
    setState(value => { Object.assign(value, initialState()); value.status.process = "exited"; });
  }
  /** Returns whether this runtime incarnation accepted the frame for workspace bookkeeping. */
  function receive(message: ServerMessage): boolean {
    if (message.sessionId !== id) return false;
    if (message.body.type === "hello") {
      if (attachmentNotice) { setNotice(""); attachmentNotice = false; }
      if (message.epoch !== epoch) { if (prompt || settingsRequest) disconnected(); completedRun = 0n; setStick(true); }
      epoch = message.epoch;
    }
    const applied: { action: ReturnType<typeof applyServer>; noticeChanged: boolean; live: boolean } = { action: "ignore", noticeChanged: false, live: false };
    setState(value => {
      const previousNotice = value.status.notice; const previousEpoch = value.epoch;
      applied.action = applyServer(value, message);
      applied.noticeChanged = value.status.notice !== previousNotice || value.epoch !== previousEpoch;
      applied.live = applied.action === "applied" && value.synced;
    });
    if (applied.noticeChanged) setNoticeDismissed(false);
    if (applied.action === "resync") send({ type: "attach" });
    if (message.epoch !== epoch) return false;
    if (message.body.type === "run_completed" && applied.live && connected()) {
      const run = BigInt(message.body.runId);
      if (run > completedRun) { completedRun = run; completed?.(id, message.body.outcome); }
    }
    if (message.body.type === "error") {
      attachmentNotice = !prompt;
      disconnected();
      if (attachmentNotice) setNotice(`Session attachment ended: ${message.body.code.replaceAll("_", " ")}. Reattach to refresh.`);
    }
    if (message.body.type === "result") {
      const result = message.body.result;
      if (settingsRequest === result.requestId && result.code !== "pending") { settingsRequest = undefined; setSettingsPending(false); }
      if (prompt?.id === result.requestId && result.code !== "pending") {
        if (result.ok && draft() === prompt.text) setDraft("");
        setPending(false); prompt = undefined;
      }
      if (result.recoveredDraft) setDraft(previous => previous ? `${previous}\n\n${result.recoveredDraft}` : result.recoveredDraft!);
      if (!result.ok) setNotice(`Command not completed: ${result.code.replaceAll("_", " ")}. Your draft was kept.`);
    }
    return true;
  }
  return { id, state, draft, setDraft, notice, setNotice, visibleNotice, dismissNotice, pending, settingsPending, canConfigure, setModel, setThinkingLevel, stick, setStick, online, canSend, send, submit, receive, disconnected, stopped, scroll: 0 };
}
export type SessionModel = ReturnType<typeof createSessionModel>;
