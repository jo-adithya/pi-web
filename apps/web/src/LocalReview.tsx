import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { Checkbox } from "@kobalte/core/checkbox";
import { hasPatch, reviewDraft, type ReviewScope } from "./local-review";
import { ReviewRows } from "./ReviewRows";
import { highlightDiff, type HighlightedLine } from "./review-highlight";
import type { ContextGap } from "./context-review";
import type { SessionModel } from "./session-model";
import "./local-review.css";

const scopeHelp = {
  unstaged: "Working tree edits that aren’t staged yet. Untracked files show names only.",
  staged: "Changes in the Git index, ready for the next commit.",
  branch: "Committed changes since this branch diverged from a local base. Uncommitted edits are excluded.",
  commit: "The selected commit against its first parent; root commits against an empty tree. Uncommitted edits are excluded.",
};

/** Read-only workspace snapshot browser. Ask Pi only appends to the session draft. */
export function LocalReview(props: { model: SessionModel; conversation: () => void }) {
  const review = props.model.review;
  const structural = review.structural, context = review.context;
  const [notice, setNotice] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [filesOpen, setFilesOpen] = createSignal(false);
  const [commitPicker, setCommitPicker] = createSignal<HTMLSelectElement>();
  // Reapply the pinned selection after history replaces the native select's options.
  createEffect(() => ({ element: commitPicker(), id: review.commit(), history: review.history.value() }),
    ({ element, id }) => { if (element) element.value = id; });
  let files: HTMLElement | undefined, detail: HTMLElement | undefined;
  let jumpFrame: number | undefined;
  const file = () => review.snapshot()?.files.find(file => file.path === review.selected());
  const loadedFile = () => { const selected = file(); return selected && hasPatch(selected) ? selected : undefined; };
  type Row = { kind: "line"; line: HighlightedLine } | { kind: "gap"; gap: ContextGap; header?: string };
  let previousRows = new Map<string, Row>(), previousFile = "";
  const diff = createMemo(() => {
    const selected = loadedFile(), view = selected ? context.view(selected) : { patch: "", gaps: [] };
    const highlighted = highlightDiff(selected?.path ?? "", view.patch);
    const gaps = new Map(view.gaps.map(gap => [gap.index, gap]));
    const rows: Row[] = [];
    for (let i = 0; i <= highlighted.lines.length; i++) {
      const gap = gaps.get(i), line = highlighted.lines[i];
      // The following hunk's range labels the gap; render it once beside its controls.
      if (gap) {
        const header = line?.kind === "header" && line.text.startsWith("@@") ? line.text : undefined;
        rows.push({ kind: "gap", gap, header });
        if (header) continue;
      }
      if (line) rows.push({ kind: "line", line });
    }
    const identity = JSON.stringify([selected?.path, selected?.fingerprint, review.target()]);
    if (identity !== previousFile) { previousRows.clear(); previousFile = identity; }
    const nextRows = new Map<string, Row>();
    const stable = rows.map((row, index) => {
      // Source coordinates retain mounted rows when surrounding context grows.
      const key = row.kind === "gap" ? `gap:${row.gap.id}` : JSON.stringify([row.line.kind, row.line.old, row.line.next, row.line.text, row.line.kind === "header" ? index : null]);
      const previous = previousRows.get(key);
      const value = previous && JSON.stringify(previous) === JSON.stringify(row) ? previous : row;
      nextRows.set(key, value); return value;
    });
    previousRows = nextRows;
    return { ...highlighted, rows: stable };
  });
  const structuralLines = createMemo(() => (structural.result()?.lines ?? []).map(line => line.segments.length <= 256 ? line : {
    ...line, segments: [{ text: line.segments.map(segment => segment.text).join(""), changed: false }],
  }));
  const fragmented = () => structural.result()?.lines.some(line => line.segments.length > 256);
  const counts = createMemo(() => ({ added: diff().lines.filter(line => line.kind === "add").length, removed: diff().lines.filter(line => line.kind === "remove").length }));
  const visibleFiles = createMemo(() => (review.snapshot()?.files ?? []).filter(file => file.path.toLowerCase().includes(filter().trim().toLowerCase())));
  const groups = createMemo(() => {
    const intents = review.grouping.value();
    if (review.grouping.mode() === "intent" && intents) {
      const visible = new Map(visibleFiles().map(file => [file.path, file]));
      return intents.map(group => ({ title: group.title, reason: group.reason, files: group.paths.flatMap(path => visible.has(path) ? [visible.get(path)!] : []) })).filter(group => group.files.length);
    }
    const groups = new Map<string, ReturnType<typeof visibleFiles>>();
    for (const file of visibleFiles()) {
      const directory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ".";
      if (!groups.has(directory)) groups.set(directory, []);
      groups.get(directory)!.push(file);
    }
    return [...groups].map(([directory, files]) => ({ title: directory === "." ? "Repository root" : directory, reason: "", files }));
  });
  const nextUnreviewed = createMemo(() => {
    const files = review.snapshot()?.files ?? [];
    const index = files.findIndex(file => file.path === review.selected());
    return [...files.slice(index + 1), ...files.slice(0, index)].find(file => !review.isReviewed(file));
  });
  onSettled(() => {
    void review.refresh();
    return () => {
      review.cancel();
      if (jumpFrame !== undefined) cancelAnimationFrame(jumpFrame);
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    };
  });
  const changeScope = (scope: ReviewScope) => { setNotice(""); setFilter(""); review.setScope(scope); void review.refresh(scope); };
  function selectCommit(id: string) { review.setCommit(id); setNotice(""); setFilter(""); void review.refresh("commit", id); }
  async function reloadCommits() {
    const list = await review.history.refresh();
    if (review.scope() === "commit" && !review.commit() && list?.commits[0]) selectCommit(list.commits[0].id);
  }
  /** Jump after layout settles; the document's CSS respects reduced motion. */
  function jumpTo(target: () => HTMLElement | undefined) {
    if (jumpFrame !== undefined) cancelAnimationFrame(jumpFrame);
    jumpFrame = requestAnimationFrame(() => {
      jumpFrame = undefined; const element = target();
      element?.focus({ preventScroll: true }); element?.scrollIntoView({ block: "start", behavior: "auto" });
    });
  }
  function select(path: string) {
    review.setSelected(path); setNotice(""); setFilesOpen(false); jumpTo(() => detail);
  }
  function toggleFiles() {
    const opening = !filesOpen(); setFilesOpen(opening); jumpTo(() => opening ? files : detail);
  }
  function compareStructure() {
    const selected = loadedFile(), target = review.target();
    if (selected && target && !review.busy()) void structural.show({ ...target, path: selected.path, fingerprint: selected.fingerprint });
  }
  function expandContext(id: number, direction: "above" | "below") {
    const selected = loadedFile(), target = review.target();
    if (selected && target && !review.busy()) void context.expand(selected, target, id, direction);
  }
  function ask() {
    const selected = loadedFile(), target = review.target();
    if (!selected || !target) return;
    try { props.model.setDraft(reviewDraft(props.model.draft(), selected, target)); props.conversation(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not add review context."); }
  }
  return <section class="local-review" aria-label="Local changes" aria-busy={review.busy() ? "true" : "false"}>
    <form class="review-toolbar" onSubmit={event => { event.preventDefault(); setNotice(""); void review.refresh(); }}>
      <div class="review-scopes" role="group" aria-label="Change scope">
        <For each={[["unstaged", "Unstaged"], ["staged", "Staged"], ["branch", "Branch"], ["commit", "Commit"]] as const}>{([scope, label]) =>
          <button type="button" aria-pressed={review.scope() === scope ? "true" : "false"} title={scopeHelp[scope]} onClick={() => changeScope(scope)}>{label}</button>
        }</For>
      </div>
      <Show when={review.scope() === "branch"}><label class="review-base">Compare against<input value={review.base()} onInput={event => review.setBase(event.currentTarget.value)} placeholder="Local branch or tag, e.g. main" maxlength={256} /></label></Show>
      <Show when={review.scope() === "commit"}>
        <label class="review-commit">Commit<select ref={setCommitPicker} disabled={review.history.busy()} onChange={event => selectCommit(event.currentTarget.value)}>
          <Show when={!review.commit()}><option value="" disabled>{review.history.busy() ? "Loading commits…" : "Choose a commit"}</option></Show>
          <Show when={review.commit() && !review.history.value()?.commits.some(commit => commit.id === review.commit())}><option value={review.commit()}>{review.commit().slice(0, 10)} — Selected commit</option></Show>
          <For each={review.history.value()?.commits ?? []}>{commit => <option value={commit.id}>{commit.id.slice(0, 10)} — {commit.subject || "(no subject)"}</option>}</For>
        </select></label>
        <button type="button" disabled={review.busy() || review.history.busy()} onClick={() => void reloadCommits()}>Reload commits</button>
      </Show>
      <button class="review-refresh" type="submit" disabled={review.busy()}>{review.busy() ? "Loading…" : review.scope() === "branch" ? "Compare" : "Refresh"}</button>
      <Show when={review.snapshot()?.files.length}><button class="review-files-toggle" type="button" aria-expanded={filesOpen() ? "true" : "false"} aria-controls={`review-files-${props.model.id}`} onClick={toggleFiles}>Files ({review.snapshot()!.files.length})</button></Show>
      <span class="review-readonly">Read-only</span>
    </form>
    <p class="review-help">{scopeHelp[review.scope()]} <span>{review.scope() === "commit" ? "Reload commits after new commits." : "Refresh after edits."}</span></p>
    <Show when={review.scope() === "commit"}>
      <Show when={review.history.error()}><p class="review-warning" role="alert">{review.history.error()}</p></Show>
      <Show when={review.history.value()?.truncated}><p class="review-help">Showing the 100 most recent commits reachable from local HEAD.</p></Show>
      <Show when={review.history.value()?.commits.length === 0 && !review.history.busy()}><p class="review-empty" role="status">No commits in local HEAD history. Reload commits after creating a commit.</p></Show>
    </Show>
    <Show when={review.error()}><p class="review-warning" role="alert">{review.error()}<Show when={review.snapshot()}> Showing the previous snapshot.</Show></p></Show>
    <Show when={notice()}><p class="review-warning" role="alert">{notice()}</p></Show>
    <Show when={review.grouping.error()}><p class="review-warning" role="alert">{review.grouping.error()} Folder grouping remains available.</p></Show>
    <Show when={review.busy() && !review.snapshot()}><p class="review-empty" role="status">Loading local changes…</p></Show>
    <Show when={review.snapshot()}>{snapshot => <>
      <div class="review-summary" role="status">
        <span>{snapshot().files.filter(review.isReviewed).length} / {snapshot().files.length} files reviewed</span>
        <span>Snapshot: {review.target()?.scope}{review.target()?.commit ? ` ${review.target()?.commit?.slice(0, 10)} · first parent` : review.target()?.base ? ` against ${review.target()?.base}` : ""}</span>
      </div>
      <Show when={snapshot().truncated}><p class="review-warning">{snapshot().note ?? "Some changes were omitted by review limits."}</p></Show>
      <Show when={snapshot().files.length} fallback={<p class="review-empty">No changes in this scope. Choose another scope or refresh after editing.</p>}>
        <div class="review-layout">
          <nav ref={files} id={`review-files-${props.model.id}`} class={`review-files${filesOpen() ? "" : " review-files-collapsed"}`} tabindex={-1} aria-label="Changed files">
            <div class="review-filter"><input type="search" aria-label="Filter files" placeholder="Filter files…" value={filter()} onInput={event => setFilter(event.currentTarget.value)} /><Show when={filter()}><button type="button" onClick={() => setFilter("")} aria-label="Clear filter">×</button></Show></div>
            <div class="review-group-controls">
              <button type="button" disabled={review.busy() || review.grouping.busy()} title="Send file names and bounded diff snippets to your current Pi model in a separate tool-disabled session. Provider charges may apply." onClick={() => void review.groupWithAI()}>{review.grouping.busy() ? "Grouping…" : review.grouping.value() ? "Regroup with AI" : "Group with AI"}</button>
              <Show when={review.grouping.busy()}><button type="button" onClick={review.grouping.cancel}>Cancel grouping</button></Show>
              <Show when={review.grouping.value()}><div class="review-engines" role="group" aria-label="File grouping">
                <button type="button" aria-pressed={review.grouping.mode() === "folders" ? "true" : "false"} onClick={() => review.grouping.setMode("folders")}>Folders</button>
                <button type="button" aria-pressed={review.grouping.mode() === "intent" ? "true" : "false"} onClick={() => review.grouping.setMode("intent")}>AI intent</button>
              </div></Show>
            </div>
            <p class="review-group-note">{review.grouping.notice() || "Optional: sends names and diff snippets to your current Pi model. Provider charges may apply."}</p>
            <Show when={visibleFiles().length} fallback={<p class="review-filter-empty">No files match your filter.</p>}>
              <For each={groups()}>{group => <section>
                <h3>{group.title}</h3>
                <Show when={group.reason}><p class="review-group-reason">{group.reason}</p></Show>
                <For each={group.files}>{item => <button type="button" aria-label={`${item.path} — ${item.status}${review.isReviewed(item) ? " — reviewed" : ""}`} aria-pressed={review.selected() === item.path ? "true" : "false"} onClick={() => select(item.path)} title={item.path}>
                  <span class={`review-file-status status-${item.status}`} aria-hidden="true">{review.isReviewed(item) ? "✓" : item.status === "untracked" ? "?" : item.status[0].toUpperCase()}</span>
                  <span class="review-file-name">{review.grouping.mode() === "intent" ? item.path : item.path.slice(item.path.lastIndexOf("/") + 1)}</span>
                </button>}</For>
              </section>}</For>
            </Show>
          </nav>
          <Show when={file()}>{selected => <article ref={detail} class="review-detail" tabindex={-1} aria-label={`Diff for ${selected().path}`}>
            <header class="review-file-header">
              <div class="review-file-title"><h2>{selected().path}</h2><Show when={selected().previousPath}><p>Renamed from {selected().previousPath}</p></Show>
                <div class="review-file-meta"><span>{selected().status}</span><span title="Syntax colors use available hunk context">{diff().label}</span><Show when={counts().added || counts().removed}><span class="review-added" aria-label={`${counts().added} added lines`}>+{counts().added}</span><span class="review-removed" aria-label={`${counts().removed} removed lines`}>−{counts().removed}</span></Show></div>
              </div>
              <div class="review-file-actions">
                <div class="review-engines" role="group" aria-label="Diff mode">
                  <button type="button" aria-pressed={structural.mode() === "text" ? "true" : "false"} onClick={structural.reset}>Text</button>
                  <button type="button" aria-pressed={structural.mode() === "structural" ? "true" : "false"} disabled={!loadedFile() || review.busy() || structural.busy()} title="Compare syntax for this file on demand. Requires Difftastic 0.72.0." onClick={compareStructure}>Structural</button>
                </div>
                <Checkbox disabled={!loadedFile() || review.busy()} class="review-reviewed" title="Kept for this page session; resets when the patch changes" checked={review.isReviewed(selected())} onChange={checked => review.mark(selected(), checked)}>
                  <Checkbox.Input /><Checkbox.Control class="checkbox-control"><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control><Checkbox.Label>Reviewed</Checkbox.Label>
                </Checkbox>
                <button type="button" disabled={!nextUnreviewed()} onClick={() => { const next = nextUnreviewed(); if (next) { setFilter(""); select(next.path); } }}>Next unreviewed</button>
                <button class="review-ask" type="button" disabled={!loadedFile() || review.busy()} title="Add this diff to your draft. Nothing is sent automatically." onClick={ask}>Ask Pi</button>
              </div>
            </header>
            <Show when={review.patchBusy()}><p class="review-empty" role="status">Loading patch…</p></Show>
            <Show when={review.patchError()}><p class="review-warning" role="alert">{review.patchError()} <button type="button" onClick={() => void review.loadPatch()}>Retry patch</button></p></Show>
            <Show when={loadedFile()}>
            <Show when={structural.busy()}><p class="review-structural-note" role="status">Comparing syntax… Text diff remains available.</p></Show>
            <Show when={structural.reason()}><p class="review-warning" role="status">{structural.reason()} Showing text diff.</p></Show>
            <Show when={!structural.result() && context.error()}><p class="review-warning" role="alert">{context.error()}</p></Show>
            <Show when={structural.result()} fallback={<div class="review-diff" tabindex={0} role="region" aria-label="Unified diff" aria-busy={context.busy() ? "true" : "false"}>
              <ReviewRows rows={diff().rows} identity={`${review.target()?.scope}:${selected().path}:${selected().fingerprint}`} jump={() => jumpTo(() => detail)}>{row => row.kind === "gap" ? <div class="diff-line diff-hunk review-context">
                <div class="review-context-gutter">
                  <For each={(["below", "above"] as const).filter(direction => row.gap[direction])}>{direction => <button type="button" class={`review-expand review-expand-${direction}`} aria-label={`Expand ${Math.min(20, row.gap.remaining ?? 20)} lines ${direction}`} title={`Expand ${Math.min(20, row.gap.remaining ?? 20)} lines ${direction}`} disabled={context.busy() || review.busy()} onClick={() => expandContext(row.gap.id, direction)}>
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 2h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray=".1 3" /><path d="M7 5h2v5h3l-4 4-4-4h3z" fill="currentColor" /></svg>
                  </button>}</For>
                </div>
                <Show when={row.header} fallback={<span class="review-context-label">More context</span>}>{header => <code>{header()}</code>}</Show>
              </div> : <div class={`diff-line diff-${row.line.kind}${row.line.kind === "header" && row.line.text.startsWith("@@") ? " diff-hunk" : ""}`}><span class="diff-number" aria-hidden="true">{row.line.old ?? ""}</span><span class="diff-number" aria-hidden="true">{row.line.next ?? ""}</span><code><Show when={row.line.tokens} fallback={(row.line.kind === "header" ? row.line.text : row.line.text.slice(1)) || " "}>{tokens => <For each={tokens()} fallback={" "}>{token => <span class={token.className}>{token.text}</span>}</For>}</Show></code></div>}</ReviewRows>
            </div>}>{comparison => <>
              <p class="review-structural-note">{comparison().engine} · {comparison().language} · Changed syntax is emphasized. Text mode includes formatting changes.</p>
              <Show when={fragmented()}><p class="review-structural-note">Very fragmented lines are shown without syntax emphasis to keep rendering responsive.</p></Show>
              <div class="review-diff" tabindex={0} role="region" aria-label="Structural diff">
                <Show when={comparison().lines.length} fallback={<p class="review-empty">No structural changes detected. Check Text mode for formatting or metadata changes.</p>}>
                  <ReviewRows rows={structuralLines()} weight={line => line.segments.length + 3} identity={`${review.target()?.scope}:${selected().path}:${selected().fingerprint}:structural`} jump={() => jumpTo(() => detail)}>{line => <div class={`diff-line diff-${line.kind}`}><span class="diff-number" aria-hidden="true">{line.old ?? ""}</span><span class="diff-number" aria-hidden="true">{line.next ?? ""}</span><code><For each={line.segments}>{segment => <span class={segment.changed ? "structural-change" : undefined}>{segment.text}</span>}</For></code></div>}</ReviewRows>
                </Show>
              </div>
            </>}</Show>
            </Show>
          </article>}</Show>
        </div>
      </Show>
    </>}</Show>
  </section>;
}
