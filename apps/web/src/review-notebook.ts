import { createSignal, flush } from "solid-js";
import { diffLines, type DiffLine, type LocalReviewModel, type ReviewFile } from "./local-review";
import { accountResponse, emptyUsage, groupingUsageLabel, type GroupModel } from "./review-costs";
import { fetchReviewGroups, type GroupRequest } from "./review-groups";
import { validateExplanation } from "./review-explanations";
import { parseAuthorNotes, matchAuthorNotes, relocateAuthorRow, type AuthorNote } from "./author-notes";

export interface SavedFile extends ReviewFile { reviewed: boolean }
export interface ReviewRound { id: string; label: string; source: string; files: SavedFile[] }
/** Inclusive 1-based raw patch rows. Live discussions retain only their quoted excerpt and source identity. */
export interface ReviewAnchor { round: string; path: string; start: number; end: number; live?: { quote: string; fingerprint: string; checkoutKey?: string; target: string } }
export interface ThreadMessage { role: "human" | "assistant" | "author"; text: string; model: string | null; usage: string | null }
export interface ReviewThread { id: string; anchor: ReviewAnchor; chapter: string; kind: "discussion" | "author" | "finding"; status: "open" | "addressed" | "verified"; messages: ThreadMessage[] }
export interface ReviewNotebook { version: 1; revision: number; rounds: ReviewRound[]; threads: ReviewThread[]; routes: { explain: GroupModel | null; review: GroupModel | null; budget: number } }
export interface ReviewHunk { header: string; start: number; end: number; rows: DiffLine[] }
const bytes = (text: string) => new TextEncoder().encode(text).length;
export { authorNoteInstructions } from "./author-notes";

/** Imports author rationale only when every note matches the chosen snapshot; manual imports fail visibly on stale input. */
export function authorThreads(value: unknown, round: ReviewRound): ReviewThread[] {
  const notes = parseAuthorNotes(value);
  for (const note of notes) {
    const file = round.files.find(file => file.path === note.path);
    if (!file || !matchAuthorNotes([note], file).matched.length) throw new Error(`Author note for ${note.path} is stale or ambiguous. Refresh its line and quote.`);
  }
  return matchedAuthorThreads(notes, round);
}

/** Converts validated matches to durable commentary without changing reviewed or verification state. */
function matchedAuthorThreads(notes: AuthorNote[], round: ReviewRound): ReviewThread[] {
  return round.files.flatMap(file => matchAuthorNotes(notes, file).matched.map(({ note, row }) => ({
    id: crypto.randomUUID(), anchor: { round: round.id, path: file.path, start: row, end: row },
    chapter: note.chapter ?? "", kind: "author", status: "open",
    messages: [{ role: "author", text: note.text, model: null, usage: null }],
  })));
}

export const emptyNotebook = (): ReviewNotebook => ({ version: 1, revision: 0, rounds: [], threads: [], routes: { explain: null, review: null, budget: 16384 } });

/** Partitions source hunks using raw patch coordinates; metadata stays outside annotations. */
export function reviewHunks(patch: string): ReviewHunk[] {
  const rows = diffLines(patch), hunks: ReviewHunk[] = [];
  rows.forEach((row, index) => {
    if (row.kind === "header" && row.text.startsWith("@@ ")) hunks.push({ header: row.text, start: index + 1, end: index + 1, rows: [] });
    const hunk = hunks.at(-1);
    if (hunk && row.kind !== "header") { hunk.end = index + 1; hunk.rows.push(row); }
  });
  return hunks;
}

/** Matches live anchors only against the same scope, checkout, file fingerprint, and quoted rows.
 * Retained-source anchors may relocate uniquely unchanged quotes; their original source remains available.
 */
