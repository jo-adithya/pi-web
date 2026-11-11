import { createEffect, createRoot, createSignal, createStore, flush } from "solid-js";
import type { BrowserAction, BrowserMessage, ServerMessage, ThinkingLevel, RunOutcome } from "./generated/protocol";
import { imageRequest, prepareImage, IMAGE_BYTES, type Attachment } from "./images";
import { loadSource, searchWorkspaceFiles } from "./workspace-files";
import { createLocalReview, fetchReview, type ReviewLoadRequest, type ReviewFile } from "./local-review";
import { createReviewCards, type ReviewCard } from "./review-cards";
import { fetchStructuralReview } from "./structural-review";
import { fetchContextReview } from "./context-review";
import { fetchCommits } from "./commit-review";
import { fetchBranches } from "./branch-review";
import { fetchReviewGroups } from "./review-groups";
import { loadCapability } from "./browser-auth";
import { applyServer, initialState } from "./client-state";
import { readHistory } from "./history";
import { formatReply, type ReplyQuote } from "./reply-quote";
import type { CodeLocation } from "./code-reference";
import { feedbackText, feedbackFits, restoreSessionDraft, savePromptDraft, saveFeedbackDraft, type FeedbackNote } from "./session-draft";

/** Conversation presentation with same-tab recovery of unsent text and feedback. Connection loss never replays a command. */
export function createSessionModel(id: string, transport: (message: BrowserMessage) => boolean, connected: () => boolean, completed?: (sessionId: string, outcome: RunOutcome) => void, capability: () => string | null = loadCapability) {
  const restored = restoreSessionDraft(id);
  let promptUncertain = restored.prompt.uncertain, feedbackUncertain = restored.feedback.uncertain;
  const review = createLocalReview(
    (request, signal) => fetchReview(id, request, signal, capability()),
    (request, signal) => fetchStructuralReview(id, request, signal, capability()),
    (request, signal) => fetchContextReview(id, request, signal, capability()),
    signal => fetchCommits(id, signal, capability()),
    (request, signal) => fetchReviewGroups(id, request, signal, capability()),
    (signal, query) => fetchBranches(id, signal, capability(), query),
    { model: () => state.settings.model ? { provider: state.settings.model.provider, id: state.settings.model.id } : null, cacheNamespace: id },
  );
  const [codeLocation, openCode] = createSignal<CodeLocation>();
  const reviewCards = createReviewCards(id);
  const [feedback, setFeedback] = createSignal<FeedbackNote[]>(restored.feedback.notes);
  function persistFeedback(notes: FeedbackNote[]) {
    if (!saveFeedbackDraft(id, { notes, uncertain: feedbackUncertain })) setNotice("Unsent feedback is only in memory. This browser could not save it; keep this tab open.");
  }
  function replaceFeedback(notes: FeedbackNote[]): boolean {
    if (!feedbackFits(notes)) { setNotice("Feedback is full. Send or remove some notes before adding more."); return false; }
    setFeedback(notes); return true;
  }
  /** Captures a bounded feedback note and its browser-only diff snapshot. */
  function addFeedback(comment: string, card: ReviewCard): boolean {
    return !!comment.trim() && replaceFeedback([...feedback(), { id: crypto.randomUUID(), comment: comment.trim(), card }]);
  }
  /** Edits only the comment, preserving its captured scope and source; in-flight batches are immutable. */
  function editFeedback(noteId: string, comment: string): boolean {
    if (pending() || !comment.trim() || !feedback().some(note => note.id === noteId)) return false;
    return replaceFeedback(feedback().map(note => note.id === noteId ? { ...note, comment: comment.trim() } : note));
  }
  function removeFeedback(noteId: string) { if (!pending()) replaceFeedback(feedback().filter(note => note.id !== noteId)); }
  /** Clears only the acknowledged batch, leaving later notes and the composer intact. */
  function submitFeedback(): boolean {
    const notes = feedback();
    if (!notes.length || !submitReview(feedbackText(notes), notes.map(note => note.id))) return false;
    for (const note of notes) reviewCards.remember(note.card);
    return true;
  }
  const loadReviewPreview = async (request: ReviewLoadRequest & { path: string }, signal: AbortSignal): Promise<ReviewFile> => {
    const snapshot = await fetchReview(id, request, signal, capability());
    return snapshot.files[0] as ReviewFile; // Selected-path responses are validated by fetchReview.
  };
  const [state, setState] = createStore(initialState());
  const [historyPage, setHistoryPage] = createSignal<{ cursor: string; older: string | null; trail: string[]; index: number }>();
  const [historyBusy, setHistoryBusy] = createSignal(false);
  const [newReplies, setNewReplies] = createSignal(false);
  let historyRead: AbortController | undefined; let historyVersion = 0;
  const [draft, setDraft] = createSignal(restored.prompt.text);
  const [notice, setNotice] = createSignal(restored.warning || (promptUncertain || feedbackUncertain ? "Previous delivery is uncertain. Inspect the transcript before resending restored work." : ""));
  const [quote, setQuote] = createSignal<ReplyQuote | undefined>(restored.prompt.quote);
  function persistPrompt(text: string, savedQuote: ReplyQuote | undefined) {
    const savedText = prompt?.standalone && !prompt.feedbackIds ? (text ? `${text}\n\n${prompt.text}` : prompt.text) : text;
    if (!savePromptDraft(id, { text: savedText, quote: savedQuote, uncertain: promptUncertain })) setNotice("Unsent text is only in memory. This browser could not save it; keep this tab open.");
  }
  /** Retains a trimmed snapshot; empty or over-budget selections leave the draft and quote intact. */
  function quoteReply(selected: ReplyQuote): boolean {
    const next = { author: selected.author, text: selected.text.trim() };
    if (!next.text) return false;
    if (new TextEncoder().encode(formatReply(draft(), next)).length > 32_768) {
      setNotice("Reply is too long. Select a shorter quote or shorten your draft to fit within 32 KiB.");
      return false;
    }
    setQuote(next);
    return true;
  }
  function clearQuote(): void { setQuote(undefined); }
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
  let prompt: { id: string; text: string; quote: ReplyQuote | undefined; images: string[]; standalone?: boolean; feedbackIds?: string[] } | undefined; let epoch = ""; let attachmentNotice = false;
  const stopSaving = createRoot(dispose => {
    createEffect(() => [draft(), quote(), pending()] as const, ([text, quote]) => persistPrompt(text, quote));
    createEffect(() => [feedback(), pending()] as const, ([notes]) => persistFeedback(notes));
    return dispose;
  });
  function send(action: BrowserAction): string | undefined {
    if (!connected() || !epoch || (!state.synced && action.type !== "attach")) return;
    const requestId = crypto.randomUUID();
    if (transport({ v: 1, sessionId: id, epoch, requestId, action })) return requestId;
  }
  const online = () => connected() && state.synced;
  const canConfigure = () => online() && state.status.process === "ready" && state.status.activity === "idle" && !pending() && !settingsPending() && !historyBusy();
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
  /** Requests a fresh live snapshot before releasing history; false preserves the page on transport failure. */
  function latestHistory(): boolean {
    historyRead?.abort(); historyVersion++; setHistoryBusy(false);
    if (!historyPage()) { setNewReplies(false); return true; }
    if (!send({ type: "attach" })) { setNotice("Reconnect before returning to the latest replies."); return false; }
    setHistoryPage(undefined); setNewReplies(false); setStick(true);
    setState(value => { value.messages = {}; value.order = []; value.older = false; value.canvasReadyId = null; });
    return true;
  }
  /** Loads one replacement page; breadcrumbs retain only SDK cursor strings, not messages. */
  async function navigateHistory(direction: "older" | "newer") {
    if (!online() || historyBusy() || !historyPage() && state.status.activity !== "idle") return;
    const previous = historyPage();
    if (direction === "newer" && (!previous || previous.index <= 1)) { latestHistory(); return; }
    if (direction === "older" && !(previous ? previous.older : state.older)) return;
    const index = previous ? previous.index + (direction === "older" ? 1 : -1) : 1;
    const cursor = previous ? direction === "older" ? previous.older : previous.trail[index] : null;
    const start = previous ? null : state.order[0] ?? null;
    const controller = new AbortController(); historyRead?.abort(); historyRead = controller;
    const version = ++historyVersion; const expectedEpoch = state.epoch;
    setHistoryBusy(true); setNotice("");
    try {
      const page = await readHistory(id, { type: "page", cursor, start }, expectedEpoch, controller.signal, capability());
      if (disposed || version !== historyVersion || expectedEpoch !== state.epoch) return;
      if (page.type !== "page") throw new Error("Invalid history page.");
      if (!page.messages.length) {
        setState(value => { value.older = false; });
        if (previous) setHistoryPage({ ...previous, older: null });
        setNotice("No earlier displayed exchanges remain."); return;
      }
      const trail = previous ? previous.trail.slice() : [page.latestCursor];
      trail[index] = page.cursor;
      setHistoryPage({ cursor: page.cursor, older: page.olderCursor, trail, index }); setStick(false);
      setState(value => { value.messages = Object.fromEntries(page.messages.map(message => [message.id, message])); value.order = page.messages.map(message => message.id); value.older = page.olderCursor !== null; value.canvasReadyId = null; });
    } catch (error) {
      if (!controller.signal.aborted && !disposed && version === historyVersion) {
        if (!previous) setNewReplies(false);
        setNotice(error instanceof Error ? error.message : "History is unavailable.");
      }
    }
    finally { if (version === historyVersion) setHistoryBusy(false); }
  }
  /** Original text belongs only to its mounted reader and is never retained in the model. */
  async function loadOriginal(sourceKey: string, signal: AbortSignal): Promise<string> {
    const expectedEpoch = state.epoch;
    const value = await readHistory(id, { type: "original", cursor: historyPage()?.cursor ?? null, sourceKey }, expectedEpoch, signal, capability());
    if (value.type !== "original" || disposed || state.epoch !== expectedEpoch) throw new Error("Original reply changed; try again.");
    return value.text;
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
  /** Releases previews; confirmed deletion also discards this conversation’s saved unsent work. */
  function dispose(discardDraft = false) {
    disposed = true; historyRead?.abort(); historyVersion++; review.cancel(); for (const image of attachments()) removeImage(image.id);
    if (discardDraft) { prompt = undefined; promptUncertain = feedbackUncertain = false; setDraft(""); setQuote(undefined); setFeedback([]); }
    flush(); stopSaving(); setQuote(undefined);
    if (discardDraft) { savePromptDraft(id, { text: "", uncertain: false }); saveFeedbackDraft(id, { notes: [], uncertain: false }); }
  }
  async function loadImage(imageId: string): Promise<Blob> { return (await imageRequest(id, imageId, undefined, capability())).blob(); }
  const canSteer = () => online() && state.status.process === "ready" && ["running", "retrying"].includes(state.status.activity) && !pending() && !settingsPending();
  const canSend = () => (canConfigure() || canSteer()) && !settingsRequest && (!!draft().trim() || attachments().length > 0) && !uploading() && (!attachments().length || !!state.settings.model?.images) && new TextEncoder().encode(formatReply(draft(), quote())).length <= 32_768;
  function submit() {
    if (prompt || !canSend()) return;
    if (!latestHistory()) return;
    const text = draft(); const submittedQuote = quote(); const images = attachments().map(image => image.id); const requestId = send({ type: canSteer() ? "steer" : "prompt", text: formatReply(text, submittedQuote), images });
    if (requestId) { prompt = { id: requestId, text, quote: submittedQuote, images }; promptUncertain = true; setPending(true); setNotice(""); setStick(true); }
  }
  /** Sends an explicit review question independently of the composer. Returns transport acceptance.
   * Failed or uncertain delivery restores standalone questions to the draft; feedback batches stay collected. Never replays a request.
   */
  function submitReview(text: string, feedbackIds?: string[]): boolean {
    if (disposed || prompt || settingsRequest || (!canConfigure() && !(feedbackIds && canSteer())) || !text.trim() || new TextEncoder().encode(text).length > 32_768) return false;
    if (!latestHistory()) return false;
    const requestId = send({ type: canSteer() ? "steer" : "prompt", text, images: [] });
    if (!requestId) return false;
    prompt = { id: requestId, text, quote: undefined, images: [], standalone: true, feedbackIds };
    setPending(true); setNotice(""); setStick(true);
    if (feedbackIds) feedbackUncertain = true;
    else promptUncertain = true;
    return true;
  }
  function preserveReviewQuestion(text: string) { setDraft(previous => previous ? `${previous}\n\n${text}` : text); }
  function disconnected() {
    historyRead?.abort(); historyVersion++; setHistoryBusy(false);
    setState(value => { value.synced = false; value.dialogs = []; });
    const interrupted = prompt; prompt = undefined;
    if (interrupted) {
      if (interrupted.standalone && !interrupted.feedbackIds) preserveReviewQuestion(interrupted.text);
      setNotice("Prompt delivery is uncertain. Inspect the transcript before sending your preserved draft again.");
    }
    setPending(false);
    settingsRequest = undefined; setSettingsPending(false);
  }
  function stopped() {
    disconnected(); epoch = ""; setHistoryPage(undefined); setNewReplies(false); setNoticeDismissed(false);
    // Stopped catalog records retain drafts, not four active-runtime budgets of transcript each.
    setState(value => { Object.assign(value, initialState()); value.status.process = "exited"; });
  }
  /** Returns whether this runtime incarnation accepted the frame for workspace bookkeeping. */
  function receive(message: ServerMessage): boolean {
    if (message.sessionId !== id) return false;
    if (message.body.type === "hello") {
      if (attachmentNotice) { setNotice(""); attachmentNotice = false; }
      if (message.epoch !== epoch) {
        historyRead?.abort(); historyVersion++; setHistoryBusy(false); setHistoryPage(undefined); setNewReplies(false);
        setState(value => { value.messages = {}; value.order = []; });
        if (prompt || settingsRequest) disconnected(); completedRun = 0n; setStick(true);
      }
      epoch = message.epoch;
    }
    const applied: { action: ReturnType<typeof applyServer>; noticeChanged: boolean; live: boolean } = { action: "ignore", noticeChanged: false, live: false };
    setState(value => {
      const previousNotice = value.status.notice; const previousEpoch = value.epoch;
      applied.action = applyServer(value, message, !!historyPage());
      applied.noticeChanged = value.status.notice !== previousNotice || value.epoch !== previousEpoch;
      applied.live = applied.action === "applied" && value.synced;
    });
    if ((historyPage() || historyBusy()) && applied.action === "applied" && message.body.type === "event" && message.body.patches.some(patch => patch.kind === "message" || patch.kind === "delta")) setNewReplies(true);
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
        const acknowledged = prompt; prompt = undefined;
        if (acknowledged.feedbackIds) feedbackUncertain = false; else promptUncertain = false;
        if (result.ok && result.disposition === "queued") setNotice("Correction queued for Pi’s next tool boundary.");
        if (result.ok && !acknowledged.standalone) {
          if (draft() === acknowledged.text) setDraft("");
          if (quote() === acknowledged.quote) clearQuote();
          for (const image of acknowledged.images) removeImage(image);
        }
        if (result.ok && acknowledged.feedbackIds) { const sent = new Set(acknowledged.feedbackIds); setFeedback(notes => notes.filter(note => !sent.has(note.id))); }
        if (!result.ok && acknowledged.standalone && !acknowledged.feedbackIds && !result.recoveredDraft) preserveReviewQuestion(acknowledged.text);
        setPending(false);
      }
      if (result.recoveredDraft) setDraft(previous => previous ? `${previous}\n\n${result.recoveredDraft}` : result.recoveredDraft!);
      if (!result.ok) setNotice(`Command not completed: ${result.code.replaceAll("_", " ")}. Your draft was kept.`);
    }
    return true;
  }
  return { id, dispose, historyPage, historyBusy, newReplies, navigateHistory, latestHistory, loadOriginal, loadSource: (path: string, line: number, signal: AbortSignal) => loadSource(id, path, line, signal, capability()), feedback, addFeedback, editFeedback, removeFeedback, submitFeedback, codeLocation, openCode, review, reviewCards, loadReviewPreview, attachments, uploading, addImages, removeImage, loadImage, searchFiles: (query: string, signal: AbortSignal) => searchWorkspaceFiles(id, query, signal, capability()), state, draft, setDraft, quote, quoteReply, clearQuote, notice, setNotice, visibleNotice, dismissNotice, pending, settingsPending, canConfigure, setModel, setThinkingLevel, stick, setStick, online, canSend, canSteer, send, submit, submitReview, receive, disconnected, stopped, scroll: 0, reviewPosition: { filter: "", needsReview: false, groupKey: "", view: "files" as "files" | "overview", scroll: 0, identity: "" } };
}
export type SessionModel = ReturnType<typeof createSessionModel>;
