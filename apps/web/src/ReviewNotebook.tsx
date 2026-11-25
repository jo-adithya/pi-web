import { Button } from "@kobalte/core/button";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { Checkbox } from "@kobalte/core/checkbox";
import { matchAuthorNotes, type AuthorNote } from "./author-notes";
import { SelectField } from "./components/SelectField";
import { diffLines, type DiffLine, type ReviewFile } from "./local-review";
import { reviewLineKey } from "./review-history";
import { authorNoteInstructions, emptyNotebook, locateThread, reviewHunks, type ReviewNotebook, type ReviewThread } from "./review-notebook";
import type { SessionModel } from "./session-model";
import "./review-notebook.css";

interface AnnotationSlot { start: number; end: number; hunk: boolean; threads: ReviewThread[]; authors?: AuthorNote[] }
/** Builds durable discussion and live author-note placements once per file/document. */
export function annotationSlots(document: ReviewNotebook | undefined, file: ReviewFile | undefined, authors: AuthorNote[] = [], savedRound?: string, liveTarget?: string) {
  const slots = new Map<string, AnnotationSlot>();
  if (!file) return slots;
  const rows = diffLines(file.patch);
  if (document) for (const hunk of reviewHunks(file.patch)) if (hunk.rows.length) slots.set(reviewLineKey(rows[hunk.end - 1]), { start: hunk.start + 1, end: hunk.end, hunk: true, threads: [] });
  for (const thread of document?.threads ?? []) {
    const location = locateThread(document!, thread, file, savedRound, liveTarget);
    if (!location) continue;
    const key = reviewLineKey(rows[location.end - 1]);
    const slot = slots.get(key) ?? { ...location, hunk: false, threads: [] };
    slot.threads.push(thread); slots.set(key, slot);
  }
  for (const { note, row } of matchAuthorNotes(authors, file).matched) {
    const key = reviewLineKey(rows[row - 1]);
    const slot = slots.get(key) ?? { start: row, end: row, hunk: false, threads: [] };
    if (slot.threads.some(thread => thread.kind === "author" && thread.chapter === (note.chapter ?? "") && thread.messages[0]?.text === note.text)) continue;
    (slot.authors ??= []).push(note); slots.set(key, slot);
  }
  return slots;
}

