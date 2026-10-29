import { createSignal, createStore } from "solid-js";
import type { BrowserAction, BrowserMessage, ServerMessage, ThinkingLevel, RunOutcome } from "./generated/protocol";
import { imageRequest, prepareImage, IMAGE_BYTES, type Attachment } from "./images";
import { loadCapability } from "./browser-auth";
import { applyServer, initialState } from "./client-state";

/** Session-local presentation and unsent draft. Connection loss never replays a command. */
export function createSessionModel(id: string, transport: (message: BrowserMessage) => boolean, connected: () => boolean, completed?: (sessionId: string, outcome: RunOutcome) => void, capability: () => string | null = loadCapability) {
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
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  let disposed = false;
  const [uploading, setUploading] = createSignal(false);
  let prompt: { id: string; text: string; images: string[] } | undefined; let epoch = ""; let attachmentNotice = false;
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
  /** Uploads serially within one draft budget; a failed upload never sends a prompt. */
  async function addImages(files: File[]) {
    if (disposed || uploading() || !canConfigure()) return;
    if (!state.settings.model?.images) { setNotice("The selected model does not support images."); return; }
    if (files.length + attachments().length > 4) { setNotice("Attach at most four images."); return; }
    setUploading(true);
    try {
      for (const file of files) {
        const prepared = await prepareImage(file);
        if (prepared.size + attachments().reduce((sum, image) => sum + image.size, 0) > IMAGE_BYTES) throw new Error("Attachments must total at most 512 KiB after preparation.");
        const response = await imageRequest(id, null, prepared, capability());
        const value: unknown = await response.json();
        if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !/^[0-9a-f]{64}$/.test(value.id)) throw new Error("Invalid image upload response.");
        if (disposed) return;
        const imageId = value.id;
        setAttachments(previous => [...previous, { id: imageId, name: file.name || "Pasted image", size: prepared.size, preview: URL.createObjectURL(prepared) }]);
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : "Image upload failed."); }
    finally { setUploading(false); }
  }
  function removeImage(imageId: string) {
    setAttachments(previous => previous.filter(image => { if (image.id !== imageId) return true; URL.revokeObjectURL(image.preview); return false; }));
  }
  /** Releases previews when the workspace permanently discards this draft. */
  function dispose() { disposed = true; for (const image of attachments()) removeImage(image.id); }
  async function loadImage(imageId: string): Promise<Blob> { return (await imageRequest(id, imageId, undefined, capability())).blob(); }
  const canSend = () => canConfigure() && !settingsRequest && (!!draft().trim() || attachments().length > 0) && !uploading() && (!attachments().length || !!state.settings.model?.images) && new TextEncoder().encode(draft()).length <= 32_768;
  function submit() {
    if (!canSend()) return;
    const text = draft(); const images = attachments().map(image => image.id); const requestId = send({ type: "prompt", text, images });
    if (requestId) { prompt = { id: requestId, text, images }; setPending(true); setNotice(""); setStick(true); }
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
        if (result.ok) {
          if (draft() === prompt.text) setDraft("");
          for (const image of prompt.images) removeImage(image);
        }
        setPending(false); prompt = undefined;
      }
      if (result.recoveredDraft) setDraft(previous => previous ? `${previous}\n\n${result.recoveredDraft}` : result.recoveredDraft!);
      if (!result.ok) setNotice(`Command not completed: ${result.code.replaceAll("_", " ")}. Your draft was kept.`);
    }
    return true;
  }
  return { id, dispose, attachments, uploading, addImages, removeImage, loadImage, state, draft, setDraft, notice, setNotice, visibleNotice, dismissNotice, pending, settingsPending, canConfigure, setModel, setThinkingLevel, stick, setStick, online, canSend, send, submit, receive, disconnected, stopped, scroll: 0 };
}
export type SessionModel = ReturnType<typeof createSessionModel>;