export function locateThread(notebook: ReviewNotebook, thread: ReviewThread, file: ReviewFile, savedRound?: string, liveTarget?: string): { start: number; end: number } | undefined {
  if (thread.anchor.path !== file.path) return;
  const { live, start, end } = thread.anchor;
  if (live) {
    if (savedRound || live.target !== liveTarget || live.fingerprint !== file.fingerprint || live.checkoutKey !== file.checkoutKey) return;
    return diffLines(file.patch).slice(start - 1, end).map(row => row.text).join("\n") === live.quote ? { start, end } : undefined;
  }
  const source = notebook.rounds.find(round => round.id === thread.anchor.round)?.files.find(item => item.path === file.path);
  if (!source) return;
  if (source.checkoutKey && source.checkoutKey !== file.checkoutKey) return;
  if (thread.kind === "author") {
    if (!source.checkoutKey && savedRound !== thread.anchor.round) return;
    const row = relocateAuthorRow(source.patch, thread.anchor.start - 1, file.patch);
    return row === undefined ? undefined : { start: row + 1, end: row + 1 };
  }
  const before = diffLines(source.patch), after = diffLines(file.patch);
  const quote = before.slice(thread.anchor.start - 1, thread.anchor.end).map(row => row.text);
  if (!quote.length) return;
  if (source.patch === file.patch) return { start: thread.anchor.start, end: thread.anchor.end };
  const candidates: number[] = [];
  for (let i = 0; i + quote.length <= after.length; i++) {
    if (quote.every((text, offset) => text === after[i + offset].text)) candidates.push(i);
    if (candidates.length > 1) return;
  }
  return candidates.length === 1 ? { start: candidates[0] + 1, end: candidates[0] + quote.length } : undefined;
}

/** Reports added/changed and removed hunks without treating shifted line numbers as edits.
 * Identical duplicate hunks match one at a time. Full before/after patches remain available.
 */
export function changedHunks(before: string, after: string) {
  const old = reviewHunks(before), next = reviewHunks(after);
  const key = (hunk: ReviewHunk) => JSON.stringify(hunk.rows.map(row => row.text));
  const remaining = [...old], changed: ReviewHunk[] = [];
  for (const hunk of next) {
    const index = remaining.findIndex(previous => key(previous) === key(hunk));
    if (index < 0) changed.push(hunk); else remaining.splice(index, 1);
  }
  return { changed, removed: remaining };
}

/** Builds one bounded analysis from current live diffs or a retained imported source, excluding author rationale.
 * Live context must contain the discussed file. Only matching, loaded chapter discussions contribute related context.
 * Budget is serialized request bytes, not a token or dollar guarantee. Oversize selections fail visibly.
 */
export function threadAnalysis(notebook: ReviewNotebook, thread: ReviewThread, task: "explain" | "review", fallback?: GroupModel, live?: { files: ReviewFile[]; target: string }): GroupRequest {
  const round = thread.anchor.live ? live && { id: "live", files: live.files } : notebook.rounds.find(round => round.id === thread.anchor.round);
  if (thread.anchor.live && (!live || !live.files.some(file => locateThread(notebook, thread, file, undefined, live.target)))) throw new Error("This discussion is stale. Start a discussion on the current code before running AI.");
  const selected = round?.files.find(file => file.path === thread.anchor.path);
  if (!selected || !round) throw new Error("The source round is unavailable.");
  const humanIndex = thread.messages.map(message => message.role).lastIndexOf("human");
  let question = thread.messages[humanIndex]?.text ?? "Explain the behavior of this change.";
  if (question.length > 4000) throw new Error("Keep the AI question within 4,000 characters.");
  const earlier = humanIndex < 0 ? [] : thread.messages.slice(0, humanIndex).filter(message => message.role === "human" || (task === "explain" && message.role === "assistant")).slice(-4);
  for (const message of earlier.reverse()) {
    const context = `Earlier ${message.role === "human" ? "question" : "AI interpretation (not evidence)"}: ${message.text}\n\n`;
    if (context.length + question.length > 4000) break;
    question = context + question;
  }
  const model = notebook.routes[task] ?? fallback;
  if (!model) throw new Error("Choose an available review model first.");
  const request: GroupRequest = { files: [], details: [], readsRemaining: 0, model, explain: { title: task === "review" ? "Independent review of selected change" : "Question about selected change", question, task } };
  const chapter = thread.chapter ? notebook.threads.filter(item => item.chapter === thread.chapter && item.anchor.round === round.id &&
    (!thread.anchor.live || live?.files.some(file => locateThread(notebook, item, file, undefined, live.target)))) : [];
  const related = chapter.map(item => item.anchor.path);
  const paths = [...new Set([selected.path, ...related])];
  if (paths.length > 8) throw new Error("This chapter exceeds eight files. Split it before AI analysis.");
  for (const path of paths) {
    const file = round.files.find(file => file.path === path);
    if (!file) throw new Error("A linked discussion is stale or its file is not loaded. Refresh and inspect its source first.");
    const rows = diffLines(file.patch);
    const sources = path === selected.path ? [thread] : chapter.filter(item => item.anchor.path === path);
    const anchors = sources.map(item => {
      if (!item.anchor.live) return item.anchor;
      const location = locateThread(notebook, item, file, undefined, live?.target);
      if (!location) throw new Error("A linked discussion is stale or its file is not loaded. Refresh and inspect its source first.");
      return location;
    });
    const start = Math.min(...anchors.map(anchor => anchor.start));
    const end = Math.max(...anchors.map(anchor => anchor.end));
    const patch = rows.slice(start - 1, end).map(row => row.text).join("\n");
    if (!patch || bytes(patch) > 8192 || end - start >= 120) throw new Error("Select a smaller hunk: each AI excerpt is limited to 8 KiB and 120 rows.");
    request.files.push({ path, status: file.status, patch: "", added: 0, removed: 0, patchLines: rows.length, sampled: start !== 1 || end !== rows.length });
    request.details.push({ path, startLine: start, patch });
  }
  if (bytes(JSON.stringify(request)) > notebook.routes.budget) throw new Error("Analysis exceeds your input budget. Select less context or raise the budget explicitly.");
  return request;
}