/** Continuous discussions, explicit source imports, and model policies. Opening makes no inference calls. */
export function ReviewNotebookPanel(props: { model: SessionModel; file?: ReviewFile }) {
  const notebook = props.model.notebook, review = props.model.review;
  onSettled(() => { void notebook.load(); });
  const staleAuthors = createMemo(() => props.file && !review.saved() ? matchAuthorNotes(notebook.authorNotes(), props.file).stale : []);
  const [source, setSource] = createSignal(""), [sourceKind, setSourceKind] = createSignal<"pr" | "jj">("pr");
  const [notice, setNotice] = createSignal("");
  const disabled = () => notebook.busy() || !!notebook.analysis();
  const rounds = () => notebook.document()?.rounds ?? [];
  const current = () => rounds().find(round => round.id === notebook.activeRound());
  const stories = createMemo(() => {
    const groups = new Map<string, ReviewThread[]>();
    for (const thread of notebook.document()?.threads ?? []) if (thread.chapter) { const group = groups.get(thread.chapter) ?? []; group.push(thread); groups.set(thread.chapter, group); }
    return [...groups];
  });
  const unattached = () => notebook.document()?.threads.filter(thread => !props.file || !locateThread(notebook.document()!, thread, props.file, review.saved() ? notebook.activeRound() : undefined, JSON.stringify(review.target()))) ?? [];
  const openThread = (thread: ReviewThread) => {
    if (thread.anchor.live) { void review.setSelected(thread.anchor.path); return; }
    const round = rounds().find(round => round.id === thread.anchor.round);
    if (round) { notebook.openRound(round); void review.setSelected(thread.anchor.path); }
  };
  return <section class="review-notebook" aria-label="Review notebook">
    <Checkbox checked={notebook.autoNotes()} disabled={notebook.notesBusy()} onChange={enabled => void notebook.configureAuthorNotes(enabled)}>
      <Checkbox.Input aria-label="Add review notes automatically for this project" /><Checkbox.Control class="checkbox-control"><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control><Checkbox.Label>Add review notes automatically for this project</Checkbox.Label>
    </Checkbox>
    <p class="notebook-help">Opt-in for future implementation prompts, across this project's conversations. Notes load automatically after completion and when opening Changes. Adds instruction/output tokens, not a separate review call. The agent may omit notes. Pi Web checks the captured checkout, revision, and whole hunk; a matching hunk is not proof that the rationale is correct. At most eight notes, 600 characters each, are accepted. This is not a token or dollar cap. The agent uses record/list/delete tools for this turn only. Source evidence is captured when recorded and rechecked at completion. Automatic notes use private storage, not workspace JSON files.</p>
    <Show when={notebook.authorNotice()}><p class="notebook-help" role="status">{notebook.authorNotice()}</p></Show>
    <Show when={staleAuthors().length}><details><summary>{staleAuthors().length} unmatched author notes for this file</summary><p>The checkout, captured hunk, or source quote changed or no longer matches uniquely. Notes invalidated by final edits stay unattached; ask the agent to record fresh notes.</p><For each={staleAuthors()}>{note => <div><p>{note.text}</p><pre>{note.quote}</pre></div>}</For></details></Show>
    <Show when={notebook.document()} fallback={<Button type="button" disabled={notebook.busy()} onClick={() => void notebook.load()}>{notebook.busy() ? "Loading review…" : "Reload review"}</Button>}>
      <div class="notebook-heading"><h2>Continuous review</h2><Button type="button" disabled={disabled()} onClick={() => void notebook.load()}>Reload review</Button></div>
      <p class="notebook-help">Discuss the live diff directly. Discussions save privately with their quoted code, without saving review snapshots. A changed file, checkout, or scope makes a discussion stale; old verification does not apply to new code. Refresh Changes after edits. Opening, refreshing, and saving discussions make no AI calls.</p>
      <Show when={rounds().length}><details><summary>Imported and previously saved reviews</summary>
        <SelectField label="Saved source" value={review.saved() ? notebook.activeRound() : ""} placeholder="Choose a saved source" options={rounds().map(round => ({ value: round.id, label: round.label }))} change={id => { const round = rounds().find(round => round.id === id); if (round) notebook.openRound(round); }} disabled={disabled()} />
      </details></Show>
      <Show when={review.saved() && current()}>{round => <p class="notebook-help"><strong>{round().label}</strong> · {round().source}. This retained source is read-only. Choose a live scope above to inspect current edits.</p>}</Show>
      <Show when={stories().length}><details><summary>Hunk stories · {stories().length} chapters</summary>
        <p>Chapters collect human and author notes across hunks and files. They explain intent; they are not correctness verdicts.</p>
        <For each={stories()}>{([chapter, threads]) => <section><h3>{chapter}</h3><ul><For each={threads}>{thread => <li><Button type="button" onClick={() => openThread(thread)}>{thread.anchor.path} · {thread.kind === "author" ? "Author rationale" : "Discussion"}</Button><p>{thread.messages[0]?.text}</p></li>}</For></ul></section>}</For>
      </details></Show>
      <Show when={unattached().length}><details><summary>Other and stale discussions · {unattached().length}</summary><p>Stale discussions retain their replies and original quote. Their source changed, is unavailable, or has not been loaded. Inspect the current file and start a fresh discussion when needed.</p><For each={unattached()}>{thread => <div class="notebook-outdated"><Button type="button" disabled={!!thread.anchor.live && !review.snapshot()?.files.some(file => file.path === thread.anchor.path)} onClick={() => openThread(thread)}>{thread.anchor.path} · {thread.anchor.live ? "Open current file" : "Open retained source"}</Button><ThreadCard model={props.model} thread={thread} stale={notebook.isStale(thread)} /></div>}</For></details></Show>
      <details><summary>AI models and token budget</summary>
        <p><strong>Large reviews can consume many tokens.</strong> Each analysis is one explicit call. It sends selected diff rows and matching files linked by the same chapter, never the whole chat. Stale discussions are excluded from live AI context. Reasoning, output, provider prompts, and repeated questions add cost beyond the input estimate.</p>
        <For each={["explain", "review"] as const}>{task => <SelectField visibleLabel label={task === "explain" ? "Explanation model" : "Correctness review model"} value={notebook.document()!.routes[task] ? JSON.stringify(notebook.document()!.routes[task]) : ""} disabled={disabled()}
          options={[{ value: "", label: "Current coding model" }, ...props.model.state.settings.models.map(model => ({ value: JSON.stringify({ provider: model.provider, id: model.id }), label: `${model.name} · ${model.provider}` }))]}
          change={value => { const doc = notebook.document()!; void notebook.save({ ...doc, routes: { ...doc.routes, [task]: value ? JSON.parse(value) : null } }); }} />}</For>
        <SelectField visibleLabel label="Maximum request data per analysis" value={String(notebook.document()!.routes.budget)} disabled={disabled()} options={[4096, 8192, 16384, 32768, 49152].map(value => ({ value: String(value), label: `${value / 1024} KiB` }))} change={value => { const doc = notebook.document()!; void notebook.save({ ...doc, routes: { ...doc.routes, budget: Number(value) } }); }} />
        <p>Choose a fast model for explanations and a strong model for correctness. Review requests ask for high reasoning. No automatic downgrade or Jev classification is enabled. These jobs inspect supplied diffs only; missing callers and tests remain unverified.</p>
      </details>
      <details><summary>Author notes from implementation</summary>
        <p>The project toggle above handles instructions and collection automatically. Use Discuss this note to retain a note in a continuous discussion. The controls below support legacy imports into previously saved sources.</p>
        <Button type="button" onClick={() => { void navigator.clipboard.writeText(authorNoteInstructions).then(() => setNotice("Author-note instructions copied. Add them to your implementation request."), () => setNotice("Clipboard unavailable. Copy the instructions below.")); }}>Copy legacy JSON instructions</Button>
        <details><summary>Agent instructions and note format</summary><pre>{authorNoteInstructions}</pre></details>
        <Button type="button" disabled={disabled() || !review.saved()} onClick={() => void notebook.importAuthorNotes()}>Import .pi/review-notes.json</Button>
        <p>Select an imported or previously saved source first. Manual legacy imports check exact source lines and quotes but have no server-captured provenance; verify their scope yourself. Author notes cannot automatically resolve discussions or mark files reviewed.</p>
      </details>
      <details><summary>Import a GitHub PR or jj revision</summary>
        <div class="notebook-controls"><SelectField label="Review source" value={sourceKind()} options={[{ value: "pr", label: "GitHub pull request" }, { value: "jj", label: "Jujutsu revision" }]} change={value => setSourceKind(value as "pr" | "jj")} />
        <label>{sourceKind() === "pr" ? "PR URL" : "jj revision"}<input aria-label="Import source" value={source()} onInput={event => setSource(event.currentTarget.value)} placeholder={sourceKind() === "pr" ? "https://github.com/owner/repo/pull/123" : "@"} /></label>
        <Button type="button" disabled={disabled() || !source().trim()} onClick={() => void notebook.importSource(sourceKind(), source().trim())}>Import review source</Button></div>
        <p>PR import contacts github.com through your installed, authenticated gh CLI. It never checks out or publishes. jj reads its recorded revision without snapshotting disk edits. Imported content is not assumed to match your checkout.</p>
      </details>
      <details><summary>Export or clear saved review</summary><Button type="button" onClick={() => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(notebook.document(), null, 2)], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = "review-notebook.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>Export review JSON</Button> <Button type="button" disabled={disabled() || !!notebook.unsavedAnswer()} onClick={() => { if (window.confirm("Delete all review discussions and retained sources for this conversation? Export first if needed.")) void notebook.save({ ...emptyNotebook(), revision: notebook.document()!.revision, routes: notebook.document()!.routes }); }}>Clear saved review</Button></details>
    </Show>
    <Show when={notebook.error()}><p class="review-warning" role="alert">{notebook.error()}</p></Show>
    <Show when={notice()}><p role="status">{notice()}</p></Show>
    <Show when={notebook.unsavedAnswer()}>{answer => <section aria-label="Unsaved AI answer"><p>Keep this page open: this answer is not yet persisted. Reload saved review if needed, then retry saving—no new AI call.</p><pre>{answer().message.text}</pre><p class="notebook-help">{answer().message.usage}</p><Button type="button" disabled={disabled()} onClick={() => void notebook.persistAnswer()}>Retry saving answer</Button> <Button type="button" onClick={() => { void navigator.clipboard.writeText(answer().message.text).then(() => setNotice("Answer copied."), () => setNotice("Clipboard unavailable. Select and copy the answer above.")); }}>Copy answer</Button> <Button type="button" disabled={disabled()} onClick={() => { if (window.confirm("Discard this unsaved AI answer? Copy it first if needed.")) notebook.discardAnswer(); }}>Discard unsaved answer</Button></section>}</Show>
  </section>;
}

/** Renders discussions directly after their source rows. All model work requires a separate explicit click. */
export function HunkDiscussion(props: { model: SessionModel; file: ReviewFile; slot: AnnotationSlot }) {
  const notebook = props.model.notebook;
  const [draft, setDraft] = createSignal(""), [chapter, setChapter] = createSignal("");
  return <aside class="hunk-discussion" aria-label="Hunk discussion">
    <For each={props.slot.authors ?? []}>{note => <details class="review-thread review-thread-author"><summary>Author note · {note.text.slice(0, 100)}</summary><p>{note.text}</p><Show when={note.binding}>{binding => <p class="notebook-help">Captured base {binding().base.slice(0, 12)} → HEAD {binding().head.slice(0, 12)}. Re-check dependencies and tests before trusting this explanation.</p>}</Show><p class="notebook-help">{note.chapter || "Implementation rationale"} · Source matched; rationale unverified.</p><Button type="button" disabled={!notebook.document() || notebook.busy() || !!notebook.analysis()} onClick={() => void notebook.addThread(props.file, props.slot.start, props.slot.end, note.text, note.chapter, "author")}>Discuss this note</Button></details>}</For>
    <For each={props.slot.threads} keyed={thread => thread.id}>{thread => <ThreadCard model={props.model} thread={thread()} stale={notebook.isStale(thread())} />}</For>
    <Show when={props.slot.hunk}><details><summary>Discuss this hunk</summary><form onSubmit={event => {
      event.preventDefault();
      void notebook.addThread(props.file, props.slot.start, props.slot.end, draft(), chapter()).then(saved => { if (saved) setDraft(""); });
    }}>
      <label>Question or feedback<textarea aria-label="Hunk feedback" maxlength={4000} rows={3} value={draft()} onInput={event => setDraft(event.currentTarget.value)} /></label>
      <label>Chapter <span class="notebook-help">Optional; connects related hunks across files</span><input aria-label="Hunk chapter" maxlength={80} value={chapter()} onInput={event => setChapter(event.currentTarget.value)} /></label>
      <Button type="submit" disabled={!draft().trim() || notebook.busy() || !!notebook.analysis()}>Save discussion</Button>
    </form></details></Show>
  </aside>;
}