/** Admits a server-validated, versioned document; malformed envelopes never replace local drafts. */
function parseNotebook(value: unknown): ReviewNotebook {
  const doc = value as ReviewNotebook | null;
  if (!doc || doc.version !== 1 || !Number.isSafeInteger(doc.revision) || doc.revision < 0 || !Array.isArray(doc.rounds) || doc.rounds.length > 16 || !Array.isArray(doc.threads) || doc.threads.length > 128 || !doc.routes || !Number.isSafeInteger(doc.routes.budget)) throw new Error("Invalid saved review response.");
  if (doc.rounds.some(round => typeof round.id !== "string" || !Array.isArray(round.files) || round.files.some(file => typeof file.path !== "string" || typeof file.patch !== "string" || typeof file.fingerprint !== "string"))) throw new Error("Invalid saved round.");
  return doc;
}

/** Owns continuous discussions and previously saved sources. Loads/saves never invoke a model; writes use optimistic revision checks.
 * Failed/uncertain writes retain local state and require a reload before another write. AI answers are retained
 * separately when persistence fails, so retrying storage does not repeat a paid inference.
 */
export function createReviewNotebook(session: string, capability: () => string | null, review: LocalReviewModel, fallback: () => GroupModel | undefined) {
  const [document, setDocument] = createSignal<ReviewNotebook>();
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  const [activeRound, setActiveRound] = createSignal("");
  const [analysis, setAnalysis] = createSignal("");
  const [unsavedAnswer, setUnsavedAnswer] = createSignal<{ thread: string; message: ThreadMessage }>();
  let uncertain = false, controller: AbortController | undefined;
  const [autoNotes, setAutoNotes] = createSignal(false), [authorNotes, setAuthorNotes] = createSignal<AuthorNote[]>([]);
  const [authorNotice, setAuthorNotice] = createSignal(""), [notesBusy, setNotesBusy] = createSignal(false);
  let notesGeneration = 0, disposed = false, latestTurn: string | undefined;
  async function request(body: unknown, signal?: AbortSignal): Promise<ReviewNotebook> {
    const proof = capability();
    if (!proof) throw new Error("Reconnect before opening saved reviews.");
    const response = await fetch(`/review/${encodeURIComponent(session)}/notebook`, {
      method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal: signal ?? AbortSignal.timeout(30000),
      headers: { "content-type": "application/json", "x-pi-capability": proof }, body: JSON.stringify(body),
    });
    const text = await response.text();
    if (bytes(text) > 16 * 1024 * 1024 + 1024) throw new Error("Saved review exceeds the response limit.");
    const result = JSON.parse(text);
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Review storage unavailable.");
    return parseNotebook(result);
  }
  function acceptDocument(next: ReviewNotebook) {
    setDocument(next);
    if (activeRound() && !next.rounds.some(round => round.id === activeRound())) {
      setActiveRound("");
      if (review.saved()) review.closeSaved();
    }
  }
  async function load() {
    if (disposed || busy() || analysis()) return;
    setBusy(true); setError("");
    try { acceptDocument(await request({})); uncertain = false; }
    catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
    finally { setBusy(false); flush(); }
    await collectAuthorNotes();
  }
  async function save(next: ReviewNotebook): Promise<boolean> {
    if (busy() || !document()) return false;
    if (uncertain) { setError("Reload saved review before editing: the previous save may have completed."); return false; }
    setBusy(true); setError(""); flush();
    try {
      const saved = await request({ revision: document()!.revision, document: next });
      acceptDocument(saved); return true;
    } catch (reason) { uncertain = true; setError(reason instanceof Error ? reason.message : "Could not save review."); return false; }
    finally { setBusy(false); flush(); }
  }
  async function capture(label: string) {
    if (!document() || busy()) return;
    setBusy(true); setError(""); flush();
    try {
      const files = await review.capture();
      const round: ReviewRound = { id: crypto.randomUUID(), label: label.trim() || `Round ${document()!.rounds.length + 1}`, source: JSON.stringify(review.target()), files: files.map(file => ({ path: file.path, previousPath: file.previousPath, status: file.status, patch: file.patch, fingerprint: file.fingerprint, ...(file.checkoutKey ? { checkoutKey: file.checkoutKey } : {}), reviewed: review.isReviewed(file) })) };
      const collected = await collectAuthorNotes();
      const notes = matchedAuthorThreads(collected ?? [], round);
      setBusy(false); flush();
      if (await save({ ...document()!, rounds: [...document()!.rounds, round], threads: [...document()!.threads, ...notes] })) openRound(round);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Cannot capture round."); }
    finally { setBusy(false); flush(); }
  }
  function openRound(round: ReviewRound) {
    review.openSaved(round.files, `${round.label} · ${round.source}`, round.id);
    setActiveRound(round.id);
  }
  async function mark(file: ReviewFile, checked: boolean) {
    const doc = document(), round = doc?.rounds.find(round => round.id === activeRound());
    if (!doc || !round || !review.saved()) { review.mark(file, checked); return; }
    if (await save({ ...doc, rounds: doc.rounds.map(item => item.id === round.id ? { ...item, files: item.files.map(entry => entry.path === file.path ? { ...entry, reviewed: checked } : entry) } : item) })) review.mark(file, checked);
  }
  /** A live discussion stores its selected quote, not a review snapshot. Any file or scope identity change makes it stale. */
  async function addThread(file: ReviewFile, start: number, end: number, text: string, chapter = "", kind: ReviewThread["kind"] = "discussion") {
    const doc = document(), round = doc?.rounds.find(item => item.id === activeRound());
    if (!doc || review.busy() || analysis()) return false;
    const rows = diffLines(file.patch), quote = rows.slice(start - 1, end).map(row => row.text).join("\n");
    if (start < 1 || end < start || end > rows.length || !quote.trim()) { setError("Choose a nonempty source hunk."); return false; }
    let anchor: ReviewAnchor;
    if (review.saved()) {
      if (!round?.files.some(item => item.path === file.path && item.patch === file.patch)) return false;
      anchor = { round: round.id, path: file.path, start, end };
    } else {
      if (!review.target() || !review.snapshot()?.files.some(item => item.path === file.path && item.fingerprint === file.fingerprint && item.patch === file.patch)) { setError("Source changed. Refresh before adding a discussion."); return false; }
      anchor = { round: "live", path: file.path, start, end, live: { quote, fingerprint: file.fingerprint, target: JSON.stringify(review.target()), ...(file.checkoutKey ? { checkoutKey: file.checkoutKey } : {}) } };
    }
    const thread: ReviewThread = { id: crypto.randomUUID(), anchor, chapter, kind, status: "open", messages: [{ role: kind === "author" ? "author" : "human", text, model: null, usage: null }] };
    return save({ ...doc, threads: [...doc.threads, thread] });
  }
  /** Staleness is derived from the displayed source, so old verification never applies to changed code. */
  function isStale(thread: ReviewThread) {
    if (review.busy() || review.patchBusy()) return true;
    const file = review.snapshot()?.files.find(file => file.path === thread.anchor.path);
    if (!document() || !file || typeof file.patch !== "string") return true;
    if (!thread.anchor.live) {
      const source = document()!.rounds.find(round => round.id === thread.anchor.round)?.files.find(item => item.path === file.path);
      if (review.saved() ? activeRound() !== thread.anchor.round : source?.fingerprint !== file.fingerprint) return true;
    }
    return !locateThread(document()!, thread, file as ReviewFile, review.saved() ? activeRound() : undefined, JSON.stringify(review.target()));
  }
  function analysisInput(thread: ReviewThread, task: "explain" | "review") {
    return threadAnalysis(document()!, thread, task, fallback(), { files: (review.snapshot()?.files ?? []).filter((file): file is ReviewFile => typeof file.patch === "string" && typeof file.fingerprint === "string"), target: JSON.stringify(review.target()) });
  }
  async function updateThread(id: string, update: (thread: ReviewThread) => ReviewThread) {
    const doc = document(), previous = doc?.threads.find(thread => thread.id === id);
    if (!doc || !previous) return false;
    const next = update(previous);
    if (next.status === "verified" && previous.status !== "verified" && isStale(previous)) { setError("This discussion is stale. Verify a fresh discussion against the current code instead."); return false; }
    return save({ ...doc, threads: doc.threads.map(thread => thread.id === id ? next : thread) });
  }
  async function persistAnswer() {
    const answer = unsavedAnswer();
    if (!answer) return;
    const thread = document()?.threads.find(thread => thread.id === answer.thread);
    if (!thread) { setError("The answer's thread is unavailable. Copy the answer before clearing it."); return; }
    // A lost HTTP response may have followed a successful save. Do not duplicate that answer after reload.
    if (thread.messages.some(message => JSON.stringify(message) === JSON.stringify(answer.message)) || await updateThread(answer.thread, thread => ({ ...thread, messages: [...thread.messages, answer.message] }))) setUnsavedAnswer(undefined);
  }
  async function ask(thread: ReviewThread, task: "explain" | "review") {
    if (controller || busy() || !document() || unsavedAnswer()) return;
    setError("");
    const current = new AbortController(); controller = current; setAnalysis(thread.id); flush();
    try {
      if (thread.anchor.live) {
        if (review.saved() || JSON.stringify(review.target()) !== thread.anchor.live.target) throw new Error("This discussion is stale in the selected review scope.");
        await review.refresh();
        if (current.signal.aborted || disposed) return;
        if (review.error() || review.busy()) throw new Error(review.error() || "Wait for the current source to finish loading.");
        const linked = thread.chapter ? document()!.threads.filter(item => item.chapter === thread.chapter && item.anchor.live?.target === thread.anchor.live!.target) : [];
        for (const path of new Set([thread.anchor.path, ...linked.map(item => item.anchor.path)])) {
          await review.loadPatch(path);
          if (current.signal.aborted || disposed) return;
          if (review.patchError()) throw new Error(review.patchError());
        }
      }
      const input = analysisInput(thread, task);
      const response = await fetchReviewGroups(session, input, current.signal, capability());
      if (current.signal.aborted) return;
      const accounted = accountResponse(response, { ...emptyUsage(), calls: 1, requestBytes: bytes(JSON.stringify(input)) });
      const answer = validateExplanation(accounted.result, input);
      const sections = ([['observations', 'Observed in supplied diff'], ['inferences', 'Inference'], ['risks', 'Potential findings — verify']] as const).flatMap(([key, title]) => answer[key].map(statement => `${title}: ${statement.text}\n${statement.citations.map(citation => `${citation.path} · diff rows ${citation.startLine}–${citation.endLine}`).join("\n")}`));
      const message: ThreadMessage = { role: "assistant", text: [...sections, `Limits: ${answer.limitations.join("; ")}`, "Only supplied diff excerpts were inspected. No repository exploration or tests ran."].join("\n\n"), model: `${input.model!.provider}/${input.model!.id}`, usage: groupingUsageLabel(accounted.usage) };
      setUnsavedAnswer({ thread: thread.id, message }); flush();
      await persistAnswer();
    } catch (reason) { setError(current.signal.aborted ? "Analysis cancelled. Provider usage may still be billed." : reason instanceof Error ? reason.message : "Analysis failed."); }
    finally { if (controller === current) { controller = undefined; setAnalysis(""); flush(); } }
  }
  async function sourceRequest(body: unknown): Promise<unknown> {
    const proof = capability();
    if (!proof) throw new Error("Reconnect before importing review sources.");
    const response = await fetch(`/review/${encodeURIComponent(session)}/source`, { method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(40000), headers: { "content-type": "application/json", "x-pi-capability": proof }, body: JSON.stringify(body) });
    const text = await response.text();
    if (bytes(text) > 8 * 1024 * 1024) throw new Error("Imported source exceeds the response limit.");
    const value = JSON.parse(text);
    if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "Import failed.");
    return value;
  }
  /** Refreshes session-scoped notes on view entry and run completion; inference is never involved.
   * A completion token rejects a previous turn's output even when its source quote still matches.
   */
  async function collectAuthorNotes(turn?: string) {
    if (disposed) return;
    if (turn) latestTurn = turn;
    const generation = ++notesGeneration;
    setNotesBusy(true);
    try {
      if (turn && !review.saved() && review.snapshot() && !review.busy()) await review.refresh();
      const preferences = await sourceRequest({ kind: "preferences" }) as { enabled?: unknown };
      if (generation !== notesGeneration || disposed) return;
      if (typeof preferences.enabled !== "boolean") throw new Error("Invalid author-note preference response.");
      setAutoNotes(preferences.enabled); setAuthorNotes([]); setAuthorNotice("");
      if (!preferences.enabled) return;
      const value = await sourceRequest({ kind: "author", automatic: true }) as { turn?: unknown };
      if (generation !== notesGeneration || disposed) return;
      if (latestTurn && value?.turn !== latestTurn) throw new Error("No author notes for the latest turn. Earlier notes were not attached.");
      const notes = parseAuthorNotes(value, true);
      if (generation !== notesGeneration || disposed) return;
      setAuthorNotes(notes);
      setAuthorNotice(notes.length ? `${notes.length} author notes loaded. Only exact source matches appear beside code.` : "The agent supplied no author notes.");
      return notes;
    } catch (reason) {
      if (generation === notesGeneration && !disposed) { setAuthorNotes([]); setAuthorNotice(reason instanceof Error ? reason.message : "Could not collect author notes."); }
    } finally { if (generation === notesGeneration && !disposed) { setNotesBusy(false); flush(); } }
  }
  /** Saves the project preference before it becomes effective for subsequent prompts. */
  async function configureAuthorNotes(enabled: boolean) {
    if (notesBusy() || disposed) return;
    ++notesGeneration; setNotesBusy(true); flush();
    try {
      const value = await sourceRequest({ kind: "preferences", enabled }) as { enabled?: unknown };
      if (disposed) return;
      if (value.enabled !== enabled) throw new Error("Author-note preference was not saved.");
      setAutoNotes(enabled); setAuthorNotes([]); setAuthorNotice("");
    } catch (reason) { if (!disposed) setAuthorNotice(reason instanceof Error ? reason.message : "Could not save author-note preference."); return; }
    finally { if (!disposed) { setNotesBusy(false); flush(); } }
    if (!disposed) await collectAuthorNotes();
  }
  function dispose() { disposed = true; notesGeneration++; controller?.abort(); }

  async function importSource(kind: "pr" | "jj", value: string) {
    if (!document() || busy() || analysis()) return;
    setBusy(true); setError(""); flush();
    try {
      const result = await sourceRequest(kind === "pr" ? { kind, url: value } : { kind, revision: value }) as Omit<ReviewRound, "id">;
      if (typeof result.label !== "string" || typeof result.source !== "string" || !Array.isArray(result.files)) throw new Error("Invalid imported round.");
      const round: ReviewRound = { ...result, id: crypto.randomUUID() };
      setBusy(false); flush();
      if (await save({ ...document()!, rounds: [...document()!.rounds, round] })) openRound(round);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Import failed."); }
    finally { setBusy(false); flush(); }
  }
  async function importAuthorNotes() {
    const doc = document(), round = doc?.rounds.find(round => round.id === activeRound());
    if (!doc || !round || busy() || analysis()) return;
    setBusy(true); setError(""); flush();
    try {
      const notes = authorThreads(await sourceRequest({ kind: "author" }), round);
      const key = (thread: ReviewThread) => JSON.stringify([thread.anchor, thread.messages[0].text]);
      const existing = new Set(doc.threads.filter(thread => thread.kind === "author").map(key));
      const unique = notes.filter(thread => { const value = key(thread); if (existing.has(value)) return false; existing.add(value); return true; });
      setBusy(false); flush();
      await save({ ...doc, threads: [...doc.threads, ...unique] });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Cannot import author notes."); }
    finally { setBusy(false); flush(); }
  }
  function cancel() { controller?.abort(); }
  return { autoNotes, authorNotes, authorNotice, notesBusy, collectAuthorNotes, configureAuthorNotes, dispose, document, load, save, busy, error, setError, activeRound, openRound, capture, mark, addThread, updateThread, ask, analysis, cancel, unsavedAnswer, discardAnswer: () => setUnsavedAnswer(undefined), persistAnswer, fallback, isStale, analysisInput, importSource, importAuthorNotes };
}
export type ReviewNotebookModel = ReturnType<typeof createReviewNotebook>;