function ThreadCard(props: { model: SessionModel; thread: ReviewThread; stale: boolean }) {
  const notebook = props.model.notebook;
  const [reply, setReply] = createSignal(""), [task, setTask] = createSignal<"explain" | "review">("explain");
  const [notice, setNotice] = createSignal("");
  const disabled = () => notebook.busy() || !!notebook.analysis();
  const preview = createMemo(() => {
    try {
      const request = notebook.analysisInput(props.thread, task());
      const size = new TextEncoder().encode(JSON.stringify(request)).length;
      return { request, bytes: size, error: "" };
    } catch (reason) { return { error: reason instanceof Error ? reason.message : "Cannot prepare analysis." }; }
  });
  return <details class={`review-thread review-thread-${props.thread.kind}`}>
    <summary>{props.thread.kind === "author" ? "Author rationale" : props.thread.kind === "finding" ? "Review finding" : "Discussion"} · {props.stale ? "Stale" : props.thread.status} · {props.thread.messages[0]?.text.slice(0, 100)}</summary>
    <p class="notebook-help">{props.thread.chapter || "No chapter"} · {props.thread.anchor.path} · diff rows {props.thread.anchor.start}–{props.thread.anchor.end}</p>
    <Show when={props.stale}><p class="review-warning">Stale: this discussion is not verified against the current code. Previous status: {props.thread.status}.</p></Show>
    <Show when={props.thread.anchor.live}>{source => <details><summary>Original quoted code</summary><pre>{source().quote}</pre></details>}</Show>
    <For each={props.thread.messages}>{message => <div class="review-thread-message"><strong>{message.role === "human" ? "You" : message.role === "author" ? "Author · imported commentary" : "AI reviewer · interpretation"}</strong><p>{message.text}</p><Show when={message.model}><small>Requested model: {message.model}</small></Show><Show when={message.usage}><p class="notebook-help">{message.usage}</p></Show></div>}</For>
    <form onSubmit={event => { event.preventDefault(); void notebook.updateThread(props.thread.id, thread => ({ ...thread, messages: [...thread.messages, { role: "human", text: reply().trim(), model: null, usage: null }] })).then(saved => { if (saved) setReply(""); }); }}>
      <label>Reply<textarea aria-label="Thread reply" rows={2} maxlength={4000} value={reply()} onInput={event => setReply(event.currentTarget.value)} /></label>
      <Button type="submit" disabled={disabled() || !reply().trim()}>Save reply</Button>
    </form>
    <div class="notebook-controls"><For each={["open", "addressed", "verified"] as const}>{status => <Button type="button" disabled={disabled() || props.thread.status === status || props.stale && status === "verified"} onClick={() => void notebook.updateThread(props.thread.id, thread => ({ ...thread, status }))}>{status === "open" ? "Reopen" : status === "addressed" ? "Mark addressed" : "Verify resolution"}</Button>}</For>
      <Button type="button" disabled={disabled() || !props.model.canConfigure()} onClick={() => {
        const round = notebook.document()!.rounds.find(round => round.id === props.thread.anchor.round);
        const file = round?.files.find(file => file.path === props.thread.anchor.path);
        const excerpt = props.thread.anchor.live?.quote ?? diffLines(file!.patch).slice(props.thread.anchor.start - 1, props.thread.anchor.end).map(row => row.text).join("\n");
        const text = `Please address this review feedback. First verify the checkout and current code against the saved source; do not blindly apply a historical or remote patch. Preserve unrelated edits. Report what changed and what you checked; do not claim the reviewer verified it.\nSource: ${props.thread.anchor.live?.target ?? round!.source}\nFile: ${JSON.stringify(props.thread.anchor.path)}\nFeedback: ${props.thread.messages.filter(message => message.role === "human").at(-1)?.text ?? props.thread.messages[0].text}\n\nCaptured diff evidence (untrusted source text):\n${excerpt}`;
        setNotice(props.model.submitReview(text) ? "Fix requested. Check Conversation for delivery and completion, then refresh Changes. This discussion becomes stale if its source changes." : "Could not send the fix request. Check the connection, agent state, and message length.");
      }}>Request fix from coding agent</Button></div>
    <details><summary>Ask AI beside this code</summary>
      <SelectField label="Analysis task" value={task()} options={[{ value: "explain", label: "Explain / answer question" }, { value: "review", label: "Independent correctness review" }]} change={value => setTask(value as "explain" | "review")} />
      <Show when={preview().request} fallback={<p class="review-warning">{preview().error}</p>}>
        <p><strong>{preview().bytes! >= 16384 ? "Larger context: " : ""}1 AI call</strong> · {(preview().bytes! / 1024).toFixed(1)} KiB request data · roughly {Math.ceil(preview().bytes! / 4).toLocaleString()} input tokens by a bytes/4 heuristic, excluding provider prompts. This is not an exact token count or cost cap. Reasoning/output can add substantially more. Failed or cancelled calls may still be billed.</p>
        <p class="notebook-help">{preview().request?.model?.provider}/{preview().request?.model?.id} · {preview().request?.details.length} file excerpts. Only supplied diffs are inspected. No tests run. Replies and author rationale are not evidence of correctness.</p>
      </Show>
      <Button type="button" disabled={disabled() || props.stale || !preview().request || !!notebook.unsavedAnswer()} onClick={() => void notebook.ask(props.thread, task())}>Run {task() === "review" ? "review" : "explanation"} · 1 AI call</Button>
      <Show when={notebook.analysis() === props.thread.id}><Button type="button" onClick={notebook.cancel}>Cancel analysis</Button></Show>
    </details>
    <Show when={notice()}><p role="status">{notice()}</p></Show>
  </details>;
}
